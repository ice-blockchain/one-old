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

import { isNonProjectRoot } from '../authoring-root';
import { agentOnboardingUrls } from '../../config/dashboard';
import type { HostId } from '../../core/types';
import { detectHost } from '../host';
import { pluginRoot } from '../paths';
import { resolveTrafficOneEnv } from '../state/traffic-one-paths';
import type { LocalFallback } from './wizard-links';
import { clearLegacyOnboardingRuntime, clearServerRecord, readServerRecord, serverLockPath } from './registry';

// A launch lock older than this is presumed abandoned (holder crashed between
// claiming and publishing the record) and may be stolen — a generous multiple of
// the ~4s ready window so a merely-slow launcher is never stolen from.
const LOCK_STALE_MS = 15000;

export interface EnsureResult {
  // Hosted dashboard entry surfaced first.
  dashboardUrl: string;
  // Direct loopback wizard used when the hosted route is unavailable.
  localWizardUrl: string;
  // Loopback root retained for auto-open/registry behavior. It redirects to the
  // dashboard and therefore must never be presented as the local fallback.
  redirectUrl: string;
  port: number;
  token: string;
  started: boolean;
}

export interface EnsureOptions {
  env?: NodeJS.ProcessEnv;
  isAlive?: (pid: number) => boolean;
  launch?: (cwd: string, env: NodeJS.ProcessEnv, host?: string) => number;
  readyTimeoutMs?: number;
  // Active host, stamped as `--host=<id>` on the spawned server so its flow's
  // detectHost() is authoritative (env markers aren't set for this subprocess).
  // Without it the wizard defaults to 'claude' and shows host-specific steps that
  // should be hidden — e.g. the OpenCode-delegation opt-in on the OpenCode host.
  host?: string;
}

// Append the setup link to a banner. The onboarding UI lives on the traffic.io
// dashboard and the USER opens it themselves in their browser on EVERY host, so any
// host with a non-empty dashboard URL surfaces it. The placeholder (port 0 → empty
// dashboardUrl) is never surfaced. Single source for both the SessionStart and
// UserPromptSubmit setup-pending paths.
//
// `localFallback` is a rendered fragment, empty when the hosted dashboard probed
// healthy — a working page earns exactly one link, not two. Typed as LocalFallback
// so a raw localWizardUrl cannot be passed here by accident.
export function formatWizardBanner(
  _host: string,
  dashboardUrl: string,
  localFallback: LocalFallback,
  banner: string,
): string {
  if (!dashboardUrl) return banner;
  const base = `${banner} — open Traffic One setup: ${dashboardUrl}`;
  return localFallback ? `${base} — ${String(localFallback)}` : base;
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
      // A permission/storage error means we do NOT own the lock. Propagate it so
      // the gate can emit the approved bootstrap path immediately; pretending we
      // acquired it only delays the same failure until spawn/registry timeout.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
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

function defaultLaunch(cwd: string, env: NodeJS.ProcessEnv, host?: string): number {
  const entry = env.TRAFFIC_ONE_ONBOARDING_SERVER_ENTRY
    || path.join(pluginRoot(), 'scripts', 'onboarding-server.cjs');
  // Stamp the host so the server's flow detectHost() resolves it (env markers
  // like CURSOR_PLUGIN_ROOT/CODEX_* aren't set for this detached subprocess).
  const args = host ? [entry, cwd, `--host=${host}`] : [entry, cwd];
  const child = spawn(process.execPath, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...env },
  });
  child.unref();
  return typeof child.pid === 'number' ? child.pid : -1;
}

export function ensureOnboardingServer(cwd: string, options: EnsureOptions = {}): EnsureResult {
  const baseEnv = options.env || process.env;
  const host = (options.host || detectHost(baseEnv)) as HostId;
  const env = resolveTrafficOneEnv(cwd, host, baseEnv);
  const isAlive = options.isAlive || processAlive;
  const launch = options.launch || defaultLaunch;

  // The inert placeholder (authoring root, NO_SPAWN with no seeded record): no
  // server, no dashboard link.
  const placeholder = (): EnsureResult =>
    ({ ...agentOnboardingUrls(env, 0, ''), port: 0, token: '', started: false });

  // The plugin's own repo/install never onboards: no server spawn, no registry
  // record — hand back the inert placeholder.
  if (isNonProjectRoot(cwd)) {
    return placeholder();
  }

  // Stamps the dashboard deep link (fragment-carried port+token) that the gate
  // surfaces. No host gets an in-app preview entry: Traffic One never opens the
  // wizard for the user, it hands them a link to click.
  const finalize = (result: { port: number; token: string; started: boolean }): EnsureResult =>
    ({ ...result, ...agentOnboardingUrls(env, result.port, result.token) });

  clearLegacyOnboardingRuntime(cwd, env);

  // Reuse a live server (its pid is alive) — no spawn.
  const reuseIfLive = (): EnsureResult | null => {
    const rec = readServerRecord(cwd, env, host);
    return rec && isAlive(rec.pid)
      ? finalize({ port: rec.port, token: rec.token, started: false })
      : null;
  };

  const existing = readServerRecord(cwd, env, host);
  const live0 = reuseIfLive();
  if (live0) return live0;

  // Test/CI guard (mirrors TRAFFIC_ONE_ONE_MCP_NO_SPAWN): never spawn a real
  // detached server. Reuse a pre-seeded record if present, else hand back a
  // placeholder URL so the gate can still render its deny prose deterministically.
  if (env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN === '1') {
    if (existing) return finalize({ port: existing.port, token: existing.token, started: false });
    return placeholder();
  }

  // Single-launcher: each Cursor hook is its own process, so UserPromptSubmit and
  // the first PreToolUse can fire concurrently and BOTH spawn a server on different
  // ephemeral ports — the loser is orphaned and the URL baked into a deny goes dead.
  // Only the O_EXCL lock holder spawns; everyone else waits for the record it
  // publishes and reuses that live URL. acquireLaunchLock already STEALS a dead/stale
  // holder's lock, so a persistent `false` means a LIVE holder is mid-launch — we
  // then wait for ITS record and never spawn a second server.
  const lockPath = serverLockPath(cwd, env, host);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
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
      const rec = readServerRecord(cwd, env, host);
      if (rec) return finalize({ port: rec.port, token: rec.token, started: true });
      throw new Error('traffic-one onboarding server did not become ready (another launcher holds the lock)');
    }
    const stale = readServerRecord(cwd, env, host);
    if (stale) clearServerRecord(cwd, env, host);

    const childPid = launch(cwd, env, options.host || host);
    for (;;) {
      const rec = readServerRecord(cwd, env, host);
      if (rec && (childPid <= 0 || rec.pid === childPid)) {
        return finalize({ port: rec.port, token: rec.token, started: true });
      }
      if (Date.now() >= deadline) {
        if (rec) return finalize({ port: rec.port, token: rec.token, started: true });
        throw new Error('traffic-one onboarding server did not become ready');
      }
      sleepSync(50);
    }
  } finally {
    if (holding) releaseLaunchLock(lockPath); // never unlink a lock another process owns
  }
}
