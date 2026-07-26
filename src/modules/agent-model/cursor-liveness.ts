// Shared Cursor no-resume liveness policy.
//
// Cursor records a tool-call id (`tool_<uuid>` legacy, `fc_<call-id>` current) at
// SubagentStart before a resumable child UUID is
// available. A healthy child normally exposes that UUID through the transcript
// cache within seconds. Until then, a later Task must not duplicate it. We use
// the same two conservative windows everywhere that needs to reason about an
// unterminated start: 90 seconds with independent death evidence, otherwise 270
// seconds. This module deliberately does not classify or exhaust models.

import {
  CURSOR_RESUME_ID_GRACE_MS,
  CURSOR_RESUME_ID_HARD_MS,
} from '../../config/state';
import {
  continuationAgentId,
  type RunAgentEntry,
} from '../../shared/state';

export interface CursorLivenessOptions {
  corroborated: boolean;
  /** Immutable SubagentStart time, used when the registry row is absent. */
  startedAtMs?: number;
  nowMs?: number;
}

export function cursorAgentPresumedDead(
  live: RunAgentEntry | null,
  options: CursorLivenessOptions,
): boolean {
  if (live && continuationAgentId(live, 'cursor')) return false;
  const registryTime = live && typeof live.recordedAt === 'string'
    ? Date.parse(live.recordedAt)
    : NaN;
  const recordedAtMs = Number.isFinite(registryTime)
    ? registryTime
    : (typeof options.startedAtMs === 'number' && Number.isFinite(options.startedAtMs)
      ? options.startedAtMs
      : NaN);
  if (!Number.isFinite(recordedAtMs)) return false;
  const age = (options.nowMs ?? Date.now()) - recordedAtMs;
  return age > (options.corroborated
    ? CURSOR_RESUME_ID_GRACE_MS
    : CURSOR_RESUME_ID_HARD_MS);
}
