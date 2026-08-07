// src/shared/state/run-agent/registry-refresh.ts
// Cursor transcript-cache refresh and the replaced-marker family.

import type { RunAgentEntry } from './registry';
import { obj, type Rec } from '../../obj';
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
import { withRunAgentClaimsLockResult } from './claims-store';
import { releaseRetiredRunAgentUnlocked } from './retire-release';
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
/**
 * Retirement, as ONE transaction over the three stores that record an agent.
 *
 * `replaced = true` on its own retires a row in the reuse registry and nothing
 * else, while the agent it names keeps its identity claim, its per-file
 * fallback locks and its unconsumed spawn handoff — all on a 30-minute clock,
 * against a row that dies in 270 seconds (see retire-release.ts). So the marker
 * and the release are one operation here, in the canonical lock order
 * rebind-journal.ts sets out for multi-store mutations (identity claims -> role
 * registry -> fallback path claims). Taking the registry lock first and the
 * claims lock inside it would be the reverse of every other such mutation, and
 * two processes doing both orders is the deadlock that ordering exists to
 * prevent.
 *
 * Still ADVISORY overall (mutation-result.ts's split rule): the caller is about
 * to spawn a replacement either way. `unavailable` now also means the release
 * half did not happen, and retrying it is what completes the transaction.
 */
type RetirementVerdict = MutationResult<void> | 'retire' | 'release-only';

function retireRunAgentRow(
  cwd: string,
  runId: string,
  role: string,
  reason: string,
  cas: (entry: Rec) => RetirementVerdict,
): MutationResult<void> {
  let reachedRegistry = false;
  const outcome = withRunAgentClaimsLockResult<void>(cwd, runId, () => {
    reachedRegistry = true;
    return withAgentRegistryLockResult<void>(cwd, runId, () => {
      const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
      const agents = obj(registry.agents) || {};
      const entry = obj(agents[role]);
      if (!entry) return preconditionFailed<void>('no-registry-row');
      const verdict = cas(entry);
      if (verdict !== 'retire' && verdict !== 'release-only') return verdict;
      if (verdict === 'retire') {
        entry.replaced = true;
        entry.replacedAt = stateTimestamp();
        entry.replacementReason = reason;
        try {
          // `replaced = true` used to be unconditional here, so a refused registry
          // file reported a retired agent that is still live on disk.
          if (!writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents })) {
            return unavailable<void>('registry-write-refused');
          }
        } catch {
          // best-effort; existing grace/hard timers remain the deadlock backstop
          return unavailable<void>('registry-write-failed');
        }
      }
      const released = releaseRetiredRunAgentUnlocked(cwd, runId, role, entry, reason);
      if (released.outcome !== 'applied') return released;
      // The release half is all a `release-only` pass owed; the CAS's verdict on
      // the row is still the answer to what the caller asked.
      return verdict === 'release-only' ? preconditionFailed<void>('already-replaced') : applied(undefined);
    });
  });
  // Which lock was lost has to be legible, and both wrappers answer
  // `lock-unavailable`. The registry half keeps that reason (it is the one the
  // lock contract test names); the claims half is renamed by the only fact that
  // separates them — whether the inner block ran at all.
  if (!reachedRegistry && outcome.outcome === 'unavailable') {
    return unavailable<void>('claims-lock-unavailable');
  }
  return outcome;
}

// Fix #9 of the eleven — the lock result was discarded, so `void` covered a
// marker that was never written.
export function markRunAgentReplacedResult(cwd: string, runId: string, role: string): MutationResult<void> {
  if (isNonProjectRoot(cwd)) return preconditionFailed('authoring-root');
  return retireRunAgentRow(cwd, runId, role, 'explicit-replace-agent-marker', () => 'retire');
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
  return retireRunAgentRow(cwd, runId, role, 'correlated-cursor-transcript-failure', (entry) => {
    // The id CAS runs BEFORE the already-replaced check, which is the order the
    // transaction needs: an earlier attempt at THIS retirement can have
    // persisted `replaced` and then lost the release half to a refused write,
    // and a retry that stopped at `already-replaced` would leave the ghost
    // holding its locks for the full 30 minutes. Answering the ownership
    // question first lets the retry finish its own half, while a row retired
    // for a DIFFERENT agent is refused as before — and now says which way it is
    // not ours.
    if (!idsForRunAgent(entry).includes(expectedId)) return preconditionFailed<void>('expected-id-mismatch');
    return entry.replaced === true ? 'release-only' : 'retire';
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
