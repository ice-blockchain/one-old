// src/runners/one-mcp-report/shouldAttempt.ts
// Retry policy for the fire-and-forget report given the persisted status.
// Ported 1:1 from one-mcp-report/shouldAttempt.cjs.

import { FAILED_RETRY_MS, QUEUED_RETRY_MS } from '../../config/reporting';
import { trustworthyAgeSince } from '../../shared/clock-skew';
import { parseTimestamp } from './lib';

type Rec = Record<string, unknown>;

export function shouldAttempt(status: unknown, nowMs = Date.now()): boolean {
  if (!status || typeof status !== 'object') return true;
  const s = status as Rec;
  if (s.status === 'ok') return false;
  const last = parseTimestamp(s.lastAttemptAt || s.queuedAt);
  if (!last) return true;
  // Recency BLOCKS the retry here, so a stamp ahead of `nowMs` used to hold the
  // report back permanently: `nowMs - last` is negative, never exceeds either
  // retry window, and the queued/failed status it is gating never gets another
  // attempt. An age no clock could have produced is treated exactly like an
  // absent one two lines up — attempt.
  const ageMs = trustworthyAgeSince(last, nowMs);
  if (ageMs === null) return true;
  if (s.status === 'queued' || s.status === 'pending') return ageMs > QUEUED_RETRY_MS;
  if (s.status === 'failed') return ageMs > FAILED_RETRY_MS;
  return true;
}
