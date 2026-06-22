// src/shared/onboarding-server/onboarding-session.ts
// Cursor subagent fallback for the onboarding gate. A Cursor subagent's OWN tool/prompt events
// carry NO reliable subagent marker (no parent link; transcript_path is present on some events
// and absent on others — observed both ways), so isSubagentThread/hookSessionIdentity can't
// recognize it. Without that, a subagent spawned before onboarding completes hits the onboarding
// gate and gets trapped on the wizard "wait for setup" command.
//
// The ONE reliable signal (verified from captured payloads): the `subagentStart` event fires in
// the PARENT's context, and its `session_id` / `parent_conversation_id` IS the orchestrator's
// conversation id — and it fires BEFORE the subagent runs its own tools. So we record the
// orchestrator's session as a known MAIN session at subagentStart; thereafter, any session that
// is NOT in the main set is a subagent → the onboarding gate no-ops it. A subagent never appears
// as a subagentStart parent, so it is never mis-recorded as main. Degrades safely: when no main
// has been recorded yet (no spawn has happened), nothing is suppressed — the real wizard shows.
// TTL'd so a later session isn't blocked by a stale set. fs-only, never throws.

import * as fs from 'fs';
import * as path from 'path';

export const ONBOARDING_MAIN_SESSIONS_REL = path.join('.traffic-one', '.onboarding-main-sessions.json');

// Recorded main sessions older than this are ignored. This store exists ONLY to recognize a
// subagent spawned during the brief PRE-onboarding window (the orchestrator→subagent gap is
// seconds, and each subagentStart REFRESHES the parent's timestamp, so an actively-spawning
// orchestrator stays fresh). The foreign check is reached ONLY while `computeOnboarding().done`
// is false, so once onboarding completes the store is never read. A SHORT TTL is therefore
// correct and load-bearing: the original 12h value turned this in-build guard into a cross-build
// / cross-session landmine — a prior (even abandoned) build's recorded main stayed "fresh" for
// 12h and classified a LEGITIMATE new orchestrator session in the same dir as "foreign", silently
// suppressing its setup wizard. 15 min covers any real orchestrator→subagent gap while killing
// that staleness for every practical case (and entirely for the fresh-dir-per-build workflow).
export const ONBOARDING_MAIN_TTL_MS = 15 * 60 * 1000;
const MAX_MAIN_SESSIONS = 16;

function storePath(cwd: string): string {
  return path.join(cwd, ONBOARDING_MAIN_SESSIONS_REL);
}

function readStore(cwd: string): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(cwd), 'utf8')) as { sessions?: unknown };
    const s = raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object' ? (raw.sessions as Record<string, unknown>) : {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(s)) if (typeof v === 'number') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// Record `sessionId` as a known MAIN (orchestrator) session for this project. Called from the
// SubagentStart handler with the parent/orchestrator session id (the spawner). No-op on empty id.
export function recordMainOnboardingSession(cwd: string, sessionId: string, nowMs: number = Date.now()): void {
  if (!sessionId) return;
  try {
    const sessions = readStore(cwd);
    sessions[sessionId] = nowMs;
    // Drop expired + cap size (keep the most recent), so the file can't grow unbounded.
    const fresh = Object.entries(sessions)
      .filter(([, t]) => nowMs - t <= ONBOARDING_MAIN_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_MAIN_SESSIONS);
    const p = storePath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ sessions: Object.fromEntries(fresh) }, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort; a failed record only risks the pre-fix behavior (subagent may see the wizard)
  }
}

// True when `sessionId` is a FOREIGN onboarding thread (NOT one of the recorded main sessions) →
// the onboarding gate should no-op it. Foreign ⟺ at least one fresh main session is recorded AND
// this session is not among them. When no main is recorded yet, returns false (never hide the
// real wizard before we know who the orchestrator is).
export function isForeignOnboardingThread(cwd: string, sessionId: string, nowMs: number = Date.now()): boolean {
  if (!sessionId) return false;
  const sessions = readStore(cwd);
  const fresh = Object.entries(sessions).filter(([, t]) => nowMs - t <= ONBOARDING_MAIN_TTL_MS);
  if (fresh.length === 0) return false; // no known orchestrator yet → don't suppress anyone
  return !fresh.some(([id]) => id === sessionId);
}
