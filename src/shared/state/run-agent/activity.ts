// src/shared/state/run-agent/activity.ts
// Per-role tool-call telemetry: an append-only, lock-free tally (12co measured
// a frontend child at 163 calls — 150 after its context load — with nothing
// counting them). One line per observed tool call, tagged with the child
// session id so replacement children sharing a role stay distinguishable.
//
// Deliberately NOT in agents.json: that registry is a lock-guarded
// read-modify-write whose contention path silently SKIPS writes — exactly
// wrong for a per-tool-call hot path. O_APPEND one-line writes need no lock,
// and consolidation into the registry can happen at settlement when the run
// is cold. Telemetry only: no gate reads these counts, and every write
// swallows every error — a counter must never break a tool call.

import * as fs from 'fs';
import * as path from 'path';

import { runDir } from './run-paths';

/** Warn-once threshold: a role past this many calls gets one consolidation nudge. */
export const AGENT_ACTIVITY_WARN_THRESHOLD = 20;
/** Regression threshold surfaced by reporting (fail-open — never a deny). */
export const AGENT_ACTIVITY_REGRESSION_THRESHOLD = 50;

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
    const lines = fs.readFileSync(activityPath(cwd, runId, role), 'utf8').split('\n');
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
