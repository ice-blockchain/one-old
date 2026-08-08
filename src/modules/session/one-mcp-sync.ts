// Synchronous SessionStart bridge to the asynchronous, best-effort public MCP
// config worker. Exact opt-in is checked before spawning; the worker checks it
// again so a stale caller can never bypass the project preference.

import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_MAX_RESPONSE_BYTES,
  ONE_MCP_SESSION_SYNC_TIMEOUT_MS,
  ONE_MCP_SYNC,
} from '../../config/one-mcp';
import { usableOneMcpConfigCacheEntry } from '../../shared/current-model-tiers';
import { canonicalHost } from '../../shared/model-tiers';
import {
  claimOneMcpWarningKey,
  readOneMcpCache,
  readOneMcpConfigCacheEntry,
  type OneMcpLastSync,
} from '../../shared/one-mcp/cache';
import { firstEmitThisSession } from '../../shared/once';
import { pluginRoot } from '../../shared/paths';
import { pluginUseEnabled } from '../../shared/state/plugin-use';

type Spawn = typeof spawnSync;
type SpawnDetached = typeof spawn;

export type SessionOneMcpSync = (
  cwd: string,
  host: unknown,
  env: NodeJS.ProcessEnv,
) => unknown;

type SessionWarningDiagnostic = OneMcpLastSync & {
  outcome: 'invalid-response' | 'config-not-found';
};

/**
 * A `SessionOneMcpSync` is declared as returning `unknown` because its
 * implementations answer with different shapes (a SpawnSyncReturns, an
 * OneMcpSyncStart, and whatever a test double hands back). Anything that is not
 * an OneMcpSyncStart reached the worker and blocked on it, which is exactly
 * what `completed` means.
 */
function asSyncStart(value: unknown): OneMcpSyncStart {
  if (value && typeof value === 'object' && typeof (value as { kind?: unknown }).kind === 'string') {
    const kind = (value as { kind: string }).kind;
    if (kind === 'completed' || kind === 'detached' || kind === 'skipped' || kind === 'unavailable') {
      return value as OneMcpSyncStart;
    }
  }
  return { kind: 'completed' };
}

function canonicalProjectRoot(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function syncOneMcpForSession(
  cwd: string,
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
  spawn: Spawn = spawnSync,
  runnerPath?: string,
  featureEnabled?: boolean,
): SpawnSyncReturns<string> | null {
  if (!(featureEnabled ?? ONE_MCP_SYNC) || !pluginUseEnabled(cwd, env)) return null;
  const runner = runnerPath || path.resolve(pluginRoot(), 'scripts', 'one-mcp-sync.cjs');
  if (!fs.existsSync(runner)) return null;
  try {
    return spawn(process.execPath, [runner, canonicalHost(host), cwd], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: ONE_MCP_SESSION_SYNC_TIMEOUT_MS,
      maxBuffer: ONE_MCP_MAX_RESPONSE_BYTES,
    }) as SpawnSyncReturns<string>;
  } catch {
    return null;
  }
}

/**
 * What starting the session sync actually did.
 *
 * The shape follows `readJsonResult`'s `JsonRead` (shared/fsjson.ts): a `kind`
 * discriminant, and the historical boolean/nullable signature kept as a thin
 * wrapper over it so no existing call site has to churn. The reason it is here
 * at all is that `syncOneMcpForSession` answered `null` for FOUR unrelated
 * situations — the build flag is off, the project never opted in, the runner is
 * missing from the install, and the spawn itself threw — and every caller in
 * this repo discards that value, so a damaged install (no
 * `scripts/one-mcp-sync.cjs`) is currently indistinguishable at every call site
 * from a project that deliberately opted out. That is the dropped-refusal shape
 * tests/refusal-contract.test.ts exists for.
 *
 * `detached` is NOT a weaker `completed`: it means the cache this invocation
 * goes on to read is the one the PREVIOUS sync left, and the child's write
 * lands after this hook has returned. See sessionOneMcpSyncMode.
 */
export type OneMcpSyncStart =
  | { readonly kind: 'completed' }
  | { readonly kind: 'detached' }
  | {
    readonly kind: 'skipped';
    readonly reason: 'feature-disabled' | 'plugin-use-not-enabled' | 'already-started-this-session';
  }
  | { readonly kind: 'unavailable'; readonly reason: 'runner-missing' | 'spawn-refused' };

/**
 * Fire the worker DETACHED and return immediately.
 *
 * Same guards, same argv and same runner-existence check as
 * `syncOneMcpForSession`; the only difference is that the parent does not wait.
 * `detached: true` + `stdio: 'ignore'` + `unref()` is this repo's established
 * shape for exactly this — session-start-lib.ts's code-graph self-heal (:250)
 * and OpenCode install heal (:366), onboarding-server/ensure.ts (:228) and
 * one-mcp-report/prepareReport.ts (:110) all spawn that way from a hook path,
 * and the code-graph one names "the onboarding server / one-mcp worker" as the
 * pattern it is copying.
 *
 * No parent-side `timeout` is passed and none is needed: nothing waits on this
 * child, so there is no parent-side hang to bound. The CHILD is self-bounded by
 * the same budget the removed `spawnSync` timeout was derived from —
 * ONE_MCP_SESSION_SYNC_TIMEOUT_MS is literally `ONE_MCP_TIMEOUT_MS * 2 + 1_000`
 * (config/one-mcp.ts), i.e. the runner's own two bounded HTTP attempts, and
 * shared/one-mcp/sync.ts bounds every one of its own steps.
 */
export function syncOneMcpDetached(
  cwd: string,
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
  spawnDetached: SpawnDetached = spawn,
  runnerPath?: string,
  featureEnabled?: boolean,
): OneMcpSyncStart {
  if (!(featureEnabled ?? ONE_MCP_SYNC)) return { kind: 'skipped', reason: 'feature-disabled' };
  if (!pluginUseEnabled(cwd, env)) return { kind: 'skipped', reason: 'plugin-use-not-enabled' };
  const runner = runnerPath || path.resolve(pluginRoot(), 'scripts', 'one-mcp-sync.cjs');
  if (!fs.existsSync(runner)) return { kind: 'unavailable', reason: 'runner-missing' };
  try {
    const child = spawnDetached(process.execPath, [runner, canonicalHost(host), cwd], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { kind: 'detached' };
  } catch {
    return { kind: 'unavailable', reason: 'spawn-refused' };
  }
}

/**
 * Block, or detach?
 *
 * BLOCK only when this host has no usable cached config at all. That is the one
 * case where waiting buys something a later session cannot: with no cache the
 * fallback is the BUNDLED catalog (shared/one-mcp/sync.ts's bundledTarget), so
 * every model-tier read in this same invocation — agent-model's session-start
 * handler, session/triage-directive.ts, and the gates below them, all through
 * shared/current-model-tiers.ts — would answer from bundled data. Detaching
 * there would trade a bounded wait for a whole session of wrong tiers.
 *
 * DETACH whenever a usable entry exists, which after the first successful sync
 * on a machine is every session: the sync is a REFRESH, the readers already
 * have a real catalog to read, and the only thing the wait buys is that the
 * refresh is one session earlier. Measured cost of that wait: SessionStart
 * blocks with a factor of 1.03-1.06 on the runner's whole runtime, bounded only
 * by ONE_MCP_SESSION_SYNC_TIMEOUT_MS = 21_000 ms.
 *
 * `usableOneMcpConfigCacheEntry` is the same predicate shared/one-mcp/sync.ts
 * and runners/doctor/probes.ts use to decide whether cached config may be
 * served, so "usable" cannot drift between the decision to wait and the readers
 * the wait exists for.
 */
export function sessionOneMcpSyncMode(
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
): 'blocking' | 'detached' {
  try {
    const canonical = canonicalHost(host);
    return usableOneMcpConfigCacheEntry(canonical, readOneMcpConfigCacheEntry(canonical, env))
      ? 'detached'
      : 'blocking';
  } catch {
    // An unreadable cache is not a usable one: fall back to the behaviour that
    // does not depend on the cache being right.
    return 'blocking';
  }
}

/**
 * The SessionStart hook's sync entry: detached in steady state, blocking on a
 * cold cache. The onboarding-wait runner deliberately does NOT use this — see
 * runners/onboarding-wait/consent.ts, where `computeOnboarding` reads the tiers
 * the sync refreshes and the wait is the guarantee.
 */
export function syncOneMcpForSessionStart(
  cwd: string,
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readonly spawnDetached?: SpawnDetached;
    readonly spawnBlocking?: Spawn;
    readonly runnerPath?: string;
    readonly featureEnabled?: boolean;
  } = {},
): OneMcpSyncStart {
  if (sessionOneMcpSyncMode(host, env) === 'detached') {
    return syncOneMcpDetached(cwd, host, env, deps.spawnDetached, deps.runnerPath, deps.featureEnabled);
  }
  if (!(deps.featureEnabled ?? ONE_MCP_SYNC)) return { kind: 'skipped', reason: 'feature-disabled' };
  if (!pluginUseEnabled(cwd, env)) return { kind: 'skipped', reason: 'plugin-use-not-enabled' };
  const runner = deps.runnerPath || path.resolve(pluginRoot(), 'scripts', 'one-mcp-sync.cjs');
  if (!fs.existsSync(runner)) return { kind: 'unavailable', reason: 'runner-missing' };
  return syncOneMcpForSession(cwd, host, env, deps.spawnBlocking, runner, deps.featureEnabled)
    ? { kind: 'completed' }
    : { kind: 'unavailable', reason: 'spawn-refused' };
}

// Shared parent-session/runner gate. A stable identity deduplicates every hook
// and onboarding-wait surface for the same canonical project + host + session.
// Some hosts do not expose one; those calls deliberately run again because the
// cache worker's lock + CAS protocol makes the duplicate harmless.
export function syncOneMcpOnceResult(
  cwd: string,
  host: unknown,
  identity: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  sync: SessionOneMcpSync = syncOneMcpForSession,
  featureEnabled?: boolean,
): OneMcpSyncStart {
  const root = canonicalProjectRoot(cwd);
  // Guard order preserved from the boolean original: the consent read happens
  // first, so a build with the feature off still cannot look like consent.
  if (!pluginUseEnabled(root, env)) return { kind: 'skipped', reason: 'plugin-use-not-enabled' };
  if (!(featureEnabled ?? ONE_MCP_SYNC)) return { kind: 'skipped', reason: 'feature-disabled' };
  const activeHost = canonicalHost(host);
  if (identity && !firstEmitThisSession(root, `one-mcp-sync-${activeHost}`, identity)) {
    return { kind: 'skipped', reason: 'already-started-this-session' };
  }
  return asSyncStart(sync(root, activeHost, env));
}

/**
 * The historical boolean, expressed as the wrapper over the result above — the
 * same relationship `readJson` has to `readJsonResult` (shared/fsjson.ts), and
 * for the same reason: the existing call sites only ever needed "did it get
 * past the guards and reach the worker?", and rewriting them is what makes a
 * site invisible rather than fixed.
 *
 * `!== 'skipped'` and not `=== 'completed'`: the original returned `true` for
 * every path that CALLED the sync, including the ones where the sync then
 * answered `null` internally (a missing runner, a refused spawn). Narrowing it
 * to the success kinds here would silently change what
 * syncOneMcpAtSessionStart does on a damaged install.
 */
export function syncOneMcpOnce(
  cwd: string,
  host: unknown,
  identity: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  sync: SessionOneMcpSync = syncOneMcpForSession,
  featureEnabled?: boolean,
): boolean {
  return syncOneMcpOnceResult(cwd, host, identity, env, sync, featureEnabled).kind !== 'skipped';
}

function warningDiagnostic(lastSync: OneMcpLastSync | null): SessionWarningDiagnostic | null {
  if (!lastSync
    || (lastSync.outcome !== 'invalid-response' && lastSync.outcome !== 'config-not-found')) {
    return null;
  }
  return lastSync as SessionWarningDiagnostic;
}

function warningReason(sync: SessionWarningDiagnostic): string {
  if (sync.outcome === 'config-not-found') return 'config-not-found';
  return sync.reason || 'invalid-response';
}

function warningSummary(sync: SessionWarningDiagnostic): string {
  if (sync.outcome === 'config-not-found') return 'the published configuration is missing';
  return `the published configuration was rejected (${sync.reason || 'invalid-response'})`;
}

// Read the bounded diagnostic written by the worker and atomically claim its
// presentation key. Only invalid/config-missing outcomes are surfaced at
// SessionStart; transient transport failures stay silent here and remain visible
// through doctor. The message is built solely from client-owned enums/constants,
// never from remote payload or error text.
export function oneMcpSessionWarning(
  hostInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const host = canonicalHost(hostInput);
  const configName = ONE_MCP_CONFIG_NAME_BY_HOST[host];
  let sync: SessionWarningDiagnostic | null;
  try {
    sync = warningDiagnostic(readOneMcpCache(env).hosts[host]?.lastSync ?? null);
  } catch {
    return null;
  }
  if (!sync) return null;

  const reason = warningReason(sync);
  const warningKey = JSON.stringify([
    host,
    configName,
    reason,
    sync.requestedVersion,
    sync.observedVersion,
  ]);
  try {
    if (!claimOneMcpWarningKey(host, warningKey, env)) return null;
  } catch {
    // A diagnostic lock failure must never make SessionStart blocking or noisy.
    return null;
  }

  const source = sync.source === 'one-mcp'
    ? 'the last valid cached One MCP model catalog'
    : 'the bundled model catalog';
  return [
    `Traffic One One MCP warning for ${host} (${configName}): ${warningSummary(sync)}.`,
    `Requested version ${sync.requestedVersion}; observed version ${sync.observedVersion}.`,
    `This session continues with ${source}. Run Traffic One doctor for the bounded sync diagnostic.`,
  ].join(' ');
}
