// src/shared/once.ts
// Session-scoped "emit once" disk markers. Hooks run as ONE PROCESS PER EVENT,
// so in-memory throttles reset on every tool call; these markers let repeated
// advisory/directive blocks inject once per host session instead of on every
// matching prompt or tool call. Markers live under .traffic-one/runs/.once/
// (gitignored with the rest of .traffic-one), keyed by (label, session id);
// stale markers are swept opportunistically on write.

import * as fs from 'fs';
import * as path from 'path';

// Payloads without a session id (some hosts/tests) fall back to a per-project
// TTL so the block still re-surfaces periodically instead of once ever.
const NO_SESSION_TTL_MS = 30 * 60 * 1000;
const SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function onceDir(cwd: string): string {
  return path.join(cwd, '.traffic-one', 'runs', '.once');
}

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96);
}

// True exactly once per (cwd, label, session): the first call writes the marker
// and returns true; later calls in the same session return false. Best-effort —
// when the marker cannot be persisted the block emits (never suppress on error).
export function firstEmitThisSession(cwd: string, label: string, sessionId: string | null | undefined): boolean {
  const dir = onceDir(cwd);
  const name = sessionId ? `${safeKey(label)}-${safeKey(sessionId)}` : `${safeKey(label)}-nosession`;
  const marker = path.join(dir, name);
  try {
    const stat = fs.statSync(marker);
    if (sessionId) return false;
    if (Date.now() - stat.mtimeMs < NO_SESSION_TTL_MS) return false;
  } catch {
    // missing marker → first emit
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8');
    sweepStale(dir);
  } catch {
    // best effort
  }
  return true;
}

// Test helper: forget all once-markers for a project.
export function resetOnceMarkers(cwd: string): void {
  try {
    fs.rmSync(onceDir(cwd), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function sweepStale(dir: string): void {
  try {
    for (const name of fs.readdirSync(dir).slice(0, 256)) {
      const markerPath = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(markerPath).mtimeMs > SWEEP_AGE_MS) fs.unlinkSync(markerPath);
      } catch {
        // best effort per entry
      }
    }
  } catch {
    // best effort
  }
}
