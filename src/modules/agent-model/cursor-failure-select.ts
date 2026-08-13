// src/modules/agent-model/cursor-failure-select.ts
// Parent-role failure selection and pending-followup claiming.

import {
  claimCursorFollowupsBatch,
  cursorParentObservationSnapshot,
  inferRoleFromTranscript,
  isResumeCapableAgentId,
  listCursorSpawnObservations,
  listCursorSubagentTranscriptCandidates,
  markRunAgentReplacedIfMatches,
  readRunAgentRegistry,
  refreshCursorRunAgentFromTranscriptCache,
  type CursorFollowupClaimRequest,
  type CursorSpawnObservation,
  type CursorTranscriptCandidate,
  type RunAgentEntry,
  updateCursorSpawnObservation,
} from '../../shared/state';
import {
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  modelIsExhausted,
} from './exhausted-models';
import {
  markModelChoicePrompted,
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
  // A ROW THIS RUN DID NOT OBSERVE. `traffic-one-reset` copies the spawn
  // observations onto the successor so a child transcript stays correlatable
  // and the retired run's prescription ("retry role R only on model X") is not
  // refunded. Re-deriving that resolution here would re-mint its INPUTS'
  // conclusions against the successor: the carried exhaustion entries plus a
  // carried finalized failure resolve to `terminal` — the non-expiring marker
  // the obligation table withholds until WIDEN_AT resets — and to
  // `choicePrompted`, the human-reply latch the table carries only when the
  // retired run recorded no answer. Measured at zero prior resets with nothing
  // widened: the bound reserved for the third reset was present after the
  // first, so the ladder was a gate on the COPY rather than on the state.
  //
  // Carrying the resolution and re-deriving it are different acts, and only the
  // first is what the reset row claims: the row keeps the directive and the
  // prescribed model it arrived with, and mints nothing. A genuinely NEW
  // failure in the successor is a new observation with no carry stamp, resolves
  // normally, and mints the terminal marker on its own merits — which is what
  // keeps this from being a way to launder the bound.
  if (observation.carriedFromRunId) return observation;
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
      // THE SPENT-FLAGS FILTER RUNS FIRST, and the order is the property. These
      // three are one-shot markers: whatever this head's resolution is, it has
      // already been emitted, handled or suppressed, so no follow-up can come
      // out of this pass. Refreshing before testing them meant a fully spent
      // head still drove `refreshPendingResolution`'s side effects — it could
      // mint a bound while the `continue` below suppressed the very question
      // that would have explained it. None of the three is written by the
      // refresh, so testing them on `selected.head` is the same answer, taken
      // before anything can be written.
      if (selected.head.retryHandled || selected.head.followupEmitted
        || selected.head.followupSuppressed) continue;
      const head = refreshPendingResolution(cwd, runId, selected.head);
      if (!head.outcome || !head.childTranscriptId || !head.directive) continue;
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
