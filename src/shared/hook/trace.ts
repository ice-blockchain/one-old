// src/shared/hook/trace.ts
// Off-by-default diagnostic. When enabled, append one JSON line per hook
// invocation capturing the SHAPE of what the host piped in, the parsed canonical
// input, the run-agent identity the plugin resolves, the effective team.mode /
// performance.level, the run-claim files on disk, and a filtered slice of env.
// Purpose: determine what identity signal Codex actually delivers to per-tool-call
// hooks (subagent thread id / parent / env var) before committing to an
// identity-recovery mechanism — see the Phase 0 plan.
//
// Contract, in three parts:
//  1. Never throws — preserves the always-exit-0 hook contract.
//  2. Never affects the hook outcome — every failure is swallowed.
//  3. Never records payload VALUES. Env is allowlisted by name, denied by
//     secret-shaped name, and value-truncated. The host payload is reduced to a
//     key/type shape (payloadShape) and its byte count: this file used to append
//     up to 8KB of the RAW stdin instead, which is the entire text of a `Write`
//     (a `.env` body, verbatim) or a `Bash` command line (an inline bearer
//     token), written to a plain JSONL file inside the user's project. The
//     identity question above is answered by WHICH keys a host sends and where
//     they sit, never by their contents, so the values buy the diagnostic
//     nothing. File PATHS are still recorded (tool.filePath) — they are how a
//     line is correlated with a run; file CONTENTS never are.

import * as fs from 'fs';
import * as path from 'path';

import type { HookInput } from '../../core/types';
import { obj, type Rec } from '../obj';
import { paths } from '../paths';
import { globalTrafficOneDir } from '../state-root';
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

// The marker channel exists for hosts (e.g. Codex Desktop) that do not forward
// shell env to hook subprocesses, so the env var alone cannot arm the trace there.
// It lives in the PER-USER Traffic One directory and NOT in the project, because
// the project copy it replaces (`.traffic-one/debug/trace.on`) sat inside an
// agent's ordinary write surface: measured against the real gate registry,
// `check-plan-write` ALLOWS both a `Write` and a `touch` of that path while
// DENYING an ordinary source write on the same fixture, and nothing anywhere
// treats `.traffic-one/debug/**` as protected.
//
// Measure the relocation buys, exactly — no more: on a host that reports a
// workspace root (Cursor), workspaceBoundaryGuard DENIES a Write to this path and
// allows the in-project one; on a host that reports none (Claude/Codex) that guard
// stands down for both, and the only remaining friction is the host's own
// out-of-workspace prompt. So this raises the cost of arming the trace, it does
// not make it impossible — which is why the record itself was made worthless to
// an attacker (contract 3 above) rather than merely harder to switch on. No
// in-project file can be made agent-proof; a per-user one at least is not part of
// the surface an agent writes to in the course of ordinary work.
export function hookTraceMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalTrafficOneDir(env), 'debug', 'hook-trace.on');
}

function traceEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.TRAFFIC_ONE_HOOK_TRACE) return true;
  try {
    return fs.existsSync(hookTraceMarkerPath(env));
  } catch {
    return false;
  }
}

// A value-free description of the raw host payload: which keys arrived, nested
// where, of what type and what size. Never a value — see the contract at the top
// of this file. Depth 2 is enough to show `tool_input`'s key set (the question
// "does this host deliver a thread id, and under which envelope key?") without
// walking into a payload whose leaves are user data.
const SHAPE_MAX_KEYS = 60;

function describe(value: unknown, depth: number): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  switch (typeof value) {
    case 'string': return `string(${value.length})`;
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return depth > 0 ? shapeOf(value as Rec, depth - 1) : 'object';
    default: return typeof value;
  }
}

function shapeOf(value: Rec, depth: number): Rec {
  const out: Rec = {};
  let count = 0;
  for (const [name, inner] of Object.entries(value)) {
    if (count >= SHAPE_MAX_KEYS) {
      out['…'] = `${Object.keys(value).length - count} more keys`;
      break;
    }
    out[name] = describe(inner, depth);
    count += 1;
  }
  return out;
}

function payloadShape(stdin: string): Rec {
  const bytes = Buffer.byteLength(stdin, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin) as unknown;
  } catch {
    return { bytes, parsed: false };
  }
  const record = obj(parsed);
  if (!record) return { bytes, parsed: true, keys: describe(parsed, 0) };
  return { bytes, parsed: true, keys: shapeOf(record, 1) };
}

export function maybeTraceHook(input: HookInput, stdin: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const projectRoot = paths.projectRoot(input);
    if (!traceEnabled(env)) return;

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
      // Named for what it is. A field called `stdin` holding an object invites
      // the next reader to "restore" the raw text it looks like it lost.
      stdinShape: payloadShape(stdin),
    };

    const dir = path.join(projectRoot, '.traffic-one', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'hook-trace.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Diagnostics must never affect the hook outcome.
  }
}
