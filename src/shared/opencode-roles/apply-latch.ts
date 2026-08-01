// src/shared/opencode-roles/apply-latch.ts
// The apply-back latch, in its own module so BOTH markers.ts (its historical
// home, which re-exports it) and batch-state.ts (batch liveness) can read it
// without an import cycle (markers already imports batch-state).
//
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

import * as fs from 'fs';
import * as path from 'path';

import { obj } from '../obj';

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
