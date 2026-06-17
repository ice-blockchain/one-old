// src/shared/onboarding-server/ensure.ts
// Idempotent launcher for the detached onboarding wizard server, called from the
// synchronous PreToolUse gate. Reuse path: a recorded pid that is still alive ⇒
// return its URL (no spawn). Otherwise spawn the detached server (same pattern as
// the one-mcp report worker: detached + unref) and block-poll the registry file
// for the child to publish its {port,url} after listen(). The wait is a short
// synchronous Atomics sleep so the hook stays a plain sync function.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { isPluginAuthoringRoot } from '../authoring-root';
import { pluginRoot } from '../paths';
import { writeLaunchConfig } from './launch-config';
import { clearServerRecord, readServerRecord, serverLockPath } from './registry';

// A launch lock older than this is presumed abandoned (holder crashed between
// claiming and publishing the record) and may be stolen — a generous multiple of
// the ~4s ready window so a merely-slow launcher is never stolen from.
const LOCK_STALE_MS = 15000;

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

// Append the live wizard URL to a setup banner ONLY where the recipe otherwise
// reaches the user through an agent-only channel that the agent might not repost —
// on Cursor, a context() result's prose rides additional_context (agent-facing); the
// user sees only systemMessage→user_message. So Cursor gets the clickable URL in the
// banner; other hosts (Claude preview pane, Codex recipe) keep the plain banner. The
// NO_SPAWN placeholder (':0/', port 0) is never surfaced. Single source for both the
// SessionStart and UserPromptSubmit setup-pending paths.
export function formatWizardBanner(host: string, url: string, banner: string): string {
  return host === 'cursor' && url && !url.includes(':0/')
    ? `${banner} — open the setup wizard: ${url}`
    : banner;
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

// Try to become the single launcher. Returns true if we hold the lock (must spawn);
// false if a LIVE holder is mid-launch (we should wait for its record and reuse it).
// A lock whose holder pid is dead — or that is older than LOCK_STALE_MS — is stolen.
// The lock is a SENTINEL (existence-only), so an atomic O_EXCL create is sufficient —
// unlike the server RECORD (registry.ts), which is read back by other processes and
// therefore needs temp+rename to never expose a partial/torn read.
function acquireLaunchLock(lockPath: string, isAlive: (pid: number) => boolean): boolean {
  const claim = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_EXCL — atomic create-if-absent
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true; // can't lock (perms) → proceed best-effort
      return false;
    }
  };
  if (claim()) return true;
  // Lock exists — steal it only if the holder is dead or the claim is stale.
  let holderPid = 0;
  let claimedAt = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    holderPid = Number(raw.pid);
    claimedAt = Number(raw.at);
  } catch {
    // unreadable/torn lock → treat as stealable
  }
  const stale = !Number.isInteger(holderPid) || holderPid <= 0 || !isAlive(holderPid)
    || (Number.isFinite(claimedAt) && Date.now() - claimedAt > LOCK_STALE_MS);
  if (!stale) return false; // a live launcher owns it → wait
  try { fs.unlinkSync(lockPath); } catch { /* raced away */ }
  return claim();
}

function releaseLaunchLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* already released */ }
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

  // The plugin's own repo/install never onboards: no server spawn, no
  // .claude/launch.json, no registry record — hand back the inert placeholder.
  if (isPluginAuthoringRoot(cwd)) {
    return { url: 'http://127.0.0.1:0/?t=pending', port: 0, token: '', started: false };
  }

  // Register the in-app preview entry (.claude/launch.json) SYNCHRONOUSLY before
  // returning, so preview_start finds it the instant the gate denies — never rely
  // on the detached child's own async self-registration having landed yet. No-op
  // for port 0 (the NO_SPAWN placeholder skips this entirely).
  const finalize = (result: EnsureResult): EnsureResult => {
    if (result.port > 0) writeLaunchConfig(cwd, result.port);
    return result;
  };

  // Reuse a live server (its pid is alive) — no spawn.
  const reuseIfLive = (): EnsureResult | null => {
    const rec = readServerRecord(cwd, env);
    return rec && isAlive(rec.pid)
      ? finalize({ url: rec.url, port: rec.port, token: rec.token, started: false })
      : null;
  };

  const existing = readServerRecord(cwd, env);
  const live0 = reuseIfLive();
  if (live0) return live0;

  // Test/CI guard (mirrors TRAFFIC_ONE_ONE_MCP_NO_SPAWN): never spawn a real
  // detached server. Reuse a pre-seeded record if present, else hand back a
  // placeholder URL so the gate can still render its deny prose deterministically.
  if (env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN === '1') {
    if (existing) return { url: existing.url, port: existing.port, token: existing.token, started: false };
    return { url: 'http://127.0.0.1:0/?t=pending', port: 0, token: '', started: false };
  }

  // Single-launcher: each Cursor hook is its own process, so UserPromptSubmit and
  // the first PreToolUse can fire concurrently and BOTH spawn a server on different
  // ephemeral ports — the loser is orphaned and the URL baked into a deny goes dead.
  // Only the O_EXCL lock holder spawns; everyone else waits for the record it
  // publishes and reuses that live URL. acquireLaunchLock already STEALS a dead/stale
  // holder's lock, so a persistent `false` means a LIVE holder is mid-launch — we
  // then wait for ITS record and never spawn a second server.
  const lockPath = serverLockPath(cwd, env);
  const deadline = Date.now() + (options.readyTimeoutMs ?? 4000);
  let holding = acquireLaunchLock(lockPath, isAlive);
  while (!holding) {
    const live = reuseIfLive();
    if (live) return live;
    if (Date.now() >= deadline) break; // a live holder kept the lock the whole window
    sleepSync(50);
    holding = acquireLaunchLock(lockPath, isAlive);
  }

  try {
    // Re-check: a just-finished launcher may have published a live record while we
    // were acquiring/waiting (covered by the finally — releases only a lock WE hold).
    const live = reuseIfLive();
    if (live) return live;
    if (!holding) {
      // We never won the lock and the holder didn't publish within the window. Do
      // NOT double-launch: surface the in-flight record if it has landed, else fail.
      const rec = readServerRecord(cwd, env);
      if (rec) return finalize({ url: rec.url, port: rec.port, token: rec.token, started: true });
      throw new Error('traffic-one onboarding server did not become ready (another launcher holds the lock)');
    }
    const stale = readServerRecord(cwd, env);
    if (stale) clearServerRecord(cwd, env);

    const childPid = launch(cwd, env);
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
  } finally {
    if (holding) releaseLaunchLock(lockPath); // never unlink a lock another process owns
  }
}
