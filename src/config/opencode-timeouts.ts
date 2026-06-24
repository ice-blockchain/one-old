// src/config/opencode-timeouts.ts
// Centralized OpenCode delegation timeouts and keep-alive policy.

/** Per-attempt OpenCode CLI ceiling (env: T1_OC_UNIT_TIMEOUT_MS). Bounded to 90s so a
 *  stalling free model (the repeated 300s ETIMEDOUT that wedged tests/3c) yields to the
 *  next model / paid fallback fast instead of burning 300s per attempt. A unit's scope is
 *  one bounded area, so a working free model completes well inside this; raise the env var
 *  for an explicitly-pinned slow model. */
export function opencodeUnitTimeoutMs(): number {
  const v = Number(process.env.T1_OC_UNIT_TIMEOUT_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 90_000;
}

/** Cancel background delegation when orchestrator stops polling (env: T1_OC_ABANDON_MS). */
export function abandonAfterMs(): number {
  const v = Number(process.env.T1_OC_ABANDON_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 900_000;
}

/** Watchdog poll interval for poll-liveness cancellation (env: T1_OC_WATCHDOG_TICK_MS). */
export function watchdogTickMs(): number {
  const v = Number(process.env.T1_OC_WATCHDOG_TICK_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

/** Suggested client re-poll delay for resumable MCP calls (env: T1_OC_POLL_AFTER_MS). */
export function pollAfterMs(): number {
  const v = Number(process.env.T1_OC_POLL_AFTER_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 15_000;
}

/** When true, alive child processes refresh poll keep-alive (env: T1_OC_CHILD_KEEPALIVE=false disables). */
export function childKeepAliveEnabled(): boolean {
  const raw = (process.env.T1_OC_CHILD_KEEPALIVE ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/** Bounded wait window for resumable MCP tool calls (stay under host ~120s ceiling). */
export const RESUME_WAIT_MS = 45_000;
