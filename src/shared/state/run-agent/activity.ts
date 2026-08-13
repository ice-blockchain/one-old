// src/shared/state/run-agent/activity.ts
// Per-role tool-call telemetry: an append-only, lock-free tally (12co measured
// a frontend child at 163 calls — 150 after its context load — with nothing
// counting them). One line per observed tool call, tagged with the CHILD id
// (agent/thread id, not the hook session id — on Claude every child reports
// the PARENT's session_id, so a session-keyed bucket would lump every child
// and every respawn of a role into one) so replacement children sharing a
// role stay distinguishable.
//
// Deliberately NOT in agents.json: that registry is a lock-guarded
// read-modify-write whose contention path silently SKIPS writes — exactly
// wrong for a per-tool-call hot path. O_APPEND one-line writes need no lock,
// and consolidation into the registry can happen at settlement when the run
// is cold. Every write swallows every error — a counter must never break a
// tool call. The ONE enforcement reader is the exploration cap below: an
// at-most-once deny of further broad exploration (search/file-read classes
// only, implementer roles only) once a child's tally passes its cap; the
// warn nudge and the token-report section remain fail-open telemetry.

import * as fs from 'fs';
import * as path from 'path';

import { obj } from '../../obj';
import { runDir } from './run-paths';
import { readRegularFileOrThrow } from '../../bounded-read';

/** Warn-once threshold: a role past this many calls gets one consolidation nudge. */
export const AGENT_ACTIVITY_WARN_THRESHOLD = 20;
/** Regression threshold surfaced by reporting (fail-open — never a deny). */
export const AGENT_ACTIVITY_REGRESSION_THRESHOLD = 50;
/** Exploration-cap default: once ONE child has made this many tool calls, its
 *  next search/file-read call draws a single consolidation deny. Far above any
 *  healthy child (warn fires at 20; the reviewer — exempt anyway — legitimately
 *  reaches ~50-60 on a wide diff) but well under the 12co pathology (163). */
export const AGENT_ACTIVITY_EXPLORATION_CAP_DEFAULT = 100;

/** Only implementers are capped: the read-only reviewer's whole job is
 *  reading (one file per command by contract), and the tester's long legs are
 *  shell verifications the cap never touches anyway. */
export const EXPLORATION_CAPPED_ROLES: ReadonlySet<string> = new Set([
  'senior-frontend',
  'senior-backend',
  'quick-fix',
]);

/** Resolved cap for a role: env override (T1_EXPLORATION_CAP), then the
 *  `agentActivity.explorationCap` preference (number, or per-role map), then
 *  the default. 0 disables the cap entirely. */
export function explorationCapForRole(state: unknown, role: string): number {
  // Guard the raw string first: Number('') is 0, and an ABSENT env var must
  // fall through to prefs/default — not silently disable the cap everywhere.
  const rawEnv = (process.env.T1_EXPLORATION_CAP || '').trim();
  const env = rawEnv ? Number(rawEnv) : Number.NaN;
  if (Number.isFinite(env) && env >= 0) return Math.floor(env);
  const pref = obj(obj(state)?.agentActivity)?.explorationCap;
  if (typeof pref === 'number' && Number.isFinite(pref) && pref >= 0) return Math.floor(pref);
  const perRole = obj(pref)?.[role];
  if (typeof perRole === 'number' && Number.isFinite(perRole) && perRole >= 0) return Math.floor(perRole);
  return AGENT_ACTIVITY_EXPLORATION_CAP_DEFAULT;
}

function activityDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'agent-activity');
}

function activityPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(activityDir(cwd, runId), `${safe}.log`);
}

export function bumpRunAgentActivity(cwd: string, runId: string, role: string, sessionId: string | null | undefined): void {
  if (!runId || !role) return;
  try {
    const target = activityPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${String(sessionId || 'unknown')}\n`, 'utf8');
  } catch {
    // swallow everything: read-only sandboxes, permissions, full disks — the
    // tally under-counts, the tool call proceeds.
  }
}

export interface RunAgentActivity {
  total: number;
  bySession: Record<string, number>;
}

export function readRunAgentActivity(cwd: string, runId: string, role: string): RunAgentActivity {
  const out: RunAgentActivity = { total: 0, bySession: {} };
  if (!runId || !role) return out;
  try {
    const lines = readRegularFileOrThrow(activityPath(cwd, runId, role)).split('\n');
    for (const line of lines) {
      const id = line.trim();
      if (!id) continue;
      out.total += 1;
      out.bySession[id] = (out.bySession[id] || 0) + 1;
    }
  } catch {
    // no activity recorded — zero
  }
  return out;
}

/** Every role's tally for the run, keyed by the role id recorded at bump time. */
export function listRunAgentActivity(cwd: string, runId: string): Record<string, RunAgentActivity> {
  const out: Record<string, RunAgentActivity> = {};
  if (!runId) return out;
  try {
    for (const name of fs.readdirSync(activityDir(cwd, runId))) {
      if (!name.endsWith('.log')) continue;
      const role = name.slice(0, -'.log'.length);
      out[role] = readRunAgentActivity(cwd, runId, role);
    }
  } catch {
    // no activity dir — empty
  }
  return out;
}

// ── Exploration cap deny marker ──────────────────────────────────────────────
// At most ONE cap deny per (runId, role). Its own directory — never the
// opencode-gate-denies budget, which a shared dir would silently consume. The
// convention is INVERTED from the spawn-gate markers ("a missing marker only
// risks one extra deny"): this deny sits on EVERY search/read call, so an
// unwritable marker would re-deny forever and wedge the child. Write it,
// VERIFY it landed, and only then allow the deny; verification failure means
// the deny may not fire at all (fail-open).

function capDenyPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(runDir(cwd, runId), 'agent-activity-denies', safe);
}

export function agentActivityCapDenied(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    return fs.existsSync(capDenyPath(cwd, runId, role));
  } catch {
    return true; // unreadable marker state → treat as already denied (fail-open)
  }
}

/** True only when the marker durably exists after the write — the caller may
 *  deny exactly then. */
export function markAgentActivityCapDenied(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    const target = capDenyPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ deniedAt: new Date().toISOString() })}\n`, 'utf8');
    return fs.existsSync(target);
  } catch {
    return false;
  }
}
