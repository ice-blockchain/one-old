// Session-start reconciliation for the anonymous Traffic One public MCP.
//
// Network I/O stays outside the cache lock. A per-host sync generation makes
// duplicate or misclassified-parent requests safe, while the cache completion
// atomically publishes the canonical config and a bounded diagnostic.

import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  oneMcpSyncEnabled,
  publicEndpoint,
} from '../config/one-mcp';
import type { HostModelKey } from '../config/model-tiers';
import { currentHostModelTarget, usableOneMcpConfigCacheEntry } from './current-model-tiers';
import { detectHostPlan } from './host-plan';
import { canonicalHost, hostModelSnapshot, type HostModelSnapshot } from './model-tiers';
import {
  beginOneMcpConfigCacheRequest,
  completeOneMcpConfigCacheRequest,
  readOneMcpConfigCacheEntry,
  type OneMcpConfigCacheEntry,
  type OneMcpConfigCacheIdentity,
  type OneMcpLastSync,
  type OneMcpLastSyncReason,
} from './one-mcp-cache';
import {
  callOneMcpGetConfig,
  mapOneMcpTiers,
  oneMcpAppliedFingerprint,
  oneMcpRemoteTiersForPlan,
  type OneMcpGetConfigOptions,
  type OneMcpGetConfigOutcome,
} from './one-mcp';
import { pluginUseEnabled } from './state/plugin-use';
import { stateTimestamp } from './state/io';
import { advanceProjectHostPerformanceTargetMetadata } from './state/local-prefs';

type GetConfig = typeof callOneMcpGetConfig;

export interface OneMcpSyncOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly getConfig?: GetConfig;
  readonly transport?: OneMcpGetConfigOptions;
  readonly now?: () => string;
  /** Internal test seam; production callers must omit this build-gate override. */
  readonly featureEnabled?: boolean;
}

export type OneMcpSyncOutcome =
  | 'disabled'
  | 'full'
  | 'up-to-date'
  | 'config-not-found'
  | 'temporary-error'
  | 'invalid-response'
  | 'unavailable';

export interface OneMcpSyncResult {
  readonly host: HostModelKey;
  readonly plan: string;
  readonly outcome: OneMcpSyncOutcome;
  readonly source: 'one-mcp' | 'bundled';
  readonly changed: boolean;
  readonly configVersion: number;
  readonly reason?: OneMcpLastSyncReason;
}

interface ResolvedTarget {
  readonly snapshot: HostModelSnapshot;
  readonly appliedFingerprint: string;
  readonly configVersion: number;
  readonly source: 'one-mcp' | 'bundled';
}

function fallbackTarget(
  host: HostModelKey,
  plan: string,
  env: NodeJS.ProcessEnv,
): ResolvedTarget {
  return currentHostModelTarget(host, plan, env);
}

function bundledTarget(host: HostModelKey, plan: string): ResolvedTarget {
  const snapshot = hostModelSnapshot(host, plan);
  return {
    snapshot,
    appliedFingerprint: oneMcpAppliedFingerprint(snapshot.tiers),
    configVersion: 0,
    source: 'bundled',
  };
}

function cacheTarget(
  host: HostModelKey,
  plan: string,
  entry: OneMcpConfigCacheEntry | null,
  env: NodeJS.ProcessEnv,
): ResolvedTarget | null {
  const usable = usableOneMcpConfigCacheEntry(host, entry, env);
  if (!usable) return null;
  const canonicalPlan = hostModelSnapshot(host, plan).plan;
  const tiers = mapOneMcpTiers(oneMcpRemoteTiersForPlan(usable.payload, canonicalPlan));
  return {
    snapshot: {
      plan: canonicalPlan,
      tiers,
    },
    appliedFingerprint: oneMcpAppliedFingerprint(tiers),
    configVersion: usable.version,
    source: 'one-mcp',
  };
}

function fullCacheEntry(
  endpoint: string,
  configName: string,
  outcome: Extract<OneMcpGetConfigOutcome, { kind: 'full' }>,
): OneMcpConfigCacheEntry {
  return {
    endpoint,
    configName,
    decoderVersion: ONE_MCP_DECODER_VERSION,
    version: outcome.config.version,
    createdAt: outcome.config.createdAt,
    updatedAt: outcome.config.updatedAt,
    payload: outcome.config.payload,
    payloadFingerprint: outcome.payloadFingerprint,
  };
}

function safeReadCache(
  host: HostModelKey,
  env: NodeJS.ProcessEnv,
): OneMcpConfigCacheEntry | null {
  try {
    return readOneMcpConfigCacheEntry(host, env);
  } catch {
    return null;
  }
}

function canonicalAttemptedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function diagnostic(
  attemptedAt: string,
  outcome: Exclude<OneMcpSyncOutcome, 'disabled'>,
  target: ResolvedTarget,
  requestedVersion: number,
  observedVersion: number,
  reason?: OneMcpLastSyncReason,
): OneMcpLastSync {
  return {
    attemptedAt,
    outcome,
    source: target.source,
    requestedVersion,
    observedVersion,
    ...(reason ? { reason } : {}),
  };
}

function result(
  host: HostModelKey,
  plan: string,
  outcome: OneMcpSyncOutcome,
  target: ResolvedTarget,
  changed: boolean,
  reason?: OneMcpLastSyncReason,
): OneMcpSyncResult {
  return {
    host,
    plan,
    outcome,
    source: target.source,
    changed,
    configVersion: target.configVersion,
    ...(reason ? { reason } : {}),
  };
}

export async function syncOneMcpHostForProject(
  cwd: string,
  hostInput: unknown,
  options: OneMcpSyncOptions = {},
): Promise<OneMcpSyncResult> {
  const env = options.env ?? process.env;
  const host = canonicalHost(hostInput);
  const plan = detectHostPlan(host, env);
  const disabledTarget = fallbackTarget(host, plan, env);
  if (!oneMcpSyncEnabled(env, options.featureEnabled) || !pluginUseEnabled(cwd, env)) {
    return result(host, plan, 'disabled', disabledTarget, false);
  }

  const endpoint = publicEndpoint(env);
  const configName = ONE_MCP_CONFIG_NAME_BY_HOST[host];
  const attemptedAt = canonicalAttemptedAt(options.now?.() ?? stateTimestamp());
  let observed: OneMcpConfigCacheEntry | null;
  let expected: OneMcpConfigCacheIdentity | null;
  let syncGeneration: string;
  try {
    const request = beginOneMcpConfigCacheRequest(host, env);
    observed = request.entry;
    expected = request.identity;
    syncGeneration = request.syncGeneration;
  } catch {
    const target = cacheTarget(host, plan, safeReadCache(host, env), env) || bundledTarget(host, plan);
    return result(host, plan, 'unavailable', target, false, 'cache-unavailable');
  }

  const usableObserved = usableOneMcpConfigCacheEntry(host, observed, env);
  let requestedVersion = usableObserved?.version ?? 0;
  const getConfig = options.getConfig ?? callOneMcpGetConfig;
  let remote: OneMcpGetConfigOutcome;
  try {
    remote = await getConfig(endpoint, configName, requestedVersion, options.transport);
    if (remote.kind === 'up-to-date' && !usableObserved) {
      requestedVersion = 0;
      remote = await getConfig(endpoint, configName, 0, options.transport);
    }
  } catch {
    const observedTarget = cacheTarget(host, plan, usableObserved, env) || bundledTarget(host, plan);
    try {
      completeOneMcpConfigCacheRequest(
        host,
        expected,
        syncGeneration,
        { kind: 'keep' },
        diagnostic(
          attemptedAt,
          'unavailable',
          observedTarget,
          requestedVersion,
          observedTarget.configVersion,
          'transport-failed',
        ),
        env,
      );
    } catch {
      // A diagnostic write must never make public configuration blocking.
    }
    const target = cacheTarget(host, plan, safeReadCache(host, env), env) || bundledTarget(host, plan);
    return result(host, plan, 'unavailable', target, false, 'transport-failed');
  }

  const replacement = remote.kind === 'full'
    ? fullCacheEntry(endpoint, configName, remote)
    : null;
  const expectedTarget = replacement
    ? cacheTarget(host, plan, replacement, env)!
    : remote.kind === 'config-not-found'
      ? bundledTarget(host, plan)
      : cacheTarget(host, plan, usableObserved, env) || bundledTarget(host, plan);
  const reason = remote.kind === 'invalid-response' ? remote.reason : undefined;
  const observedVersion = remote.kind === 'full'
    ? remote.config.version
    : remote.kind === 'up-to-date'
      ? remote.version
      : remote.kind === 'invalid-response' && remote.observedVersion !== undefined
        ? remote.observedVersion
      : expectedTarget.configVersion;

  let written = false;
  let current: OneMcpConfigCacheEntry | null = null;
  try {
    const completed = completeOneMcpConfigCacheRequest(
      host,
      expected,
      syncGeneration,
      remote.kind === 'full'
        ? { kind: 'replace', entry: replacement! }
        : remote.kind === 'config-not-found'
          ? { kind: 'clear' }
          : { kind: 'keep' },
      diagnostic(
        attemptedAt,
        remote.kind,
        expectedTarget,
        requestedVersion,
        observedVersion,
        reason,
      ),
      env,
    );
    written = completed.written;
    current = completed.current;
  } catch {
    current = safeReadCache(host, env);
  }

  const target = cacheTarget(host, plan, current, env)
    || cacheTarget(host, plan, safeReadCache(host, env), env)
    || bundledTarget(host, plan);
  const changed = remote.kind === 'full'
    ? written
    : remote.kind === 'config-not-found'
      ? written && observed !== null
      : false;
  try {
    advanceProjectHostPerformanceTargetMetadata(cwd, host, {
      plan,
      appliedFingerprint: target.appliedFingerprint,
      configVersion: target.configVersion,
    }, env);
  } catch {
    // A best-effort metadata acknowledgement must never turn remote model sync
    // into a session blocker. Semantic drift remains visible to Performance.
  }
  return result(host, plan, remote.kind, target, changed, reason);
}
