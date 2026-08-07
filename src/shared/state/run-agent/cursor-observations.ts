// src/shared/state/run-agent/cursor-observations.ts
// Cursor spawn observations: the dedicated lock, store read/write, and
// record/claim/update/consume.

import { obj } from '../../obj';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import {  readJson,  writeJson } from '../../fsjson';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { TIER_IDS, type TierId } from '../../../config/model-tiers';

import { withOwnedDirLock } from './locks';
import {
  firstString,
  normalizeHostCallId,
  runDir,
} from './run-paths';

// --- Cursor spawn observations ---------------------------------------------
//
// Cursor can emit `subagentStart` without ever emitting a matching Task result or
// subagentStop. Keep the immutable facts known at spawn time in a separate,
// run-scoped ledger so a later child transcript can be correlated even after the
// live-agent registry entry has been retired. Classification deliberately lives in
// the agent-model layer; this module only owns the one-to-one persistence
// primitives and accepts the classifier's eventual outcome/directive.

const CURSOR_SPAWN_OBSERVATION_LIMIT = 128;

type CursorSpawnObservationOutcome = 'api-limit' | 'model-unavailable' | 'generic';
export type CursorFollowupSuppressionReason =
  | 'stop-user-abort'
  | 'subagent-stop-user-abort'
  | 'subagent-stop-parent-user-abort'
  | 'parent-transcript-user-abort';

interface CursorSpawnObservationInput {
  parentSessionId: string;
  toolCallId: string;
  role: string;
  requestedModel: string;
  tier: TierId;
  expectedModel: string;
  startedAtMs?: number;
}

export interface CursorSpawnObservation {
  parentSessionId: string;
  toolCallId: string;
  role: string;
  requestedModel: string;
  tier: TierId;
  expectedModel: string;
  startedAtMs: number;
  childTranscriptId: string | null;
  outcome: CursorSpawnObservationOutcome | null;
  error: string | null;
  directive: string | null;
  prescribedModel: string | null;
  followupEmitted: boolean;
  followupSuppressed: boolean;
  followupSuppressedAtMs: number | null;
  followupSuppressionReason: CursorFollowupSuppressionReason | null;
  retryHandled: boolean;
  claimedAtMs: number | null;
  consumedAtMs: number | null;
  updatedAtMs: number;
}

interface CursorSpawnObservationUpdate {
  outcome?: CursorSpawnObservationOutcome | null;
  error?: string | null;
  directive?: string | null;
  prescribedModel?: string | null;
  followupEmitted?: boolean;
  retryHandled?: boolean;
}

// Snapshot produced by the agent-model selector immediately before a lifecycle
// continuation is claimed. `expectedLatest*` fingerprints the newest immutable
// SubagentStart for this parent+role, which may be a newer no-resume attempt the
// selector has already allowed to age past the 90/270-second liveness window.
// A start recorded after selection changes that fingerprint and invalidates the
// whole parent batch instead of letting concurrent Stop hooks split it.
export interface CursorFollowupClaimRequest {
  parentSessionId: string;
  expectedParentFingerprint: string;
  role: string;
  childTranscriptId: string;
  toolCallId: string;
  expectedLatestToolCallId: string;
  expectedLatestStartedAtMs: number;
  directive: string;
  prescribedModel: string | null;
}

interface CursorParentObservationSnapshot {
  parentSessionId: string;
  fingerprint: string;
  observations: CursorSpawnObservation[];
}

interface CursorParentFollowupSuppressionRequest {
  scope: 'parent';
  parentSessionId: string;
  observedAtMs: number;
  reason:
    | 'stop-user-abort'
    | 'subagent-stop-parent-user-abort'
    | 'parent-transcript-user-abort';
}

interface CursorChildFollowupSuppressionRequest {
  scope: 'child';
  toolCallId: string;
  parentSessionId?: string;
  observedAtMs: number;
  reason: 'subagent-stop-user-abort';
}

export type CursorFollowupSuppressionRequest =
  | CursorParentFollowupSuppressionRequest
  | CursorChildFollowupSuppressionRequest;

interface CursorSpawnObservationStore {
  version: 1;
  observations: CursorSpawnObservation[];
}

const CURSOR_SPAWN_OUTCOMES: ReadonlySet<string> = new Set(['api-limit', 'model-unavailable', 'generic']);
const CURSOR_FOLLOWUP_SUPPRESSION_REASONS: ReadonlySet<string> = new Set([
  'stop-user-abort',
  'subagent-stop-user-abort',
  'subagent-stop-parent-user-abort',
  'parent-transcript-user-abort',
]);
export const CURSOR_PARENT_FOLLOWUP_SUPPRESSION_REASONS: ReadonlySet<string> = new Set([
  'stop-user-abort',
  'subagent-stop-parent-user-abort',
  'parent-transcript-user-abort',
]);
const CURSOR_SPAWN_LOCK_TIMEOUT_MS = 2_000;
const CURSOR_SPAWN_LOCK_STALE_MS = 15_000;
const CURSOR_SPAWN_LOCK_RETRY_MS = 10;
export const CURSOR_TRANSCRIPT_EARLY_TOLERANCE_MS = 1_500;
const CURSOR_SPAWN_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function cursorSpawnObservationFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'cursor-spawns.json');
}

function cursorSpawnObservationLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.cursor-spawns.lock');
}

export function validCursorTranscriptId(value: unknown): string | null {
  const id = firstString(value);
  if (!id || id.includes('..') || /[\\/]/.test(id)) return null;
  return id.slice(0, 200);
}

export function finiteMs(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function boundedCursorSpawnText(value: unknown, maxLength: number): string | null {
  const text = firstString(value);
  return text ? text.slice(0, maxLength) : null;
}

function normalizeCursorSpawnObservation(value: unknown): CursorSpawnObservation | null {
  const item = obj(value);
  if (!item) return null;
  const parentSessionId = firstString(item.parentSessionId, item.parent_session_id);
  const toolCallId = normalizeHostCallId(firstString(item.toolCallId, item.tool_call_id, item.observationId));
  const role = firstString(item.role);
  const requestedModel = firstString(item.requestedModel, item.requested_model, item.model);
  const expectedModel = firstString(item.expectedModel, item.expected_model, item.expected);
  const rawTier = firstString(item.tier);
  const tier = rawTier && (TIER_IDS as readonly string[]).includes(rawTier) ? rawTier as TierId : null;
  const startedAtMs = finiteMs(item.startedAtMs, item.started_at_ms, item.startedAt, item.createdAt);
  if (!parentSessionId || !toolCallId || !role || !VALID_AGENT_ROLES.has(role)
    || !requestedModel || !tier || !expectedModel || !startedAtMs) return null;

  const childTranscriptId = validCursorTranscriptId(item.childTranscriptId ?? item.child_transcript_id);
  const rawOutcome = firstString(item.outcome);
  const outcome = rawOutcome && CURSOR_SPAWN_OUTCOMES.has(rawOutcome)
    ? rawOutcome as CursorSpawnObservationOutcome
    : null;
  const error = boundedCursorSpawnText(item.error, 8_192);
  const directive = boundedCursorSpawnText(item.directive, 8_192);
  const prescribedModel = boundedCursorSpawnText(item.prescribedModel ?? item.prescribed_model, 300);
  const claimedAtMs = finiteMs(item.claimedAtMs, item.claimed_at_ms, item.claimedAt);
  const consumedAtMs = finiteMs(item.consumedAtMs, item.consumed_at_ms, item.consumedAt);
  const followupSuppressed = item.followupSuppressed === true || item.followup_suppressed === true;
  const rawSuppressionReason = firstString(item.followupSuppressionReason, item.followup_suppression_reason);
  const followupSuppressionReason = rawSuppressionReason
    && CURSOR_FOLLOWUP_SUPPRESSION_REASONS.has(rawSuppressionReason)
    ? rawSuppressionReason as CursorFollowupSuppressionReason
    : null;
  const followupSuppressedAtMs = followupSuppressed
    ? finiteMs(
      item.followupSuppressedAtMs,
      item.followup_suppressed_at_ms,
      item.followupSuppressedAt,
      item.followup_suppressed_at,
    )
    : null;
  const updatedAtMs = finiteMs(item.updatedAtMs, item.updated_at_ms, item.updatedAt)
    || followupSuppressedAtMs || consumedAtMs || claimedAtMs || startedAtMs;
  return {
    parentSessionId,
    toolCallId,
    role,
    requestedModel,
    tier,
    expectedModel,
    startedAtMs,
    childTranscriptId,
    outcome,
    error,
    directive,
    prescribedModel,
    followupEmitted: item.followupEmitted === true || item.followup_emitted === true,
    followupSuppressed,
    followupSuppressedAtMs: followupSuppressed ? (followupSuppressedAtMs || updatedAtMs) : null,
    followupSuppressionReason: followupSuppressed ? followupSuppressionReason : null,
    retryHandled: item.retryHandled === true || item.retry_handled === true,
    claimedAtMs,
    consumedAtMs,
    updatedAtMs,
  };
}

export function readCursorSpawnObservationStore(cwd: string, runId: string): CursorSpawnObservationStore {
  const raw = readJson<unknown>(cursorSpawnObservationFile(cwd, runId), null);
  const record = obj(raw);
  // Tolerate the pre-versioned array and the early `spawns` key so an in-flight
  // run survives a plugin upgrade. Invalid/duplicate rows are ignored rather than
  // weakening the child-transcript one-to-one invariant.
  const values = Array.isArray(raw)
    ? raw
    : (Array.isArray(record?.observations) ? record.observations : (Array.isArray(record?.spawns) ? record.spawns : []));
  const seenTools = new Set<string>();
  const seenChildren = new Set<string>();
  const observations: CursorSpawnObservation[] = [];
  for (const value of values) {
    const observation = normalizeCursorSpawnObservation(value);
    if (!observation || seenTools.has(observation.toolCallId)) continue;
    if (observation.childTranscriptId && seenChildren.has(observation.childTranscriptId)) continue;
    seenTools.add(observation.toolCallId);
    if (observation.childTranscriptId) seenChildren.add(observation.childTranscriptId);
    observations.push(observation);
  }
  observations.sort((a, b) => a.startedAtMs - b.startedAtMs || a.toolCallId.localeCompare(b.toolCallId));
  return { version: 1, observations: observations.slice(-CURSOR_SPAWN_OBSERVATION_LIMIT) };
}

export function cursorParentObservationFingerprint(
  observations: readonly CursorSpawnObservation[],
  parentSessionId: string,
): string {
  const rows = observations
    .filter((observation) => observation.parentSessionId === parentSessionId)
    .sort((left, right) => (
      left.startedAtMs - right.startedAtMs || left.toolCallId.localeCompare(right.toolCallId)
    ))
    .map((observation) => [
      observation.parentSessionId,
      observation.role,
      observation.toolCallId,
      observation.startedAtMs,
      observation.requestedModel,
      observation.tier,
      observation.expectedModel,
      observation.childTranscriptId,
      observation.claimedAtMs,
      observation.outcome,
      observation.error,
      observation.directive,
      observation.prescribedModel,
      observation.consumedAtMs,
      observation.followupEmitted,
      observation.followupSuppressed,
      observation.followupSuppressedAtMs,
      observation.followupSuppressionReason,
      observation.retryHandled,
    ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function writeCursorSpawnObservationStore(cwd: string, runId: string, observations: CursorSpawnObservation[]): void {
  const store: CursorSpawnObservationStore = {
    version: 1,
    observations: [...observations]
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.toolCallId.localeCompare(b.toolCallId))
      .slice(-CURSOR_SPAWN_OBSERVATION_LIMIT),
  };
  writeJson(cursorSpawnObservationFile(cwd, runId), store);
}

/**
 * Run `mutate` holding this run's spawn-observation lock, or return null.
 *
 * `.cursor-spawns.lock` is the fifth run-scoped owned-dir lock under
 * `.traffic-one/runs/<id>/` and was the only one not taking its lease from
 * locks.ts. Its own acquire loop wrote NO owner record, so the only thing it
 * could ask about a held lock was the directory's mtime — which is stamped at
 * mkdir and does not advance while the holder works. A mutation slower than
 * CURSOR_SPAWN_LOCK_STALE_MS therefore read as abandoned, and the reclaim was a
 * RECURSIVE, FORCED rm: it deleted a live holder's lease outright and the
 * contender walked into the same critical section. Measured with a second real
 * process still inside `mutate()` (live-holder-lock-theft.test.ts). The release
 * had the mirror of the same flaw — a forced recursive rm of whatever directory
 * happened to be at the path, including a successor's.
 *
 * withOwnedDirLock decides staleness from the owner sentinel's own acquisition
 * time AND refuses unless the owner pid is definitely dead (ESRCH), and makes
 * the unlink of that exact sentinel the compare-and-swap, so neither a returning
 * holder nor a competing reaper can remove a new owner's lease. It also still
 * reclaims the ownerless, empty, aged directories this function used to leave
 * behind, which is what keeps projects built by earlier versions from wedging.
 *
 * Known limitation, shared with every lock in this repo and not addressed here:
 * an owner record names a pid and nothing else — no hostname, no boot id, no
 * session id. A pid is only meaningful on the machine that issued it, so on a
 * project living on a shared/network filesystem two machines' hooks can each
 * find the other's pid "definitely dead" and both take the lease. Single-machine
 * use, which is every supported host today, is unaffected.
 */
export function withCursorSpawnObservationLock<T>(cwd: string, runId: string, mutate: () => T): T | null {
  // An array rather than a `T | null`: `mutate` may legitimately return null or
  // undefined, and only "did the lock get taken" decides the caller's answer.
  const captured: T[] = [];
  const ran = withOwnedDirLock(
    cursorSpawnObservationLockDir(cwd, runId),
    CURSOR_SPAWN_LOCK_TIMEOUT_MS,
    CURSOR_SPAWN_LOCK_STALE_MS,
    CURSOR_SPAWN_LOCK_RETRY_MS,
    CURSOR_SPAWN_LOCK_WAIT,
    () => { captured.push(mutate()); },
  );
  return ran && captured.length ? captured[0]! : null;
}

export function listCursorSpawnObservations(cwd: string, runId: string): CursorSpawnObservation[] {
  if (!runId || isNonProjectRoot(cwd)) return [];
  return readCursorSpawnObservationStore(cwd, runId).observations;
}

/**
 * One-read snapshot for a parent lifecycle pass. The caller derives its complete
 * role set and selection from these rows, then supplies the fingerprint to the
 * batch CAS. Any start/result/action transition after this read invalidates the
 * complete continuation instead of allowing a stale subset to be emitted.
 */
export function cursorParentObservationSnapshot(
  cwd: string,
  runId: string,
  parentSessionId: string,
): CursorParentObservationSnapshot | null {
  const parentId = firstString(parentSessionId);
  if (!runId || !parentId || isNonProjectRoot(cwd)) return null;
  const observations = readCursorSpawnObservationStore(cwd, runId).observations
    .filter((observation) => observation.parentSessionId === parentId)
    .map((observation) => ({ ...observation }));
  return {
    parentSessionId: parentId,
    fingerprint: cursorParentObservationFingerprint(observations, parentId),
    observations,
  };
}

// Record the facts known at subagentStart. A repeated tool-call id is idempotent
// and never rewrites the immutable spawn anchor, even if a later hook carries
// different metadata.
export function recordCursorSpawnObservation(
  cwd: string,
  runId: string,
  input: CursorSpawnObservationInput,
): CursorSpawnObservation | null {
  if (!runId || isNonProjectRoot(cwd)) return null;
  const startedAtMs = finiteMs(input.startedAtMs) || Date.now();
  const candidate = normalizeCursorSpawnObservation({
    ...input,
    startedAtMs,
    childTranscriptId: null,
    outcome: null,
    error: null,
    directive: null,
    prescribedModel: null,
    followupEmitted: false,
    followupSuppressed: false,
    followupSuppressedAtMs: null,
    followupSuppressionReason: null,
    retryHandled: false,
    claimedAtMs: null,
    consumedAtMs: null,
    updatedAtMs: startedAtMs,
  });
  if (!candidate) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const existing = store.observations.find((item) => item.toolCallId === candidate.toolCallId);
    if (existing) return existing;
    store.observations.push(candidate);
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return candidate;
  });
}

// Attach one child transcript to one spawn observation. Both directions are
// unique: a transcript can never be claimed by two starts, and a start can never
// be rebound to a different transcript. Repeating the same claim is idempotent.
export function claimCursorSpawnObservation(
  cwd: string,
  runId: string,
  toolCallId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  const toolId = firstString(toolCallId);
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !toolId || !childId || isNonProjectRoot(cwd)) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.toolCallId === toolId);
    if (!target) return null;
    const claimedElsewhere = store.observations.some((item) => (
      item.toolCallId !== toolId && item.childTranscriptId === childId
    ));
    if (claimedElsewhere || (target.childTranscriptId && target.childTranscriptId !== childId)) return null;
    if (target.childTranscriptId === childId) return target;
    target.childTranscriptId = childId;
    target.claimedAtMs = finiteMs(nowMs) || Date.now();
    target.updatedAtMs = target.claimedAtMs;
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

export function cursorSpawnObservationForChild(
  cwd: string,
  runId: string,
  childTranscriptId: string,
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  return readCursorSpawnObservationStore(cwd, runId).observations
    .find((item) => item.childTranscriptId === childId) || null;
}

export function updateCursorSpawnObservation(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  patch: CursorSpawnObservationUpdate,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  if (patch.outcome !== undefined && patch.outcome !== null && !CURSOR_SPAWN_OUTCOMES.has(patch.outcome)) return null;
  if (patch.error !== undefined && patch.error !== null && typeof patch.error !== 'string') return null;
  if (patch.directive !== undefined && patch.directive !== null && typeof patch.directive !== 'string') return null;
  if (patch.prescribedModel !== undefined && patch.prescribedModel !== null && typeof patch.prescribedModel !== 'string') return null;
  if (patch.followupEmitted !== undefined && typeof patch.followupEmitted !== 'boolean') return null;
  if (patch.retryHandled !== undefined && typeof patch.retryHandled !== 'boolean') return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.childTranscriptId === childId);
    if (!target) return null;
    if (patch.outcome !== undefined) target.outcome = patch.outcome;
    if (patch.error !== undefined) target.error = boundedCursorSpawnText(patch.error, 8_192);
    if (patch.directive !== undefined) target.directive = boundedCursorSpawnText(patch.directive, 8_192);
    if (patch.prescribedModel !== undefined) target.prescribedModel = boundedCursorSpawnText(patch.prescribedModel, 300);
    // Action ownership is monotonic. A generic patch may set the marker, but it
    // can never reopen a one-shot follow-up/retry already claimed by another hook.
    if (patch.followupEmitted === true) target.followupEmitted = true;
    if (patch.retryHandled === true) target.retryHandled = true;
    target.updatedAtMs = finiteMs(nowMs) || Date.now();
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

