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
import { agentRegistryFile, continuationAgentId, idsForRunAgent, readRunAgentRegistry, recordRunAgentUnlocked, withAgentRegistryLock } from './registry';

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

      let result: RunAgentEntry | null = null;
      withAgentRegistryLock(cwd, runId, () => {
        const latest = readRunAgentRegistry(cwd, runId)[role];
        if (!latest || latest.replaced) return;
        const sameExpectedStart = latest.agentId === expected.agentId
          && (latest.resumeId || null) === (expected.resumeId || null)
          && (latest.toolCallId || null) === (expected.toolCallId || null)
          && (latest.parentSessionId || null) === (expected.parentSessionId || null);
        if (!sameExpectedStart) {
          if ((latest.toolCallId || null) === (expected.toolCallId || null)
            && continuationAgentId(latest, 'cursor') === childId) result = latest;
          return;
        }
        recordRunAgentUnlocked(cwd, runId, role, {
          agentId: childId,
          resumeId: childId,
          parentSessionId: candidateParentId,
        });
        const next = readRunAgentRegistry(cwd, runId)[role];
        if (next && (next.toolCallId || null) === (expected.toolCallId || null)
          && continuationAgentId(next, 'cursor') === childId) result = next;
      });
      return result;
    });
    if (!upgraded) continue;
    claimThreadRole(cwd, state, childId, role, { parentSessionId: candidateParentId });
    return upgraded;
  }
  return null;
}
export function markRunAgentReplaced(cwd: string, runId: string, role: string): void {
  if (isNonProjectRoot(cwd)) return;
  withAgentRegistryLock(cwd, runId, () => markRunAgentReplacedUnlocked(cwd, runId, role));
}
export function markRunAgentReplacedIfMatches(
  cwd: string,
  runId: string,
  role: string,
  expectedId: string,
): boolean {
  if (!expectedId || isNonProjectRoot(cwd)) return false;
  let replaced = false;
  withAgentRegistryLock(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const entry = obj(agents[role]);
    if (!entry || entry.replaced === true || !idsForRunAgent(entry).includes(expectedId)) return;
    entry.replaced = true;
    entry.replacedAt = stateTimestamp();
    entry.replacementReason = 'correlated-cursor-transcript-failure';
    try {
      writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents });
      replaced = true;
    } catch {
      // best-effort; existing grace/hard timers remain the deadlock backstop
    }
  });
  return replaced;
}
function markRunAgentReplacedUnlocked(cwd: string, runId: string, role: string): void {
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
  const agents = obj(registry.agents) || {};
  const entry = obj(agents[role]);
  if (!entry) return;
  entry.replaced = true;
  entry.replacedAt = stateTimestamp();
  entry.replacementReason = 'explicit-replace-agent-marker';
  try {
    writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents });
  } catch {
    // best-effort
  }
}
