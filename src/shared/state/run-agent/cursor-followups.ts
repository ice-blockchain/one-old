// src/shared/state/run-agent/cursor-followups.ts
// Cursor followup claims and suppression batches.

import { isNonProjectRoot } from '../../authoring-root';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';

import {
  firstString,
} from './run-paths';
import {
  CURSOR_PARENT_FOLLOWUP_SUPPRESSION_REASONS,
  cursorParentObservationFingerprint,
  finiteMs,
  readCursorSpawnObservationStore,
  validCursorTranscriptId,
  withCursorSpawnObservationLock,
  writeCursorSpawnObservationStore,
  type CursorFollowupClaimRequest,
  type CursorFollowupSuppressionRequest,
  type CursorSpawnObservation,
} from './cursor-observations';

function cursorObservationComesAfter(
  left: CursorSpawnObservation,
  right: CursorSpawnObservation,
): boolean {
  return left.startedAtMs > right.startedAtMs
    || (left.startedAtMs === right.startedAtMs && left.toolCallId > right.toolCallId);
}

export function latestCursorObservation(
  observations: readonly CursorSpawnObservation[],
  predicate: (observation: CursorSpawnObservation) => boolean,
): CursorSpawnObservation | null {
  let latest: CursorSpawnObservation | null = null;
  for (const observation of observations) {
    if (!predicate(observation)) continue;
    if (!latest || cursorObservationComesAfter(observation, latest)) latest = observation;
  }
  return latest;
}

function validCursorFollowupClaimRequest(request: CursorFollowupClaimRequest): boolean {
  return Boolean(
    firstString(request.parentSessionId)
    && /^[a-f0-9]{64}$/.test(request.expectedParentFingerprint)
    && firstString(request.toolCallId)
    && firstString(request.expectedLatestToolCallId)
    && VALID_AGENT_ROLES.has(request.role)
    && validCursorTranscriptId(request.childTranscriptId)
    && typeof request.expectedLatestStartedAtMs === 'number'
    && Number.isFinite(request.expectedLatestStartedAtMs)
    && request.expectedLatestStartedAtMs > 0
    && typeof request.directive === 'string'
    && request.directive.length > 0
    && request.directive.length <= 8_192
    && (request.prescribedModel === null
      || (typeof request.prescribedModel === 'string' && request.prescribedModel.length <= 300)),
  );
}

/**
 * Atomically owns one complete parent lifecycle continuation batch.
 *
 * The selector refreshes directives and computes liveness outside this lock,
 * then supplies an immutable fingerprint for each role. This function performs
 * no nested state calls: one unlocked store read, validation of the entire
 * batch, and one unlocked store write. Any stale row makes the whole batch lose
 * the CAS so concurrent Stop/subagentStop hooks can never partition roles.
 */
export function claimCursorFollowupsBatch(
  cwd: string,
  runId: string,
  requests: readonly CursorFollowupClaimRequest[],
  nowMs: number = Date.now(),
): CursorSpawnObservation[] {
  if (!runId || !requests.length || isNonProjectRoot(cwd)) return [];
  if (!requests.every(validCursorFollowupClaimRequest)) return [];
  const parentSessionId = requests[0]!.parentSessionId;
  if (requests.some((request) => request.parentSessionId !== parentSessionId)) return [];
  const expectedParentFingerprint = requests[0]!.expectedParentFingerprint;
  if (requests.some((request) => request.expectedParentFingerprint !== expectedParentFingerprint)) return [];
  if (new Set(requests.map((request) => request.role)).size !== requests.length) return [];
  if (new Set(requests.map((request) => request.childTranscriptId)).size !== requests.length) return [];
  const claimedAtMs = finiteMs(nowMs) || Date.now();

  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    if (cursorParentObservationFingerprint(store.observations, parentSessionId)
      !== expectedParentFingerprint) return [];
    const claimed: CursorSpawnObservation[] = [];

    for (const request of requests) {
      const target = store.observations.find((observation) => (
        observation.parentSessionId === request.parentSessionId
        && observation.role === request.role
        && observation.toolCallId === request.toolCallId
        && observation.childTranscriptId === request.childTranscriptId
      ));
      if (!target || !target.outcome || !target.consumedAtMs || !target.directive
        || target.retryHandled || target.followupEmitted || target.followupSuppressed
        || target.directive !== request.directive
        || target.prescribedModel !== request.prescribedModel) return [];

      const latestFinalized = latestCursorObservation(store.observations, (observation) => (
        observation.parentSessionId === request.parentSessionId
        && observation.role === request.role
        && observation.consumedAtMs !== null
      ));
      if (!latestFinalized || latestFinalized.toolCallId !== target.toolCallId
        || latestFinalized.childTranscriptId !== target.childTranscriptId) return [];

      const latest = latestCursorObservation(store.observations, (observation) => (
        observation.parentSessionId === request.parentSessionId
        && observation.role === request.role
      ));
      if (!latest || latest.toolCallId !== request.expectedLatestToolCallId
        || latest.startedAtMs !== request.expectedLatestStartedAtMs) return [];
      claimed.push(target);
    }

    for (const target of claimed) {
      target.followupEmitted = true;
      target.updatedAtMs = claimedAtMs;
    }
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return claimed.map((observation) => ({ ...observation }));
  }) || [];
}

function validCursorFollowupSuppressionRequest(request: CursorFollowupSuppressionRequest): boolean {
  if (!Number.isFinite(request.observedAtMs) || request.observedAtMs <= 0) return false;
  if (request.scope === 'child') {
    return request.reason === 'subagent-stop-user-abort'
      && Boolean(firstString(request.toolCallId))
      && (request.parentSessionId === undefined || Boolean(firstString(request.parentSessionId)));
  }
  return Boolean(firstString(request.parentSessionId))
    && CURSOR_PARENT_FOLLOWUP_SUPPRESSION_REASONS.has(request.reason);
}

/**
 * Durably suppress lifecycle continuation for observations that existed when a
 * user-abort signal was observed. Parent scope covers every pre-event row for
 * that parent; child scope is exact by immutable SubagentStart tool id. Future
 * starts are deliberately outside the observedAtMs watermark. First evidence
 * wins so duplicate lifecycle hooks cannot rewrite the audit reason/timestamp.
 */
export function suppressCursorFollowupsBatch(
  cwd: string,
  runId: string,
  request: CursorFollowupSuppressionRequest,
): CursorSpawnObservation[] {
  if (!runId || isNonProjectRoot(cwd) || !validCursorFollowupSuppressionRequest(request)) return [];
  const suppressedAtMs = request.observedAtMs;

  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const changed = store.observations.filter((observation) => {
      if (observation.followupSuppressed || observation.startedAtMs > request.observedAtMs) return false;
      if (request.scope === 'child') {
        return observation.toolCallId === request.toolCallId
          && (!request.parentSessionId || observation.parentSessionId === request.parentSessionId);
      }
      return observation.parentSessionId === request.parentSessionId;
    });
    if (!changed.length) return [];
    for (const observation of changed) {
      observation.followupSuppressed = true;
      observation.followupSuppressedAtMs = suppressedAtMs;
      observation.followupSuppressionReason = request.reason;
      observation.updatedAtMs = suppressedAtMs;
    }
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return changed.map((observation) => ({ ...observation }));
  }) || [];
}

function markCursorSpawnObservationOnce(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  field: 'followupEmitted' | 'retryHandled',
  nowMs: number,
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.childTranscriptId === childId);
    if (!target || target[field]
      || (field === 'followupEmitted' && (target.retryHandled || target.followupSuppressed))) return null;
    target[field] = true;
    target.updatedAtMs = finiteMs(nowMs) || Date.now();
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

// Atomic compare-and-set markers for hooks that may race. A null return means the
// transcript is unknown or another hook already owns the follow-up/retry action.
export function markCursorSpawnObservationFollowupEmitted(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  return markCursorSpawnObservationOnce(cwd, runId, childTranscriptId, 'followupEmitted', nowMs);
}

export function markCursorSpawnObservationRetryHandled(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  return markCursorSpawnObservationOnce(cwd, runId, childTranscriptId, 'retryHandled', nowMs);
}

export function consumeCursorSpawnObservation(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.childTranscriptId === childId);
    if (!target) return null;
    if (target.consumedAtMs) return target;
    target.consumedAtMs = finiteMs(nowMs) || Date.now();
    target.updatedAtMs = target.consumedAtMs;
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

