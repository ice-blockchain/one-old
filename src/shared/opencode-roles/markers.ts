// src/shared/opencode-roles-markers.ts
// Per-role completion + attempt markers, the runtimeVersion memo (whose
// __dirname read assumes the compiled scripts/shared/ depth -- this file must
// stay flat in shared/), the gateway breaker, and deny markers.

import * as fs from 'fs';
import * as path from 'path';
import { detectHost } from '../host';
import { openCodeDelegationActive } from '../performance';
import { obj } from '../obj';

import {
  TERMINAL_BATCH_OUTCOMES,
  planDelegationQueueRolesForRun,
  type OpenCodePlanBatchState,
  normalizeAttemptRole,
} from './plan-units';
import {
  atomicWriteJson,
  openCodePlanBatchComplete,
  planBatchJsonPath,
  planBatchMarkerPath,
  planBatchPhaseEligible,
  readOpenCodePlanBatchState,
} from './batch-state';

export function markOpenCodePlanRoleCompleted(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  const normalized = normalizeAttemptRole(role);
  try {
    const p = planBatchMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${normalized}\n`, 'utf8');
    const existing = readOpenCodePlanBatchState(cwd, runId);
    if (existing && !TERMINAL_BATCH_OUTCOMES.has(existing.outcome)) {
      const rolesCompleted = existing.rolesCompleted.includes(normalized)
        ? existing.rolesCompleted
        : [...existing.rolesCompleted, normalized];
      atomicWriteJson(planBatchJsonPath(cwd, runId), {
        ...existing,
        rolesCompleted,
      } satisfies OpenCodePlanBatchState);
    }
  } catch {
    // best-effort; a missing marker only keeps the fail-closed batch gate active
  }
}

export function openCodePlanRoleCompleted(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    const p = planBatchMarkerPath(cwd, runId, role);
    if (!fs.existsSync(p)) return false;
    const stat = fs.statSync(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

export function pendingOpenCodePlanRoles(cwd: string, runId: string, state: unknown, host: unknown = detectHost()): string[] {
  if (!runId || !openCodeDelegationActive(state, host)) return [];
  if (!planBatchPhaseEligible(cwd, runId, state)) return [];
  if (openCodePlanBatchComplete(cwd, runId)) return [];
  return planDelegationQueueRolesForRun(cwd, runId);
}

// Per-run marker that an OpenCode delegation reached the CLI for a role. The
// runner intentionally writes this only after setup/preconditions pass; sandbox
// worktree failures and host-policy rejections are not real OpenCode attempts.
// The spawn gate denies a configured role's paid spawn until this exists, then
// allows the fallback spawn once OpenCode has tried.
// Marker names are NORMALIZED (senior- prefix stripped) so the plan batch
// (queue role labels: "frontend") and the spawn gate (role ids:
// "senior-frontend") agree — observed live: the batch marked `frontend`, the
// gate checked `senior-frontend`, missed it, denied the paid spawn, and its
// deny pushed the orchestrator into a whole-role delegation that timed out.

function attemptMarkerPath(cwd: string, runId: string, role: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-attempts', normalizeAttemptRole(role));
}

// Legacy (pre-normalization) marker path — read-compat for runs written by
// older builds that used the raw role string.
function legacyAttemptMarkerPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-attempts', safe);
}

export function markOpenCodeRoleAttempted(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try {
    const p = attemptMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only means one extra (harmless) gate nudge
  }
}

export function openCodeRoleAttempted(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    return fs.existsSync(attemptMarkerPath(cwd, runId, role))
      || fs.existsSync(legacyAttemptMarkerPath(cwd, runId, role));
  } catch {
    return false;
  }
}

// Append a JSON line describing how the delegation attempt ended (model, action,
// error, duration). The 0-byte marker alone made failed delegations
// undiagnosable after the fact (observed live: an empty
// `opencode-attempts/senior-frontend` while the role silently fell back to a
// paid worker). Diagnostics land in a `.log` SIDECAR next to the marker — the
// marker file itself stays an existence-only flag written exclusively by
// markOpenCodeRoleAttempted (the spawn gate must not see pre-CLI environment
// failures as real attempts).
// The plugin version of the tree THIS module was loaded from. Deliberately derived from
// __dirname (compiled layout: <root>/scripts/shared/opencode-roles.js) rather than any env
// var, cwd, or plugin-root helper: the whole point is to reveal when the runtime serving a
// delegation is a DIFFERENT install than the one the rest of the session believes in.
// Memoized; returns null (never a fake version) when it cannot be read.
let runtimeVersionMemo: string | null | undefined;
function runtimeVersion(): string | null {
  if (runtimeVersionMemo !== undefined) return runtimeVersionMemo;
  let resolved: string | null = null;
  for (const up of [['..', '..'], ['..', '..', '..']]) {
    try {
      const pkg = obj(JSON.parse(fs.readFileSync(path.resolve(__dirname, ...up, 'package.json'), 'utf8')));
      if (pkg?.name === 'traffic-one' && typeof pkg.version === 'string' && pkg.version) {
        resolved = pkg.version;
        break;
      }
    } catch {
      // try the next level up
    }
  }
  runtimeVersionMemo = resolved;
  return resolved;
}

export function recordOpenCodeAttemptOutcome(
  cwd: string,
  runId: string,
  role: string,
  outcome: { action: string; model?: string | null; failureKind?: string | null; error?: string | null; durationMs?: number; touched?: number },
): void {
  if (!runId || !role) return;
  try {
    const p = `${attemptMarkerPath(cwd, runId, role)}.log`;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action: outcome.action,
      model: outcome.model ?? null,
      failureKind: outcome.failureKind ?? null,
      error: outcome.error ? String(outcome.error).slice(0, 500) : null,
      durationMs: typeof outcome.durationMs === 'number' ? Math.round(outcome.durationMs) : undefined,
      touched: typeof outcome.touched === 'number' ? outcome.touched : undefined,
      // WHICH plugin build actually ran this delegation. In cursor-15c the hooks ran
      // 1.0.17 while the MCP server that owns this code ran 1.0.15, so a fixed timeout
      // silently never applied and proving it took process forensics. Resolved from THIS
      // file's own location — never from env/cwd/pluginRoot(), which is the very bug class
      // being diagnosed. A missing field in an old log therefore means "pre-stamp runtime".
      runtimeVersion: runtimeVersion(),
    });
    fs.appendFileSync(p, `${line}\n`, 'utf8');
  } catch {
    // best-effort diagnostics; never block the delegation result
  }
}

// Run-scoped gateway-outage circuit breaker. The delegation runner trips this
// the moment a free-chain walk concludes the gateway ITSELF is down (repeated
// back-to-back stalls), so every later unit — and every later per-role runner
// PROCESS — in the same run can fast-fail to the paid fallback instead of
// re-burning the full unit timeout re-detecting the outage. On disk (not in
// memory) because the MCP layer shards the plan batch across processes.
// Run-scoped: a new runId gets a fresh path, so the breaker clears naturally.
function gatewayBreakerPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-gateway-down');
}

export function markOpenCodeGatewayOutage(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    const p = gatewayBreakerPath(cwd, runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ trippedAt: new Date().toISOString() })}\n`, 'utf8');
  } catch {
    // best-effort; a missing breaker only costs one more full outage detection
  }
}

export function openCodeGatewayOutageActive(cwd: string, runId: string, ttlMs: number, nowMs: number = Date.now()): boolean {
  if (!runId) return false;
  try {
    const raw = fs.readFileSync(gatewayBreakerPath(cwd, runId), 'utf8');
    const trippedAt = Date.parse(String(obj(JSON.parse(raw))?.trippedAt ?? ''));
    return Number.isFinite(trippedAt) && nowMs - trippedAt < ttlMs;
  } catch {
    return false;
  }
}

// Per-run marker that the GATE has already denied a paid spawn of this role
// once. The deny → delegate → re-spawn loop assumes the delegate tool CAN run;
// on Codex the host's safety reviewer can reject the opencode_delegate call
// ABOVE our code, so the runner's attempt marker is never written and a
// marker-only gate would deadlock (delegate blocked by the reviewer, spawn
// blocked by the gate). Host rejection is not an OpenCode attempt; it is a
// policy fallback. The gate therefore denies a (runId, role) at most ONCE: it
// records the denial here and lets the second spawn attempt through.
function denyMarkerPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-gate-denies', safe);
}

export function markOpenCodeGateDenied(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try {
    const p = denyMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only risks one extra deny, never a deadlock
  }
}

export function openCodeGateDenied(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    return fs.existsSync(denyMarkerPath(cwd, runId, role));
  } catch {
    return false;
  }
}

// ── Apply-back latch ─────────────────────────────────────────────────────────
// run-model's apply-back critical section (staged patch + post-apply
// verifications applied to the REAL tree under a backup/restore pair) is only
// atomic while the runner process lives. A kill that lands mid-section strands
// a partial apply, so the runner arms this latch around the section and both
// the MCP cancel path and the idle-abandon watchdog refuse to kill while it
// holds. Liveness is PID-based, not mtime-based: the section's own sanctioned
// budget (several 120s verification commands) exceeds any reasonable freshness
// TTL (an adversarial review proved a 60s TTL expired mid-typecheck and let a
// cancel strand an applied-unverified diff). A latch whose recorded pid is
// dead is ignored immediately — a crashed runner never bricks cancellation —
// and a hard age cap bounds a hung-but-alive runner.
const APPLY_LATCH_LEGACY_TTL_MS = 60_000;
const APPLY_LATCH_HARD_CAP_MS = 15 * 60_000;

function applyLatchPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-applying', safe);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is not ours — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function markOpenCodeApplyInProgress(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try {
    const p = applyLatchPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ armedAt: new Date().toISOString(), pid: process.pid })}\n`, 'utf8');
  } catch {
    // best-effort; without the latch a cancel merely loses this narrow guard
  }
}

export function clearOpenCodeApplyInProgress(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try { fs.rmSync(applyLatchPath(cwd, runId, role), { force: true }); } catch { /* best-effort */ }
}

/** True while ANY role's apply-back latch for this run belongs to a live
 *  runner (pid alive, age under the hard cap). A pid-less legacy latch falls
 *  back to a short mtime freshness window. */
export function openCodeApplyInProgress(cwd: string, runId: string, nowMs: number = Date.now()): boolean {
  if (!runId) return false;
  try {
    const dir = path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-applying');
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name);
      const stat = fs.statSync(target);
      const ageMs = nowMs - stat.mtimeMs;
      if (ageMs >= APPLY_LATCH_HARD_CAP_MS) continue; // runaway backstop
      let pid = 0;
      try {
        pid = Number(obj(JSON.parse(fs.readFileSync(target, 'utf8')))?.pid ?? 0);
      } catch {
        pid = 0;
      }
      if (pid > 0 ? pidAlive(pid) : ageMs < APPLY_LATCH_LEGACY_TTL_MS) return true;
    }
    return false;
  } catch {
    return false;
  }
}
