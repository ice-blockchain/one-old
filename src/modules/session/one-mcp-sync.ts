// Synchronous SessionStart bridge to the asynchronous, best-effort public MCP
// config worker. Exact opt-in is checked before spawning; the worker checks it
// again so a stale caller can never bypass the project preference.

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_MAX_RESPONSE_BYTES,
  ONE_MCP_SESSION_SYNC_TIMEOUT_MS,
  oneMcpSyncEnabled,
} from '../../config/one-mcp';
import { canonicalHost } from '../../shared/model-tiers';
import {
  claimOneMcpWarningKey,
  readOneMcpCache,
  type OneMcpLastSync,
} from '../../shared/one-mcp-cache';
import { firstEmitThisSession } from '../../shared/once';
import { pluginRoot } from '../../shared/paths';
import { pluginUseEnabled } from '../../shared/state/plugin-use';

type Spawn = typeof spawnSync;

export type SessionOneMcpSync = (
  cwd: string,
  host: unknown,
  env: NodeJS.ProcessEnv,
) => unknown;

type SessionWarningDiagnostic = OneMcpLastSync & {
  outcome: 'invalid-response' | 'config-not-found';
};

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
  if (!oneMcpSyncEnabled(env, featureEnabled) || !pluginUseEnabled(cwd, env)) return null;
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

// Shared parent-session/runner gate. A stable identity deduplicates every hook
// and onboarding-wait surface for the same canonical project + host + session.
// Some hosts do not expose one; those calls deliberately run again because the
// cache worker's lock + CAS protocol makes the duplicate harmless.
export function syncOneMcpOnce(
  cwd: string,
  host: unknown,
  identity: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  sync: SessionOneMcpSync = syncOneMcpForSession,
  featureEnabled?: boolean,
): boolean {
  const root = canonicalProjectRoot(cwd);
  if (!pluginUseEnabled(root, env) || !oneMcpSyncEnabled(env, featureEnabled)) return false;
  const activeHost = canonicalHost(host);
  if (identity && !firstEmitThisSession(root, `one-mcp-sync-${activeHost}`, identity)) return false;
  sync(root, activeHost, env);
  return true;
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
