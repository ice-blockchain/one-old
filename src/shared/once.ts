// src/shared/once.ts
// Session-scoped "emit once" disk markers. Hooks run as ONE PROCESS PER EVENT,
// so in-memory throttles reset on every tool call; these markers let repeated
// advisory/directive blocks inject once per host session instead of on every
// matching prompt or tool call. Markers live under .traffic-one/runs/.once/
// (gitignored with the rest of .traffic-one), keyed by (label, session id);
// stale markers are swept opportunistically on write. Every mutation goes
// through shared/fsjson.ts's guarded primitives, so a project whose use-plugin
// question is unanswered (or answered no) accrues no markers.

import * as fs from 'fs';
import * as path from 'path';

import { removePath, writeTextFile } from './fsjson';

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

// The in-memory half of the throttle, used only when the DISK marker could not be
// persisted. See firstEmitThisSession: `true` there does not mean "the marker is
// on disk", and without this it did not mean "once" either.
const emittedInProcess = new Map<string, number>();

/** Forget this process's unpersisted emissions. For tests, which drive many
 *  projects and sessions through a single process. */
export function resetUnpersistedEmitThrottle(): void {
  emittedInProcess.clear();
}

// True exactly once per (cwd, label, session): the first call writes the marker
// and returns true; later calls in the same session return false. Best-effort —
// when the marker cannot be persisted the block emits (never suppress on error).
//
// Consent: the markers live under `<project>/.traffic-one/runs/.once/`, so
// writeTextFile refuses them until the use-plugin question is answered. The
// return value stays TRUE in that window — the fence is about the project tree
// staying byte-identical, never about silencing the product. Every caller here
// is an advisory block, and the pre-answer surface is one question per session
// anyway, so an unthrottled emit costs nothing. Eight of the nine call sites
// are in the onboarding gate, which by definition runs before consent; they
// were previously unreachable only because an earlier return happened to come
// first, which is luck, not a fence.
//
// But "never suppress" is not the same as "never throttle", and the write's
// boolean used to decide only whether to SWEEP — never the answer. So an
// unwritable marker (a planted symlink at that path, an errno, a project still
// pre-consent inside one long-lived OpenCode/Kilo process) made every subsequent
// call answer `true` as well, silently converting a once-per-session function
// into an every-call one. That is not only louder output: several callers spend
// this boolean to choose between a FULL instruction and a SHORT repeat, and pair
// it with distinct deny ids (see config/deny-ids.ts), so the repeat form became
// unreachable and the full instruction re-delivered on every tool call.
//
// The fallback below is a faithful mirror of the disk semantics — permanent for a
// session-keyed marker, TTL-bounded without one — so the answer keeps meaning
// "once" for as long as this process lives, while still emitting the first time.
// Hooks are one process per event on Claude/Codex/Cursor/Copilot, so there this
// changes nothing; it is the long-lived wrappers that were paying for it. Same
// remedy, same reason as the process-scoped set in session/session-start-lib.ts.
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
  let persisted = false;
  try {
    persisted = writeTextFile(marker, `${new Date().toISOString()}\n`);
    if (persisted) sweepStale(dir);
  } catch {
    // best effort
  }
  if (!persisted) {
    const processKey = `${path.resolve(cwd)}\u0000${name}`;
    const emittedAt = emittedInProcess.get(processKey);
    if (emittedAt !== undefined && (sessionId || Date.now() - emittedAt < NO_SESSION_TTL_MS)) return false;
    emittedInProcess.set(processKey, Date.now());
  }
  return true;
}

// Cross-surface TTL markers (no session key): several independent surfaces can
// emit the same user-facing content (e.g. the wizard URL comes from the
// session-start banner, the prompt-submit recipe, the gate deny, AND the wait
// runner's terminal banner). The runner is a separate process with no session
// id, so session-keyed markers can't dedupe across them — a plain mtime-TTL
// marker can. Emitters STAMP; the redundant surface CHECKS before printing.
export function stampEmitMarker(cwd: string, label: string): void {
  try {
    writeTextFile(path.join(onceDir(cwd), `${safeKey(label)}-shared`), `${new Date().toISOString()}\n`);
  } catch {
    // best effort
  }
}

export function emittedWithin(cwd: string, label: string, ttlMs: number): boolean {
  try {
    const stat = fs.statSync(path.join(onceDir(cwd), `${safeKey(label)}-shared`));
    return Date.now() - stat.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

// Forget one cross-surface TTL marker so its surface can re-emit before the TTL
// lapses. Used by the onboarding waiter's pending exit: a wait that timed out
// without setup completing re-arms the setup-link nudge, so the NEXT gated tool
// call re-delivers the link instead of running silent inside the 5-minute TTL.
export function clearEmitMarker(cwd: string, label: string): void {
  try {
    removePath(path.join(onceDir(cwd), `${safeKey(label)}-shared`));
  } catch {
    // best effort — a missing marker is already the desired state
  }
}

function sweepStale(dir: string): void {
  try {
    for (const name of fs.readdirSync(dir).slice(0, 256)) {
      const markerPath = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(markerPath).mtimeMs > SWEEP_AGE_MS) removePath(markerPath);
      } catch {
        // best effort per entry
      }
    }
  } catch {
    // best effort
  }
}
