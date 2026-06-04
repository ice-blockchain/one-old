// src/shared/onboarding-server/ensure.ts
// Idempotent launcher for the detached onboarding wizard server, called from the
// synchronous PreToolUse gate. Reuse path: a recorded pid that is still alive ⇒
// return its URL (no spawn). Otherwise spawn the detached server (same pattern as
// the one-mcp report worker: detached + unref) and block-poll the registry file
// for the child to publish its {port,url} after listen(). The wait is a short
// synchronous Atomics sleep so the hook stays a plain sync function.

import { spawn } from 'child_process';
import * as path from 'path';

import { pluginRoot } from '../paths';
import { writeLaunchConfig } from './launch-config';
import { clearServerRecord, readServerRecord } from './registry';

export interface EnsureResult {
  url: string;
  port: number;
  token: string;
  started: boolean;
}

export interface EnsureOptions {
  env?: NodeJS.ProcessEnv;
  isAlive?: (pid: number) => boolean;
  launch?: (cwd: string, env: NodeJS.ProcessEnv) => number;
  readyTimeoutMs?: number;
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH ⇒ no such process; EPERM ⇒ exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // SharedArrayBuffer disabled — re-poll immediately rather than busy-spin.
  }
}

function defaultLaunch(cwd: string, env: NodeJS.ProcessEnv): number {
  const entry = env.TRAFFIC_ONE_ONBOARDING_SERVER_ENTRY
    || path.join(pluginRoot(), 'scripts', 'onboarding-server.cjs');
  const child = spawn(process.execPath, [entry, cwd], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...env },
  });
  child.unref();
  return typeof child.pid === 'number' ? child.pid : -1;
}

export function ensureOnboardingServer(cwd: string, options: EnsureOptions = {}): EnsureResult {
  const env = options.env || process.env;
  const isAlive = options.isAlive || processAlive;
  const launch = options.launch || defaultLaunch;

  // Register the in-app preview entry (.claude/launch.json) SYNCHRONOUSLY before
  // returning, so preview_start finds it the instant the gate denies — never rely
  // on the detached child's own async self-registration having landed yet. No-op
  // for port 0 (the NO_SPAWN placeholder skips this entirely).
  const finalize = (result: EnsureResult): EnsureResult => {
    if (result.port > 0) writeLaunchConfig(cwd, result.port);
    return result;
  };

  const existing = readServerRecord(cwd, env);
  if (existing && isAlive(existing.pid)) {
    return finalize({ url: existing.url, port: existing.port, token: existing.token, started: false });
  }

  // Test/CI guard (mirrors TRAFFIC_ONE_ONE_MCP_NO_SPAWN): never spawn a real
  // detached server. Reuse a pre-seeded record if present, else hand back a
  // placeholder URL so the gate can still render its deny prose deterministically.
  if (env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN === '1') {
    if (existing) return { url: existing.url, port: existing.port, token: existing.token, started: false };
    return { url: 'http://127.0.0.1:0/?t=pending', port: 0, token: '', started: false };
  }

  if (existing) clearServerRecord(cwd, env);

  const childPid = launch(cwd, env);
  const deadline = Date.now() + (options.readyTimeoutMs ?? 4000);
  for (;;) {
    const rec = readServerRecord(cwd, env);
    if (rec && (childPid <= 0 || rec.pid === childPid)) {
      return finalize({ url: rec.url, port: rec.port, token: rec.token, started: true });
    }
    if (Date.now() >= deadline) {
      if (rec) return finalize({ url: rec.url, port: rec.port, token: rec.token, started: true });
      throw new Error('traffic-one onboarding server did not become ready');
    }
    sleepSync(50);
  }
}
