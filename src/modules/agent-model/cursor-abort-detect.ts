// src/modules/agent-model/cursor-abort-detect.ts
// User-abort forensics over raw lifecycle payloads.

import * as fs from 'fs';
import * as path from 'path';
import {  followup } from '../../core/result';
import type { Ctx } from '../../core/types';
import { obj } from '../../shared/obj';
import {
  normalizeHostCallId,
  listCursorSubagentTranscriptCandidates,
  type CursorSpawnObservation,
} from '../../shared/state';

import {
  FAILURE_STATUSES,
  SUCCESS_STATUSES,
} from './cursor-failure-prose';
import { openRegularFd } from '../../shared/bounded-read';

export function rawParentSessionIds(raw: unknown): Set<string> {
  const data = obj(raw) || {};
  const payload = obj(data.payload) || {};
  const explicit = [
    data.parent_conversation_id,
    data.parentConversationId,
    payload.parent_conversation_id,
    payload.parentConversationId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const values = explicit.length ? explicit : [
    data.session_id,
    data.sessionId,
    data.conversation_id,
    data.conversationId,
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return new Set(values.map((value) => value.trim()));
}

const USER_ABORT_TEXT_RE = /\buser\s+(?:aborted|cancelled|canceled)\s+(?:the\s+)?request\b|\brequest\s+(?:was\s+)?(?:aborted|cancelled|canceled)\s+by\s+(?:the\s+)?user\b|\bUSER[_-](?:ABORTED|CANCELLED|CANCELED)\b/i;

function structuredAbortValue(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return USER_ABORT_TEXT_RE.test(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return false;
  const record = value as Record<string, unknown>;
  if (record.user_aborted === true || record.userAborted === true
    || record.cancelled_by_user === true || record.canceled_by_user === true
    || record.cancelledByUser === true || record.canceledByUser === true) return true;
  return [
    record.error,
    record.error_message,
    record.errorMessage,
    record.message,
    record.reason,
    record.detail,
    record.code,
    record.status,
  ]
    .some((item) => structuredAbortValue(item, depth + 1));
}

function recordHasStructuredAbort(record: Record<string, unknown>): boolean {
  if (record.user_aborted === true || record.userAborted === true
    || record.cancelled_by_user === true || record.canceled_by_user === true
    || record.cancelledByUser === true || record.canceledByUser === true) return true;
  return [
    record.error,
    record.error_message,
    record.errorMessage,
    record.message,
    record.reason,
    record.detail,
    record.code,
    record.status,
  ]
    .some((value) => structuredAbortValue(value));
}

function lifecycleStatusIsAborted(record: Record<string, unknown>): boolean {
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  return status === 'aborted' || status === 'cancelled' || status === 'canceled';
}

function rawLifecycleRecord(raw: unknown): { data: Record<string, unknown>; payload: Record<string, unknown> } {
  const data = obj(raw) || {};
  return { data, payload: obj(data.payload) || {} };
}

export function stopHasParentUserAbort(raw: unknown): boolean {
  const { data, payload } = rawLifecycleRecord(raw);
  return lifecycleStatusIsAborted(data)
    || lifecycleStatusIsAborted(payload)
    || recordHasStructuredAbort(data)
    || recordHasStructuredAbort(payload);
}

export function subagentStopHasChildUserAbort(raw: unknown): boolean {
  const { data, payload } = rawLifecycleRecord(raw);
  return lifecycleStatusIsAborted(data)
    || lifecycleStatusIsAborted(payload)
    || recordHasStructuredAbort(data)
    || recordHasStructuredAbort(payload);
}

export function subagentStopHasParentUserAbort(raw: unknown): boolean {
  const { data, payload } = rawLifecycleRecord(raw);
  const parent = obj(data.parent) || {};
  const payloadParent = obj(payload.parent) || {};
  const parentFields: Record<string, unknown> = {
    error: data.parent_error ?? data.parentError ?? payload.parent_error ?? payload.parentError,
    error_message: data.parent_error_message ?? data.parentErrorMessage
      ?? payload.parent_error_message ?? payload.parentErrorMessage,
    message: data.parent_message ?? data.parentMessage ?? payload.parent_message ?? payload.parentMessage,
    reason: data.parent_reason ?? data.parentReason ?? payload.parent_reason ?? payload.parentReason,
    code: data.parent_code ?? data.parentCode ?? payload.parent_code ?? payload.parentCode,
    status: data.parent_status ?? data.parentStatus ?? payload.parent_status ?? payload.parentStatus,
    user_aborted: data.parent_user_aborted ?? data.parentUserAborted
      ?? payload.parent_user_aborted ?? payload.parentUserAborted,
  };
  return lifecycleStatusIsAborted(parentFields)
    || lifecycleStatusIsAborted(parent)
    || lifecycleStatusIsAborted(payloadParent)
    || recordHasStructuredAbort(parentFields)
    || recordHasStructuredAbort(parent)
    || recordHasStructuredAbort(payloadParent);
}

function latestParentTurnWasUserAborted(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index] as string) as unknown;
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const item = record as Record<string, unknown>;
      const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
      const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
      if (type !== 'turn_ended' && !FAILURE_STATUSES.has(status) && !SUCCESS_STATUSES.has(status)) {
        // A message record AFTER the newest terminal record means the parent
        // has since opened another turn, so whatever ended earlier is history.
        // Walking past it read a stale cancellation as a live one: observed
        // 2cu-cursor, the user aborted the onboarding turn minutes BEFORE the
        // architect existed, and every subsequent child's completion followup
        // was suppressed as `parent-transcript-user-abort` — the orchestrator
        // never heard that its architect finished and respawned it instead.
        const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
        if (role === 'user' || role === 'assistant') return false;
        continue;
      }
      return recordHasStructuredAbort(item);
    } catch {
      // Ignore an incomplete tail line and continue to the latest complete turn.
    }
  }
  return false;
}

export function parentTranscriptWasUserAborted(
  cwd: string,
  raw: unknown,
  parentSessionId: string,
  pending: readonly CursorSpawnObservation[],
): boolean {
  // Parent transcripts are read ONLY as a cancellation guard; they never enter
  // failure classification/correlation. Child results still come exclusively
  // from subagents/*.jsonl.
  const wanted = new Map(pending
    .filter((observation) => observation.childTranscriptId)
    .map((observation) => [observation.childTranscriptId as string, observation.parentSessionId]));
  if (!wanted.size) return false;
  for (const candidate of listCursorSubagentTranscriptCandidates(cwd, raw)) {
    const parentId = wanted.get(candidate.childTranscriptId);
    if (!parentId || parentId !== parentSessionId || parentId !== candidate.parentSessionId) continue;
    const parentPath = path.join(path.dirname(path.dirname(candidate.filePath)), `${parentId}.jsonl`);
    try {
      const stat = fs.statSync(parentPath);
      const start = Math.max(0, stat.size - 32_768);
      const fd = openRegularFd(parentPath);
      try {
        const bytes = Buffer.alloc(stat.size - start);
        fs.readSync(fd, bytes, 0, bytes.length, start);
        if (latestParentTurnWasUserAborted(bytes.toString('utf8'))) return true;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // No parent transcript (or a concurrently rotating file) → raw hook data
      // remains the only cancellation evidence; do not suppress optimistically.
    }
  }
  return false;
}

export function rawLifecycleTimeMs(raw: unknown): number {
  const { data, payload } = rawLifecycleRecord(raw);
  for (const value of [
    data.timestamp, data.occurred_at, data.occurredAt, data.ended_at, data.endedAt,
    payload.timestamp, payload.occurred_at, payload.occurredAt, payload.ended_at, payload.endedAt,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value < 1_000_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return Date.now();
}

// A host id plus its normalized form (chunk-length prefix stripped), de-duplicated. Used
// wherever an INCOMING payload id is matched against a PERSISTED one, so a ledger written
// before or after the normalization fix both compare equal.
export function withNormalizedSpelling(value: string): string[] {
  const trimmed = value.trim();
  const normalized = normalizeHostCallId(trimmed);
  return normalized && normalized !== trimmed ? [trimmed, normalized] : [trimmed];
}

function rawSubagentIds(raw: unknown): Set<string> {
  const { data, payload } = rawLifecycleRecord(raw);
  return new Set([
    data.subagent_id, data.subagentId, data.tool_call_id, data.toolCallId,
    payload.subagent_id, payload.subagentId, payload.tool_call_id, payload.toolCallId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => withNormalizedSpelling(value)));
}

interface CursorLifecycleTarget {
  parentSessionId: string;
  subagent: CursorSpawnObservation | null;
}

export function exactCursorLifecycleTarget(
  event: Ctx['input']['event'],
  raw: unknown,
  observations: readonly CursorSpawnObservation[],
): CursorLifecycleTarget | null {
  const parents = rawParentSessionIds(raw);
  if (parents.size !== 1) return null;
  const parentSessionId = [...parents][0]!;
  if (event === 'Stop') return { parentSessionId, subagent: null };
  if (event !== 'SubagentStop') return null;
  const childIds = rawSubagentIds(raw);
  if (!childIds.size) return null;
  const matches = observations.filter((observation) => (
    observation.parentSessionId === parentSessionId
    && [...childIds].some((childId) => (
      observation.toolCallId === childId || observation.childTranscriptId === childId
    ))
  ));
  return matches.length === 1 ? { parentSessionId, subagent: matches[0]! } : null;
}

