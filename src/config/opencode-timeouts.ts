// src/config/opencode-timeouts.ts
// Centralized OpenCode delegation timeouts and keep-alive policy.

/** Per-attempt OpenCode CLI ceiling (env: T1_OC_UNIT_TIMEOUT_MS).
 *
 *  MEASURED, not guessed: a real unit (the cursor-14c "add a News listing + detail
 *  feature" delegation — 6 files, i18n, routes, sitemap) took **467s** end-to-end on
 *  `opencode/deepseek-v4-flash-free` with the warm-up already done, exiting 0 with a
 *  real diff. The previous 90s ceiling therefore made EVERY real delegation impossible:
 *  the CLI was killed mid-work, the runner classified it as a model stall, two stalls
 *  tripped the gateway breaker, and the delegation reported provider-timeout with
 *  delegated=0. Trivial probes (one small file) finish in 6-19s, which is why isolated
 *  smoke checks kept passing while production delegation never worked.
 *
 *  The old 90s was chosen to bound a STALL (the 300s ETIMEDOUTs that wedged tests/3c).
 *  Bounding stalls is now the job of the gateway reachability preflight (an unreachable
 *  gateway is detected in ~120ms) plus maxConsecutiveStalls, so this ceiling is free to
 *  fit real work. Kept under abandonAfterMs() (900s) so a legitimately-working unit is
 *  never killed by the poll-liveness watchdog. */
export function opencodeUnitTimeoutMs(): number {
  const v = Number(process.env.T1_OC_UNIT_TIMEOUT_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 600_000;
}

/** Run-scoped gateway-outage circuit-breaker TTL (env: T1_OC_GATEWAY_BREAKER_MS). Once a
 *  delegation concludes the free gateway itself is down (maxConsecutiveStalls back-to-back
 *  stalls), every later unit — and later per-role runner process — in the same run
 *  fast-fails to the paid fallback for this long instead of re-burning the unit timeout
 *  re-detecting the outage. Long enough to span the rest of a Step-0 batch; short enough
 *  that a later same-run retry re-probes a recovered gateway. */
export function gatewayBreakerMs(): number {
  const v = Number(process.env.T1_OC_GATEWAY_BREAKER_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

/** Back-to-back stall probes before the free-model walk declares a gateway-wide outage
 *  (env: T1_OC_MAX_STALLS). Each stall burns the FULL unit timeout, so this bounds the
 *  outage-detection cost; set 1 for faster detection at the risk of one hung model
 *  tripping the breaker. Clamped to >= 1.
 *
 *  DELIBERATELY still 2 after the ceiling grew to 600s: trying a SECOND model is what
 *  makes one hung free model survivable, and delegation succeeding matters more than the
 *  pathological wall clock. Worst case is now stalls x ceiling (~20min on a gateway that
 *  accepts connections but never answers) before the paid fallback, versus ~3min before.
 *  Two things keep that rare and non-blocking: an UNREACHABLE gateway is caught by the
 *  ~120ms reachability preflight instead of a stall, and the orchestrator's polls continue
 *  throughout (nothing deadlocks; it may simply fall back by stopping its polls). Set
 *  T1_OC_MAX_STALLS=1 to trade that resilience for a 10min worst case. */
export function maxConsecutiveStalls(): number {
  const v = Number(process.env.T1_OC_MAX_STALLS || '');
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 2;
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

/** Sanctioned in-flight budget of ONE unit attempt (env: T1_OC_UNIT_LIVENESS_MS).
 *
 *  A unit's ledger `updatedAt` is refreshed between MODEL ATTEMPTS (the walk
 *  loop) and every MCP watchdog tick, but never inside a single spawnSync
 *  attempt — so liveness readers must tolerate one full attempt (unit timeout)
 *  plus stall retries and apply/verify headroom before calling a unit dead.
 *  Lives in config (not batch-state) so the unit ledger can read it without an
 *  import cycle. */
export function unitLivenessWindowMs(): number {
  const v = Number(process.env.T1_OC_UNIT_LIVENESS_MS || '');
  if (Number.isFinite(v) && v > 0) return v;
  return maxConsecutiveStalls() * opencodeUnitTimeoutMs() + 5 * 60_000;
}

/** Server-side clamp for opencode_status `waitMs` (env: T1_OC_STATUS_WAIT_MAX_MS).
 *
 *  Hosts kill an MCP tool call at ~120s and the failure surfaces as a TOOL
 *  ERROR, not {running:true} — which orchestrator prose reads as "fall back to
 *  paid". A long status wait must therefore return BEFORE the host ceiling no
 *  matter what the caller asked for; 110s leaves transport headroom. This is
 *  what turns the old 45s-per-turn polling into ~2.4x fewer orchestrator
 *  turns without risking a ceiling kill. */
export function statusWaitMaxMs(): number {
  const v = Number(process.env.T1_OC_STATUS_WAIT_MAX_MS || '');
  return Number.isFinite(v) && v > 0 ? v : 110_000;
}

/** Clamp a caller-supplied status wait into [0, statusWaitMaxMs()]. */
export function clampStatusWaitMs(value: unknown): number {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.floor(v), statusWaitMaxMs());
}
