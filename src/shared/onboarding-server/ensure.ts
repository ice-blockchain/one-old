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
import { trustworthyAgeSince } from '../clock-skew';
import { agentOnboardingUrls } from '../../config/dashboard';
import type { HostId } from '../../core/types';
import { detectHost } from '../host';
import { pluginRoot } from '../paths';
import { resolveTrafficOneEnv } from '../state/traffic-one-paths';
import type { LocalFallback } from './wizard-links';
import { clearLegacyOnboardingRuntime, clearServerRecord, readServerRecord, serverLockPath } from './registry';
import { readRegularFileOrThrow } from '../bounded-read';

// A launch lock older than this is presumed abandoned (holder crashed between
// claiming and publishing the record) and may be stolen — a generous multiple of
// the ready window below so a merely-slow launcher is never stolen from.
const LOCK_STALE_MS = 15000;

// TWO budgets, deliberately independent. They used to be ONE deadline computed
// before the lock-acquisition loop and reused by the post-launch readiness poll,
// so a wait loop that burned the whole window left the first post-launch check
// firing IMMEDIATELY: routine contention — documented as NORMAL directly above
// the lock code — made launch() throw instantly, and that throw was classified
// as a terminal packaging failure telling the user to reinstall the plugin.
// Contention must not be able to spend readiness' budget.
//
// Both numbers are derived from the same measurement: spawn → record-published
// for the real built server on this machine. Idle (n=15): median 290ms, max
// 866ms. Eight concurrent spawns against a machine already running up to 24
// sibling servers (n=32): median 695ms, p90 1838ms, max 2140ms.
//
// READY_TIMEOUT_MS covers OUR OWN child's start and stays at the field-proven
// 4000ms — 1.9x the worst start observed under heavy load, ~14x the idle
// median. Nothing measured argues it is too small; it was only ever too small
// because it was being spent elsewhere.
//
// LOCK_WAIT_TIMEOUT_MS covers a PEER publishing its record, the same
// distribution seen from a second process. 2000ms rather than another 4000ms
// because exhausting it is not a failure worth paying for: three of the four
// exits from the wait loop are early and cheap (the peer publishes → reuse; the
// peer's pid dies → the lock is stolen on the next 50ms poll → we spawn with a
// FULL readiness budget; the peer releases normally → same). Only a LIVE peer
// that holds the lock for the entire window without publishing spends all of
// it, and that case is now a RETRYABLE timeout whose retry reuses the peer's
// record in milliseconds — so a shorter window buys a faster, correct recovery
// where a longer one would only buy a slower hook. Worst-case total is 6s.
const LOCK_WAIT_TIMEOUT_MS = 2000;
const READY_TIMEOUT_MS = 4000;

// The launcher timed out — a fact about TIME, not about the installation. Carried
// as an errno-shaped `code` so bootstrap.ts can tell it apart from the genuine
// packaging failures (a missing runner, an unusable state root) that share the
// non-permission branch and are correctly terminal.
export const ONBOARDING_START_TIMEOUT_CODE = 'START_TIMEOUT';

function startTimeoutError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: ONBOARDING_START_TIMEOUT_CODE });
}

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

interface EnsureOptions {
  env?: NodeJS.ProcessEnv;
  isAlive?: (pid: number) => boolean;
  launch?: (cwd: string, env: NodeJS.ProcessEnv, host?: string) => number;
  // How long OUR spawned child gets to publish its record. Measured from AFTER
  // launch() returns, so the spawn syscall never eats into it either.
  readyTimeoutMs?: number;
  // How long a CONCURRENT launcher gets to publish its record before we stop
  // waiting for it. Separate from readyTimeoutMs so contention can never leave
  // the readiness poll with nothing to spend.
  lockWaitTimeoutMs?: number;
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
    const raw = JSON.parse(readRegularFileOrThrow(lockPath));
    holderPid = Number(raw.pid);
    claimedAt = Number(raw.at);
  } catch {
    // unreadable/torn lock → treat as stealable
  }
  // The age clause is the ONLY escape from a lock whose holder pid still answers
  // `kill(pid, 0)` — an orphaned lock file (holder SIGKILLed, so its `finally`
  // never ran) whose pid has since been REUSED by an unrelated process. This
  // lock file lives in the state root and outlives reboots, so a stamp ahead of
  // now — which makes the difference negative and thus never `> STALE` — turns
  // that into onboarding never launching again on this machine. An age no clock
  // could have produced therefore counts as stale here. Accepted trade: under a
  // backwards clock step a genuinely mid-flight launcher can be stolen from,
  // costing one duplicate server — and only if it is ALSO not yet published,
  // since the reuseIfLive() re-check after acquisition returns the victim's
  // record when it landed first; a permanent wedge of onboarding is worse.
  //
  // An ABSENT or non-numeric stamp counts as stale for the same reason, measured
  // rather than assumed: with a reused pid the age clause is the only escape, and
  // while it abstained a `{"pid":<live>}` record spent the whole 1000ms wait
  // window and launched NOTHING, on every call, forever; once it counts, the
  // steal is immediate and the call launches. Nothing else recovers it — no
  // reaper, no run-id rotation, and the lock sits in the per-project HOME state
  // root — whereas a record that does not parse at ALL is already stolen here
  // (`holderPid` stays 0 above), so a record that parses with no usable stamp
  // cannot defensibly be the stronger claim. This does not widen theft from any
  // lock this tree writes: a killed writer leaves a byte PREFIX of the JSON,
  // which never parses, so the shape is only reachable from outside (see
  // __tests__/lock-absent-stamp.test.ts, which pins that, the live-holder control
  // on both stamp directions, and the published-victim bound above).
  const claimAgeMs = trustworthyAgeSince(claimedAt, Date.now());
  const stale = !Number.isInteger(holderPid) || holderPid <= 0 || !isAlive(holderPid)
    || claimAgeMs === null || claimAgeMs > LOCK_STALE_MS;
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
  // A missing runner is the canonical PACKAGING failure, and spawn() cannot
  // report it: `node <absent file>` spawns fine and dies asynchronously, so the
  // only symptom used to be the readiness timeout — which is now retryable, and
  // retrying a broken install is pointless. Check the one thing that separates
  // the two before spawning, so a missing runner stays terminal and immediate.
  if (!fs.existsSync(entry)) {
    throw Object.assign(
      new Error(`traffic-one onboarding server runner is missing: ${entry}`),
      { code: 'ENOENT' },
    );
  }
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

  // Test/CI guard: never spawn a real detached server. Reuse a pre-seeded
  // record if present, else hand back a placeholder URL so the gate can still
  // render its deny prose deterministically.
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
  const lockWaitDeadline = Date.now() + (options.lockWaitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS);
  let holding = acquireLaunchLock(lockPath, isAlive);
  while (!holding) {
    const live = reuseIfLive();
    if (live) return live;
    if (Date.now() >= lockWaitDeadline) break; // a live holder kept the lock the whole window
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
      // NOT double-launch: surface the in-flight record if it landed in the gap
      // between the reuse check above and this read, else report a TIMEOUT.
      //
      // The liveness check is not redundant with reuseIfLive(): without it this
      // branch could only ever be taken for a record whose pid reuseIfLive had
      // just proved DEAD, so the one thing it reliably did was hand the agent a
      // URL pointing at a corpse, stamped `started: true` — a link the agent then
      // posts to the user. What it is actually for is the microsecond race, and
      // that record is live.
      const late = readServerRecord(cwd, env, host);
      if (late && isAlive(late.pid)) {
        return finalize({ port: late.port, token: late.token, started: true });
      }
      throw startTimeoutError('traffic-one onboarding server did not become ready (another launcher holds the lock)');
    }
    const stale = readServerRecord(cwd, env, host);
    if (stale) clearServerRecord(cwd, env, host);

    const childPid = launch(cwd, env, options.host || host);
    // Started AFTER launch() so neither the contention wait above nor the spawn
    // syscall itself can spend our child's window.
    const readyDeadline = Date.now() + (options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      const rec = readServerRecord(cwd, env, host);
      if (rec && (childPid <= 0 || rec.pid === childPid)) {
        return finalize({ port: rec.port, token: rec.token, started: true });
      }
      if (Date.now() >= readyDeadline) {
        // A record belonging to someone ELSE (rec.pid !== childPid). Worth
        // surfacing, but only while its process is actually alive — same reason
        // as the lock-contention branch above.
        if (rec && isAlive(rec.pid)) return finalize({ port: rec.port, token: rec.token, started: true });
        throw startTimeoutError('traffic-one onboarding server did not become ready');
      }
      sleepSync(50);
    }
  } finally {
    if (holding) releaseLaunchLock(lockPath); // never unlink a lock another process owns
  }
}
