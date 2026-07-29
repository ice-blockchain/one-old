// src/modules/agent-model/cursor-failure-select.ts
// Parent-role failure selection and pending-followup claiming.

import {
  claimCursorFollowupsBatch,
  claimCursorSpawnObservation,
  consumeCursorSpawnObservation,
  cursorParentObservationSnapshot,
  inferRoleFromTranscript,
  isResumeCapableAgentId,
  listCursorSpawnObservations,
  normalizeHostCallId,
  listCursorSubagentTranscriptCandidates,
  markCursorSpawnObservationRetryHandled,
  markRunAgentReplacedIfMatches,
  readEffectiveState,
  readRunAgentRegistry,
  refreshCursorRunAgentFromTranscriptCache,
  suppressCursorFollowupsBatch,
  type CursorFollowupClaimRequest,
  type CursorFollowupSuppressionReason,
  type CursorSpawnObservation,
  type CursorTranscriptCandidate,
  type RunAgentEntry,
  updateCursorSpawnObservation,
} from '../../shared/state';
import {
  exhaustedModelsForRole,
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  modelIsExhausted,
  recordExhaustedModel,
} from './exhausted-models';
import {
  markModelChoicePrompted,
  modelChoicePrompted,
  readModelChoice,
} from './model-choice';
import { cursorAgentPresumedDead } from './cursor-liveness';

import {
  compatibleObservation,
  parseCursorTranscript,
} from './cursor-transcript';
import {
  resolutionFor,
} from './cursor-failure-resolution';

export function compareCursorStart(
  left: Pick<CursorSpawnObservation, 'startedAtMs' | 'toolCallId'>,
  right: Pick<CursorSpawnObservation, 'startedAtMs' | 'toolCallId'>,
): number {
  return left.startedAtMs - right.startedAtMs || left.toolCallId.localeCompare(right.toolCallId);
}

function matchingRegistryEntry(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): RunAgentEntry | null {
  const entry = readRunAgentRegistry(cwd, runId)[observation.role];
  if (!entry || entry.replaced) return null;
  if (entry.parentSessionId && entry.parentSessionId !== observation.parentSessionId) return null;
  const observationIds = new Set([
    observation.toolCallId,
    observation.childTranscriptId || '',
  ].filter(Boolean));
  return [entry.agentId, entry.resumeId, entry.toolCallId]
    .some((value) => typeof value === 'string' && observationIds.has(value))
    ? entry
    : null;
}

interface CursorFailureSelectionOptions {
  state: unknown;
  raw: unknown;
  nowMs?: number;
  corroborated?: boolean;
  /** Settle inspects only starts strictly older than the start being recorded. */
  before?: Pick<CursorSpawnObservation, 'startedAtMs' | 'toolCallId'>;
}

interface CursorFailureSelection {
  head: CursorSpawnObservation;
  latest: CursorSpawnObservation;
}

function resumeCandidateForUnterminatedStart(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  raw: unknown,
): CursorTranscriptCandidate | null {
  const observations = listCursorSpawnObservations(cwd, runId);
  const candidates = listCursorSubagentTranscriptCandidates(
    cwd,
    raw,
    observation.parentSessionId,
  )
    .filter((candidate) => inferRoleFromTranscript(candidate.filePath) === observation.role)
    .filter((candidate) => isResumeCapableAgentId(candidate.childTranscriptId))
    .sort((left, right) => {
      const leftAt = Number.isFinite(left.birthtimeMs) && left.birthtimeMs > 0
        ? left.birthtimeMs
        : left.mtimeMs;
      const rightAt = Number.isFinite(right.birthtimeMs) && right.birthtimeMs > 0
        ? right.birthtimeMs
        : right.mtimeMs;
      return rightAt - leftAt || right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath);
    });
  const newest = candidates[0];
  if (!newest) return null;
  const parsed = parseCursorTranscript(newest);
  if (!parsed || !compatibleObservation(observation, parsed)) return null;
  const owner = observations.find((item) => item.childTranscriptId === newest.childTranscriptId);
  return owner && owner.toolCallId !== observation.toolCallId ? null : newest;
}

// A newer, unterminated SubagentStart is a possible live retry and therefore
// masks the older finalized failure. Refresh the transcript-derived resume UUID
// before applying the shared 90/270-second policy. Expiry only retires the exact
// registry entry for this start; it never classifies or exhausts its model.
function unterminatedStartStillMasks(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  options: CursorFailureSelectionOptions,
): boolean {
  // The generic role refresh always takes the newest role-bearing transcript.
  // Verify that transcript is compatible with this immutable start first, or an
  // older finalized child's UUID could be attached to a later tool_<id> and keep
  // the retry falsely live forever.
  if (resumeCandidateForUnterminatedStart(cwd, runId, observation, options.raw)) {
    refreshCursorRunAgentFromTranscriptCache(
      cwd,
      options.state,
      options.raw,
      runId,
      observation.role,
      observation.parentSessionId,
    );
  }
  const exactLive = matchingRegistryEntry(cwd, runId, observation);

  const corroborated = options.corroborated === true
    || observation.outcome !== null
    || modelIsExhausted(cwd, runId, observation.role, observation.requestedModel);
  if (!cursorAgentPresumedDead(exactLive, {
    corroborated,
    startedAtMs: observation.startedAtMs,
    nowMs: options.nowMs,
  })) return true;

  markRunAgentReplacedIfMatches(cwd, runId, observation.role, observation.toolCallId);
  return false;
}

// Stable selector for one parent+role stream. The newest consumed row is the
// permanent finalized head, even when already handled/suppressed or successful;
// older failures must never resurface. Starts after that head mask it while they
// may still be live. Selection and CAS fingerprints use only immutable start
// fields, never updatedAt (which follow-up/choice refreshes legitimately change).
export function selectCursorFailureForParentRole(
  cwd: string,
  runId: string,
  parentSessionId: string,
  role: string,
  options: CursorFailureSelectionOptions,
): CursorFailureSelection | null {
  const observations = listCursorSpawnObservations(cwd, runId)
    .filter((observation) => observation.parentSessionId === parentSessionId && observation.role === role)
    .filter((observation) => !options.before || compareCursorStart(observation, options.before) < 0)
    .sort(compareCursorStart);
  const latest = observations.at(-1);
  if (!latest) return null;
  const finalized = observations.filter((observation) => observation.consumedAtMs !== null).at(-1);
  if (!finalized) return null;

  const laterUnterminated = observations.filter((observation) => (
    compareCursorStart(observation, finalized) > 0 && observation.consumedAtMs === null
  ));
  for (const blocker of laterUnterminated) {
    if (unterminatedStartStillMasks(cwd, runId, blocker, options)) return null;
  }
  return { head: finalized, latest };
}

export function uniqueParentForRole(cwd: string, runId: string, role: string): string | null {
  const parents = new Set(listCursorSpawnObservations(cwd, runId)
    .filter((observation) => observation.role === role)
    .map((observation) => observation.parentSessionId));
  return parents.size === 1 ? [...parents][0]! : null;
}

export function refreshPendingResolution(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): CursorSpawnObservation {
  if (!observation.outcome || !observation.childTranscriptId) return observation;
  const resolution = resolutionFor(cwd, runId, observation, observation.outcome);
  if (resolution.choicePrompted) markModelChoicePrompted(cwd, runId);
  if (resolution.terminal && !modelExhaustionTerminalForRole(cwd, runId, observation.role)) {
    markModelExhaustionTerminal(cwd, runId, observation.role);
  }
  if (observation.directive === resolution.directive
    && observation.prescribedModel === resolution.prescribedModel) return observation;
  return updateCursorSpawnObservation(cwd, runId, observation.childTranscriptId, {
    directive: resolution.directive,
    prescribedModel: resolution.prescribedModel,
  }) || observation;
}

export function claimCursorParentPendingFollowups(
  cwd: string,
  runId: string,
  state: unknown,
  raw: unknown,
  parentSessionId: string,
  observedAtMs: number,
): CursorSpawnObservation[] {
  // Transcript/liveness and resolution refreshes happen outside the state
  // lock. Converge on one stable parent snapshot: this includes every role and
  // every terminal/action transition, so a role finalized concurrently cannot
  // be omitted into a second follow-up. The state CAS recomputes the same full
  // fingerprint under lock and rejects any later transition atomically.
  let snapshot = cursorParentObservationSnapshot(cwd, runId, parentSessionId);
  let requests: CursorFollowupClaimRequest[] = [];
  for (let pass = 0; snapshot && pass < 3; pass += 1) {
    const roles = [...new Set(snapshot.observations.map((observation) => observation.role))].sort();
    const prepared: Omit<CursorFollowupClaimRequest, 'expectedParentFingerprint'>[] = [];
    for (const role of roles) {
      const selected = selectCursorFailureForParentRole(
        cwd,
        runId,
        parentSessionId,
        role,
        { state, raw, nowMs: observedAtMs },
      );
      if (!selected) continue;
      const head = refreshPendingResolution(cwd, runId, selected.head);
      if (!head.outcome || !head.childTranscriptId || !head.directive
        || head.retryHandled || head.followupEmitted || head.followupSuppressed) continue;
      prepared.push({
        parentSessionId,
        role,
        childTranscriptId: head.childTranscriptId,
        toolCallId: head.toolCallId,
        expectedLatestToolCallId: selected.latest.toolCallId,
        expectedLatestStartedAtMs: selected.latest.startedAtMs,
        directive: head.directive,
        prescribedModel: head.prescribedModel,
      });
    }
    const after = cursorParentObservationSnapshot(cwd, runId, parentSessionId);
    if (!after) return [];
    if (after.fingerprint !== snapshot.fingerprint) {
      snapshot = after;
      continue;
    }
    requests = prepared.map((request) => ({
      ...request,
      expectedParentFingerprint: snapshot!.fingerprint,
    }));
    break;
  }
  return requests.length
    ? claimCursorFollowupsBatch(cwd, runId, requests, observedAtMs)
    : [];
}
