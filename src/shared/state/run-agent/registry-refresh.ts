// src/shared/state/run-agent/registry-refresh.ts
// Cursor transcript-cache refresh and the replaced-marker family.

import type { RunAgentEntry } from './registry';
import { obj } from '../../obj';
import { isNonProjectRoot } from '../../authoring-root';
import {  readJson,  writeJson } from '../../fsjson';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  CURSOR_TRANSCRIPT_EARLY_TOLERANCE_MS,
  finiteMs,
  readCursorSpawnObservationStore,
  withCursorSpawnObservationLock,
} from './cursor-observations';
import {
  latestCursorObservation,
} from './cursor-followups';
import {
  candidateThreadId,
  cursorSubagentTranscriptsForRole,
  cursorTranscriptCandidateTimeMs,
} from './cursor-transcripts';
import {
  claimThreadRole,
} from './claim-thread-role';
import { agentRegistryFile, continuationAgentId, idsForRunAgent, readRunAgentRegistry, recordRunAgentUnlocked, withAgentRegistryLockResult } from './registry';
import {
  applied,
  mutationApplied,
  preconditionFailed,
  unavailable,
  type MutationResult,
} from './mutation-result';

export function refreshCursorRunAgentFromTranscriptCache(
  cwd: string,
  state: unknown,
  rawInput: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
): RunAgentEntry | null {
  if (!runId || !VALID_AGENT_ROLES.has(role) || isNonProjectRoot(cwd)) return null;
  const expected = readRunAgentRegistry(cwd, runId)[role];
  if (!expected || expected.replaced) return null;
  if (expected.parentSessionId && parentSessionId
    && expected.parentSessionId !== parentSessionId) return null;
  const boundParentSessionId = expected.parentSessionId || parentSessionId;
  if (!boundParentSessionId) return null;
  if (continuationAgentId(expected, 'cursor')) return expected;

  const expectedIds = new Set(idsForRunAgent(expected));
  const candidates = cursorSubagentTranscriptsForRole(cwd, rawInput, role, boundParentSessionId);
  let registryUnavailable = false;
  for (const candidate of candidates) {
    const childId = candidateThreadId(candidate);
    if (!childId) continue;
    const candidateParentId = candidate.parentSessionId || boundParentSessionId;

    // Hold the observation lock while validating transcript ownership and
    // conditionally upgrading agents.json. A concurrent transcript claim cannot
    // turn an apparently-unclaimed old child into another spawn's result between
    // those two operations, and the registry identity CAS prevents a late cache
    // scan from overwriting a newer tool_* start for the same role.
    const upgraded = withCursorSpawnObservationLock(cwd, runId, () => {
      const store = readCursorSpawnObservationStore(cwd, runId);
      const currentObservation = latestCursorObservation(store.observations, (observation) => (
        observation.parentSessionId === boundParentSessionId
        && observation.role === role
        && (expectedIds.has(observation.toolCallId)
          || Boolean(observation.childTranscriptId && expectedIds.has(observation.childTranscriptId)))
      ));
      const claimedObservation = store.observations.find((observation) => (
        observation.childTranscriptId === childId
      ));
      if (claimedObservation) {
        const belongsToCurrent = currentObservation
          ? claimedObservation.toolCallId === currentObservation.toolCallId
          : (expectedIds.has(claimedObservation.toolCallId)
            || Boolean(claimedObservation.childTranscriptId
              && expectedIds.has(claimedObservation.childTranscriptId)));
        if (!belongsToCurrent) return null;
      } else {
        const currentStartedAtMs = currentObservation?.startedAtMs || finiteMs(expected.recordedAt);
        const candidateStartedAtMs = cursorTranscriptCandidateTimeMs(candidate);
        if (!currentStartedAtMs
          || candidateStartedAtMs < currentStartedAtMs - CURSOR_TRANSCRIPT_EARLY_TOLERANCE_MS) return null;
      }

      // Fix #8 of the eleven, and the fourth ADVISORY mutation the plan names
      // ("the Cursor cache upgrade"). The inner lock result was discarded; the
      // upgrade is inferred instead from a re-READ of the row, which is the
      // stronger check and the reason losing this lock is survivable — a failed
      // upgrade returns null, the caller moves to the next transcript candidate,
      // and the duplicate-spawn gate's own remedy still applies.
      let result: RunAgentEntry | null = null;
      const upgradeOutcome = withAgentRegistryLockResult<void>(cwd, runId, () => {
        const latest = readRunAgentRegistry(cwd, runId)[role];
        if (!latest || latest.replaced) return preconditionFailed('row-absent-or-replaced');
        const sameExpectedStart = latest.agentId === expected.agentId
          && (latest.resumeId || null) === (expected.resumeId || null)
          && (latest.toolCallId || null) === (expected.toolCallId || null)
          && (latest.parentSessionId || null) === (expected.parentSessionId || null);
        if (!sameExpectedStart) {
          if ((latest.toolCallId || null) === (expected.toolCallId || null)
            && continuationAgentId(latest, 'cursor') === childId) result = latest;
          return preconditionFailed('registry-row-moved-on');
        }
        const recorded = recordRunAgentUnlocked(cwd, runId, role, {
          agentId: childId,
          resumeId: childId,
          parentSessionId: candidateParentId,
        });
        const next = readRunAgentRegistry(cwd, runId)[role];
        if (next && (next.toolCallId || null) === (expected.toolCallId || null)
          && continuationAgentId(next, 'cursor') === childId) result = next;
        return recorded;
      });
      if (upgradeOutcome.outcome === 'unavailable') registryUnavailable = true;
      return result;
    });
    // An `unavailable` upgrade must not be mistaken for "this candidate is not
    // the child". Both used to be one `null`, and this loop CONTINUES on null —
    // but `sameExpectedStart` compares the REGISTRY row against `expected` and
    // never looks at the candidate, so the next candidate faces the identical
    // test and binds ITS thread id on evidence that belonged to this one. Aborting
    // the scan leaves the role un-upgraded, which is the outcome a caller already
    // handles.
    if (registryUnavailable) return null;
    if (!upgraded) continue;
    claimThreadRole(cwd, state, childId, role, { parentSessionId: candidateParentId });
    return upgraded;
  }
  return null;
}
// ADVISORY (mutation-result.ts's split rule), and named as such by the plan.
// Retiring a registry row is a liveness HINT: the caller is about to spawn a
// replacement for the role either way, and the cost of a lost marker is that the
// dead row lingers until the grace/hard timers that already exist as the
// deadlock backstop retire it. Fix #9 of the eleven — the lock result was
// discarded, so `void` covered a marker that was never written.
export function markRunAgentReplacedResult(cwd: string, runId: string, role: string): MutationResult<void> {
  if (isNonProjectRoot(cwd)) return preconditionFailed('authoring-root');
  return withAgentRegistryLockResult<void>(cwd, runId, () => markRunAgentReplacedUnlocked(cwd, runId, role));
}
export function markRunAgentReplaced(cwd: string, runId: string, role: string): void {
  markRunAgentReplacedResult(cwd, runId, role);
}
// Fix #10 of the eleven, the CAS sibling of the above: same advisory status, and
// `replaced` already distinguished "the id did not match" from "it did" — but a
// contended lock reported the same `false` as a mismatch, so a caller could not
// tell "this row is not yours" from "ask me again".
export function markRunAgentReplacedIfMatchesResult(
  cwd: string,
  runId: string,
  role: string,
  expectedId: string,
): MutationResult<void> {
  if (!expectedId || isNonProjectRoot(cwd)) return preconditionFailed('no-expected-id');
  return withAgentRegistryLockResult<void>(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const entry = obj(agents[role]);
    if (!entry) return preconditionFailed('no-registry-row');
    if (entry.replaced === true) return preconditionFailed('already-replaced');
    if (!idsForRunAgent(entry).includes(expectedId)) return preconditionFailed('expected-id-mismatch');
    entry.replaced = true;
    entry.replacedAt = stateTimestamp();
    entry.replacementReason = 'correlated-cursor-transcript-failure';
    try {
      // `replaced = true` used to be unconditional here, so a refused registry
      // file reported a retired agent that is still live on disk.
      if (!writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents })) {
        return unavailable('registry-write-refused');
      }
      return applied(undefined);
    } catch {
      // best-effort; existing grace/hard timers remain the deadlock backstop
      return unavailable('registry-write-failed');
    }
  });
}
export function markRunAgentReplacedIfMatches(
  cwd: string,
  runId: string,
  role: string,
  expectedId: string,
): boolean {
  return mutationApplied(markRunAgentReplacedIfMatchesResult(cwd, runId, role, expectedId));
}
function markRunAgentReplacedUnlocked(cwd: string, runId: string, role: string): MutationResult<void> {
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
  const agents = obj(registry.agents) || {};
  const entry = obj(agents[role]);
  if (!entry) return preconditionFailed('no-registry-row');
  entry.replaced = true;
  entry.replacedAt = stateTimestamp();
  entry.replacementReason = 'explicit-replace-agent-marker';
  try {
    if (!writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents })) {
      return unavailable('registry-write-refused');
    }
    return applied(undefined);
  } catch {
    // best-effort
    return unavailable('registry-write-failed');
  }
}
