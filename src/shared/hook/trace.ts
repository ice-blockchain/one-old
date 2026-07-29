// src/shared/hook/trace.ts
// Off-by-default diagnostic. When TRAFFIC_ONE_HOOK_TRACE is set, append one JSON
// line per hook invocation capturing exactly what the host piped in (stdin), the
// parsed canonical input, the run-agent identity the plugin resolves, the
// effective team.mode / performance.level, the run-claim files on disk, and a
// filtered slice of env. Purpose: determine what identity signal Codex actually
// delivers to per-tool-call hooks (subagent thread id / parent / env var) before
// committing to an identity-recovery mechanism — see the Phase 0 plan.
//
// Contract: never throws (preserves the always-exit-0 hook contract) and never
// captures secrets (env is allowlisted by name and value-truncated).

import * as fs from 'fs';
import * as path from 'path';

import type { HookInput } from '../../core/types';
import { obj } from '../obj';
import { paths } from '../paths';
import { nowIso } from '../text';
import { readEffectiveState } from '../state';
import { hookSessionIdentity } from '../state/run-agent';

const ENV_ALLOW_RE = /(CODEX|THREAD|AGENT|SESSION|PARENT|NICK|FORK|SUBAGENT|ROLLOUT)/i;
const ENV_DENY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE)/i;

function filteredEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (!ENV_ALLOW_RE.test(name) || ENV_DENY_RE.test(name)) continue;
    out[name] = value.length > 256 ? `${value.slice(0, 256)}…` : value;
  }
  return out;
}

// Best-effort list of run-claim files (pending + claimed) so the trace shows what
// the resolver had to match against at write time. Capped to keep lines small.
function runClaimFiles(projectRoot: string): string[] {
  const root = path.join(projectRoot, '.traffic-one', 'runs');
  const found: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= 50) return;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else if (entry.name.endsWith('.json')) found.push(`${rel}${entry.name}`);
    }
  };
  try {
    for (const run of fs.readdirSync(root, { withFileTypes: true })) {
      if (run.isDirectory()) walk(path.join(root, run.name), `${run.name}/`);
    }
  } catch {
    // no runs dir yet — fine
  }
  return found;
}

// Enabled by either the env var (TRAFFIC_ONE_HOOK_TRACE) or a per-project marker
// file (.traffic-one/debug/trace.on) — the marker avoids having to inject env into a
// host (e.g. Codex Desktop) that does not forward shell env to hook subprocesses.
function traceEnabled(projectRoot: string, env: NodeJS.ProcessEnv): boolean {
  if (env.TRAFFIC_ONE_HOOK_TRACE) return true;
  try {
    return fs.existsSync(path.join(projectRoot, '.traffic-one', 'debug', 'trace.on'));
  } catch {
    return false;
  }
}

export function maybeTraceHook(input: HookInput, stdin: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const projectRoot = paths.projectRoot(input);
    if (!traceEnabled(projectRoot, env)) return;

    let identity: unknown;
    try {
      identity = hookSessionIdentity(input.raw);
    } catch {
      identity = 'ERR';
    }

    let teamMode: unknown = null;
    let level: unknown = null;
    try {
      const state = obj(readEffectiveState(projectRoot)) || {};
      teamMode = (obj(state.team) || {}).mode ?? null;
      level = (obj(state.performance) || {}).level ?? null;
    } catch {
      // best-effort
    }

    const record = {
      at: nowIso(),
      event: input.event,
      host: input.host,
      cwd: input.cwd,
      projectRoot,
      tool: input.tool
        ? { rawName: input.tool.rawName, class: input.tool.class, filePath: input.tool.filePath ?? null }
        : null,
      identity,
      teamMode,
      level,
      runClaims: runClaimFiles(projectRoot),
      env: filteredEnv(env),
      stdin: stdin.length > 8192 ? `${stdin.slice(0, 8192)}…[${stdin.length}B]` : stdin,
    };

    const dir = path.join(projectRoot, '.traffic-one', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-trace.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Diagnostics must never affect the hook outcome.
  }
}
