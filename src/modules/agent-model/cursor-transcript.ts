// src/modules/agent-model/cursor-transcript.ts
// Cursor transcript parsing and correlation predicates.

import * as fs from 'fs';
import { pickCursorSlug } from '../../shared/materialize/cursor-models';
import { modelMatchesExpected } from '../../shared/model-tiers';
import {
  readRunModelPolicy,
  resolveRunPolicyFallback,
  type RunModelPolicyV1,
} from '../../shared/run-model-policy';
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
  markModelChoicePrompted,
  modelChoicePrompted,
  readModelChoice,
} from './model-choice';

import {
  CORRELATION_EARLY_TOLERANCE_MS,
  CORRELATION_WINDOW_MS,
  FAILURE_STATUSES,
  SUCCESS_STATUSES,
  type ParsedCursorTranscript,
} from './cursor-failure-prose';

function stringifyErrorValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(stringifyErrorValue).filter(Boolean).join('\n');
  const record = value as Record<string, unknown>;
  const direct = [
    record.error,
    record.error_message,
    record.errorMessage,
    record.message,
    record.detail,
    record.reason,
  ]
    .map(stringifyErrorValue)
    .filter(Boolean);
  if (direct.length) return direct.join('\n');
  try { return JSON.stringify(record); } catch { return ''; }
}

export function parseCursorTranscript(candidate: CursorTranscriptCandidate): ParsedCursorTranscript | null {
  let raw = '';
  try { raw = fs.readFileSync(candidate.filePath, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  let terminalRecord: Record<string, unknown> | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] as string) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
      const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
      if (type === 'turn_ended' || FAILURE_STATUSES.has(status) || SUCCESS_STATUSES.has(status)) {
        terminalRecord = record;
        break;
      }
    } catch {
      // A partially flushed final line is not terminal yet; a later hook retries.
    }
  }
  const status = terminalRecord && typeof terminalRecord.status === 'string'
    ? terminalRecord.status.trim().toLowerCase()
    : '';
  const terminal = Boolean(terminalRecord)
    && (String(terminalRecord?.type || '').toLowerCase() === 'turn_ended'
      || FAILURE_STATUSES.has(status)
      || SUCCESS_STATUSES.has(status));
  const error = terminalRecord
    ? stringifyErrorValue(
      terminalRecord.error
      ?? terminalRecord.error_message
      ?? terminalRecord.errorMessage
      ?? terminalRecord.message
      ?? terminalRecord.reason,
    )
    : '';
  const failed = terminal && (FAILURE_STATUSES.has(status) || Boolean(error));
  return {
    candidate,
    role: inferRoleFromTranscript(candidate.filePath),
    lineCount: lines.length,
    terminal,
    failed,
    error: error || (failed ? `Cursor subagent ended with status ${status || 'error'}.` : ''),
  };
}

// mtime is a last-write timestamp and therefore unsafe for ordinary child
// transcripts. The sole fallback is the incident's startup-failure shape: a
// terminal one-line JSONL whose filesystem does not expose birthtime.
export function correlationTimeMs(transcript: ParsedCursorTranscript): number | null {
  if (Number.isFinite(transcript.candidate.birthtimeMs) && transcript.candidate.birthtimeMs > 0) {
    return transcript.candidate.birthtimeMs;
  }
  if (transcript.terminal && transcript.lineCount === 1
    && Number.isFinite(transcript.candidate.mtimeMs) && transcript.candidate.mtimeMs > 0) {
    return transcript.candidate.mtimeMs;
  }
  return null;
}

export function compatibleObservation(
  observation: CursorSpawnObservation,
  transcript: ParsedCursorTranscript,
): boolean {
  if (observation.parentSessionId !== transcript.candidate.parentSessionId) return false;
  const transcriptAt = correlationTimeMs(transcript);
  if (!transcriptAt) return false;
  const delta = transcriptAt - observation.startedAtMs;
  return delta >= -CORRELATION_EARLY_TOLERANCE_MS && delta <= CORRELATION_WINDOW_MS;
}

export function sameFamily(left: string, right: string): boolean {
  return modelMatchesExpected(left, right) || modelMatchesExpected(right, left);
}

// Cursor's Task model parameter is a concrete offered slug. Family matching is
// correct for exhaustion/unavailability sets, but a correlated retry may bypass
// the normal degradation gates only on the exact slug we prescribed.
export function sameExactSlug(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// Roles whose spawn failed into the enable/fallback decision this run. The
// model-choice gate uses this to SCOPE the pause: a healthy in-flight sibling
// role (no pending failure of its own) keeps working while the user decides.
// Consumed-ness is irrelevant here — the pause outlives observation consumption;
// only an applied retry (retryHandled) releases the role.
export function rolesAwaitingModelChoice(cwd: string, runId: string): Set<string> {
  const roles = new Set<string>();
  for (const observation of listCursorSpawnObservations(cwd, runId)) {
    if (observation.retryHandled) continue;
    if (observation.outcome === 'api-limit' || observation.outcome === 'model-unavailable') {
      roles.add(observation.role);
    }
  }
  return roles;
}

export function unavailableModelsForRun(cwd: string, runId: string): string[] {
  // An explicit enable-retry choice means the user has fixed availability. Until
  // then, positive unavailable outcomes remain run-level exclusions so parallel
  // roles do not retry the same disabled slug.
  if (readModelChoice(cwd, runId) === 'enable-retry') return [];
  return listCursorSpawnObservations(cwd, runId)
    .filter((observation) => observation.outcome === 'model-unavailable')
    .map((observation) => observation.requestedModel);
}

export function exactRecommendedModel(policy: RunModelPolicyV1, observation: CursorSpawnObservation): string {
  const captured = [...(policy.cursorAvailableModels || [])];
  return pickCursorSlug([observation.expectedModel], captured) || observation.expectedModel;
}

