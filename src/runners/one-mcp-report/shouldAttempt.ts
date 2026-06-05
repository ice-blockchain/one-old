// src/runners/one-mcp-report/shouldAttempt.ts
// Retry policy for the fire-and-forget report given the persisted status.
// Ported 1:1 from one-mcp-report/shouldAttempt.cjs.

import { FAILED_RETRY_MS, QUEUED_RETRY_MS } from '../../config/reporting';
import { parseTimestamp } from './lib';

type Rec = Record<string, unknown>;

export function shouldAttempt(status: unknown, nowMs = Date.now()): boolean {
  if (!status || typeof status !== 'object') return true;
  const s = status as Rec;
  if (s.status === 'ok') return false;
  const last = parseTimestamp(s.lastAttemptAt || s.queuedAt);
  if (!last) return true;
  if (s.status === 'queued' || s.status === 'pending') return nowMs - last > QUEUED_RETRY_MS;
  if (s.status === 'failed') return nowMs - last > FAILED_RETRY_MS;
  return true;
}
