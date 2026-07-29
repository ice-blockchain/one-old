// src/shared/one-mcp/cache.ts
// The machine-global One MCP cache store: locked read/update, per-host
// entries, and CAS observation. Schema lives in cache-schema.ts.

import * as fs from 'fs';
import * as path from 'path';
import {
  ONE_MCP_CACHE_FILE,
  ONE_MCP_CACHE_LOCK_RETRY_MS,
  ONE_MCP_CACHE_LOCK_STALE_MS,
  ONE_MCP_CACHE_LOCK_TIMEOUT_MS,
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_MAX_CONFIG_VERSION,
} from '../../config/one-mcp';
import { HOST_IDS, type HostModelKey } from '../../config/model-tiers';
import type { OneMcpModelConfigPayload, OneMcpRemoteTiers } from './types';
import { globalTrafficOneDir } from '../state/traffic-one-paths';

import {
  GENERATION_RE,
  knownHost,
  oneMcpConfigCacheIdentity,
  parseLastSync,
  parseOneMcpConfigCacheEntry,
  record,
  sameIdentity,
  validString,
  type OneMcpCache,
  type OneMcpConfigCacheCasResult,
  type OneMcpConfigCacheEntry,
  type OneMcpConfigCacheIdentity,
  type OneMcpConfigCacheRequestObservation,
  type OneMcpConfigCacheUpdate,
  type OneMcpHostCacheMap,
  type OneMcpLastSync,
  type Rec,
} from './cache-schema';
import { acquireCacheLock, releaseCacheLock } from './cache-lock';
import type { CacheLock } from './cache-lock';


export function oneMcpCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalTrafficOneDir(env), ONE_MCP_CACHE_FILE);
}

type RawCacheStatus = 'missing' | 'current' | 'malformed' | 'future';

interface RawCacheRead {
  status: RawCacheStatus;
  raw: Rec | null;
}

function readRawCache(filePath: string): RawCacheRead {
  if (!fs.existsSync(filePath)) return { status: 'missing', raw: null };
  let raw: Rec | null;
  try {
    raw = record(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', raw: null };
    return { status: 'malformed', raw: null };
  }
  if (!raw || !Number.isInteger(raw.schemaVersion)) return { status: 'malformed', raw };
  if ((raw.schemaVersion as number) > ONE_MCP_CACHE_SCHEMA_VERSION) return { status: 'future', raw };
  if (raw.schemaVersion !== ONE_MCP_CACHE_SCHEMA_VERSION) return { status: 'malformed', raw };
  if (raw.hosts !== undefined && !record(raw.hosts)) return { status: 'malformed', raw };
  return { status: 'current', raw };
}

function parseCache(source: RawCacheRead): OneMcpCache {
  const hosts: OneMcpHostCacheMap = {};
  if (source.status === 'current') {
    const rawHosts = record(source.raw?.hosts);
    if (rawHosts) {
      for (const host of HOST_IDS) {
        const rawHost = record(rawHosts[host]);
        if (!rawHost) continue;
        const syncGeneration = typeof rawHost.syncGeneration === 'string'
          && GENERATION_RE.test(rawHost.syncGeneration)
          ? rawHost.syncGeneration
          : null;
        const config = parseOneMcpConfigCacheEntry(rawHost.config, host);
        const lastSync = parseLastSync(rawHost.lastSync);
        const lastWarningKey = validString(rawHost.lastWarningKey, 512)
          ? rawHost.lastWarningKey
          : null;
        if (syncGeneration || config || lastSync || lastWarningKey) {
          hosts[host] = { syncGeneration, config, lastSync, lastWarningKey };
        }
      }
    }
  }
  return { schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION, hosts };
}

export function readOneMcpCache(env: NodeJS.ProcessEnv = process.env): OneMcpCache {
  return parseCache(readRawCache(oneMcpCachePath(env)));
}

export function readOneMcpConfigCacheEntry(
  host: HostModelKey,
  env: NodeJS.ProcessEnv = process.env,
): OneMcpConfigCacheEntry | null {
  return readOneMcpCache(env).hosts[host]?.config ?? null;
}

function writeCacheFile(filePath: string, cache: Rec): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
  }
}




function withCacheLock<T>(filePath: string, body: () => T): T {
  const lock = acquireCacheLock(filePath);
  try {
    return body();
  } finally {
    releaseCacheLock(lock);
  }
}

function canonicalEntry(
  host: HostModelKey,
  value: OneMcpConfigCacheEntry,
): OneMcpConfigCacheEntry {
  const parsed = parseOneMcpConfigCacheEntry(value, host);
  if (!parsed) throw new TypeError('invalid Traffic One MCP config cache entry');
  return parsed;
}

function canonicalLastSync(value: OneMcpLastSync): OneMcpLastSync {
  const parsed = parseLastSync(value);
  if (!parsed) throw new TypeError('invalid Traffic One MCP last-sync diagnostic');
  return parsed;
}

function generation(): string {
  return `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function storedRemoteTiers(tiers: OneMcpRemoteTiers): Rec {
  return {
    high: [...tiers.high],
    balanced: [...tiers.balanced],
    low: [...tiers.low],
    auto: [...tiers.auto],
  };
}

function storedConfig(entry: OneMcpConfigCacheEntry): Rec {
  const plans: Rec = {};
  for (const [plan, tiers] of Object.entries(entry.payload.plans ?? {})) {
    if (tiers) plans[plan] = storedRemoteTiers(tiers);
  }
  return {
    endpoint: entry.endpoint,
    configName: entry.configName,
    decoderVersion: entry.decoderVersion,
    version: entry.version,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    payload: {
      tiers: storedRemoteTiers(entry.payload.tiers),
      ...(Object.keys(plans).length > 0 ? { plans } : {}),
    },
  };
}

function isFutureHostEntry(value: unknown): boolean {
  const rawHost = record(value);
  const raw = record(rawHost?.config);
  if (!raw) return false;
  return Number.isInteger(raw.decoderVersion)
    && (raw.decoderVersion as number) > ONE_MCP_DECODER_VERSION;
}

function assertWritableHostEntry(source: RawCacheRead, host: HostModelKey): void {
  if (source.status !== 'current') return;
  const rawEntry = record(source.raw?.hosts)?.[host];
  if (isFutureHostEntry(rawEntry)) {
    throw new Error(`Traffic One MCP cache entry for ${host} is newer than this plugin supports`);
  }
}

interface HostMutation {
  syncGeneration?: string;
  config?: OneMcpConfigCacheEntry | null;
  lastSync?: OneMcpLastSync;
  lastWarningKey?: string;
}

function rawCacheWithHostMutation(
  source: RawCacheRead,
  host: HostModelKey,
  mutation: HostMutation,
): Rec {
  assertWritableHostEntry(source, host);
  const raw = source.status === 'current' && source.raw ? { ...source.raw } : {};
  const previousHosts = source.status === 'current' ? record(source.raw?.hosts) : null;
  const hosts: Rec = previousHosts ? { ...previousHosts } : {};
  const previousHost = record(hosts[host]);
  const nextHost: Rec = previousHost ? { ...previousHost } : {};

  if (mutation.syncGeneration !== undefined) {
    if (!GENERATION_RE.test(mutation.syncGeneration)) {
      throw new TypeError('invalid Traffic One MCP sync generation');
    }
    nextHost.syncGeneration = mutation.syncGeneration;
  }

  if (Object.prototype.hasOwnProperty.call(mutation, 'config')) {
    if (mutation.config === null) {
      delete nextHost.config;
    } else if (mutation.config) {
      const previousConfig = record(nextHost.config);
      const nextConfig = { ...(previousConfig || {}), ...storedConfig(mutation.config) };
      // Retired pre-release duplicates must not survive a write merely because
      // unknown additive fields are otherwise preserved. `createdAt` is now
      // canonical server metadata and must remain alongside `updatedAt`.
      delete nextConfig.payloadSchemaVersion;
      delete nextConfig.payloadFingerprint;
      delete nextConfig.appliedFingerprint;
      nextHost.config = nextConfig;
    }
  }

  if (mutation.lastSync !== undefined) {
    // lastSync describes exactly one completed request. Replacing it prevents
    // optional failure fields from leaking into a later successful outcome.
    nextHost.lastSync = { ...mutation.lastSync };
  }

  if (mutation.lastWarningKey !== undefined) {
    if (!validString(mutation.lastWarningKey, 512)) {
      throw new TypeError('invalid Traffic One MCP warning key');
    }
    nextHost.lastWarningKey = mutation.lastWarningKey;
  }

  hosts[host] = nextHost;
  raw.schemaVersion = ONE_MCP_CACHE_SCHEMA_VERSION;
  raw.hosts = hosts;
  // These envelopes only existed before release. Remove them deterministically
  // on the first new-format mutation rather than carrying two authorities.
  delete raw.modelConfigs;
  delete raw.requestTokens;
  return raw;
}

function currentHostState(source: RawCacheRead, host: HostModelKey): Rec | null {
  return source.status === 'current' ? record(record(source.raw?.hosts)?.[host]) : null;
}

function currentSyncGeneration(source: RawCacheRead, host: HostModelKey): string | null {
  const value = currentHostState(source, host)?.syncGeneration;
  return typeof value === 'string' && GENERATION_RE.test(value) ? value : null;
}

function currentConfig(source: RawCacheRead, host: HostModelKey): OneMcpConfigCacheEntry | null {
  return parseOneMcpConfigCacheEntry(currentHostState(source, host)?.config, host);
}

// Publish a per-request generation before network I/O. This closes the null
// identity hole: when two first-session requests both observe no cache, a later
// config_not_found (or newer request) still invalidates the older full response.
// The lock is held only for this tiny local transaction, never for HTTP.
export function beginOneMcpConfigCacheRequest(
  host: HostModelKey,
  env: NodeJS.ProcessEnv = process.env,
): OneMcpConfigCacheRequestObservation {
  if (!knownHost(host)) throw new TypeError(`invalid Traffic One MCP cache host: ${String(host)}`);
  const filePath = oneMcpCachePath(env);
  return withCacheLock(filePath, () => {
    const source = readRawCache(filePath);
    if (source.status === 'future') {
      throw new Error('Traffic One MCP cache schema is newer than this plugin supports');
    }
    assertWritableHostEntry(source, host);
    const entry = currentConfig(source, host);
    const syncGeneration = generation();
    writeCacheFile(filePath, rawCacheWithHostMutation(source, host, { syncGeneration }));
    return {
      entry,
      identity: entry ? oneMcpConfigCacheIdentity(entry) : null,
      syncGeneration,
    };
  });
}

export function completeOneMcpConfigCacheRequest(
  host: HostModelKey,
  expected: OneMcpConfigCacheIdentity | null,
  expectedSyncGeneration: string,
  update: OneMcpConfigCacheUpdate,
  lastSync: OneMcpLastSync,
  env: NodeJS.ProcessEnv = process.env,
): OneMcpConfigCacheCasResult {
  if (!knownHost(host)) throw new TypeError(`invalid Traffic One MCP cache host: ${String(host)}`);
  if (!GENERATION_RE.test(expectedSyncGeneration)) {
    throw new TypeError('invalid Traffic One MCP sync generation');
  }
  const canonicalUpdate: OneMcpConfigCacheUpdate = update.kind === 'replace'
    ? { kind: 'replace', entry: canonicalEntry(host, update.entry) }
    : update;
  const diagnostic = canonicalLastSync(lastSync);
  const filePath = oneMcpCachePath(env);
  return withCacheLock(filePath, () => {
    const source = readRawCache(filePath);
    if (source.status === 'future') {
      throw new Error('Traffic One MCP cache schema is newer than this plugin supports');
    }
    assertWritableHostEntry(source, host);
    const current = currentConfig(source, host);
    if (currentSyncGeneration(source, host) !== expectedSyncGeneration
      || !sameIdentity(current, expected)) return { written: false, current };
    const config = canonicalUpdate.kind === 'replace'
      ? canonicalUpdate.entry
      : canonicalUpdate.kind === 'clear'
        ? null
        : undefined;
    writeCacheFile(filePath, rawCacheWithHostMutation(source, host, {
      ...(config === undefined ? {} : { config }),
      lastSync: diagnostic,
    }));
    return { written: true, current: config === undefined ? current : config };
  });
}

export function compareAndSwapOneMcpConfigCacheEntry(
  host: HostModelKey,
  expected: OneMcpConfigCacheIdentity | null,
  replacement: OneMcpConfigCacheEntry | null,
  env: NodeJS.ProcessEnv = process.env,
): OneMcpConfigCacheCasResult {
  if (!knownHost(host)) throw new TypeError(`invalid Traffic One MCP cache host: ${String(host)}`);
  const nextEntry = replacement === null ? null : canonicalEntry(host, replacement);
  const filePath = oneMcpCachePath(env);
  return withCacheLock(filePath, () => {
    const source = readRawCache(filePath);
    if (source.status === 'future') {
      throw new Error('Traffic One MCP cache schema is newer than this plugin supports');
    }
    assertWritableHostEntry(source, host);
    const current = currentConfig(source, host);
    if (!sameIdentity(current, expected)) return { written: false, current };
    writeCacheFile(filePath, rawCacheWithHostMutation(source, host, {
      syncGeneration: generation(),
      config: nextEntry,
    }));
    return { written: true, current: nextEntry };
  });
}

export function writeOneMcpConfigCacheEntry(
  host: HostModelKey,
  value: OneMcpConfigCacheEntry,
  env: NodeJS.ProcessEnv = process.env,
): OneMcpConfigCacheEntry {
  if (!knownHost(host)) throw new TypeError(`invalid Traffic One MCP cache host: ${String(host)}`);
  const entry = canonicalEntry(host, value);
  const filePath = oneMcpCachePath(env);
  return withCacheLock(filePath, () => {
    const source = readRawCache(filePath);
    if (source.status === 'future') {
      throw new Error('Traffic One MCP cache schema is newer than this plugin supports');
    }
    writeCacheFile(filePath, rawCacheWithHostMutation(source, host, {
      syncGeneration: generation(),
      config: entry,
    }));
    return entry;
  });
}

// Atomically claim a bounded diagnostic key. Parent SessionStart uses the true
// result to show a fallback warning once for each new host/config/reason/version
// combination; child sessions and repeated hooks observe false and stay quiet.
export function claimOneMcpWarningKey(
  host: HostModelKey,
  warningKey: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!knownHost(host)) throw new TypeError(`invalid Traffic One MCP cache host: ${String(host)}`);
  if (!validString(warningKey, 512)) throw new TypeError('invalid Traffic One MCP warning key');
  const filePath = oneMcpCachePath(env);
  return withCacheLock(filePath, () => {
    const source = readRawCache(filePath);
    if (source.status === 'future') {
      throw new Error('Traffic One MCP cache schema is newer than this plugin supports');
    }
    assertWritableHostEntry(source, host);
    if (currentHostState(source, host)?.lastWarningKey === warningKey) return false;
    writeCacheFile(filePath, rawCacheWithHostMutation(source, host, { lastWarningKey: warningKey }));
    return true;
  });
}

export function clearOneMcpConfigCacheEntry(
  host: HostModelKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!knownHost(host)) return false;
  const filePath = oneMcpCachePath(env);
  if (!fs.existsSync(filePath)) return true;
  try {
    return withCacheLock(filePath, () => {
      const source = readRawCache(filePath);
      if (source.status === 'future') return false;
      assertWritableHostEntry(source, host);
      writeCacheFile(filePath, rawCacheWithHostMutation(source, host, {
        syncGeneration: generation(),
        config: null,
      }));
      return true;
    });
  } catch {
    return false;
  }
}
export {
  oneMcpConfigCacheIdentity,
  parseOneMcpConfigCacheEntry,
  type OneMcpCache,
  type OneMcpConfigCacheCasResult,
  type OneMcpConfigCacheEntry,
  type OneMcpConfigCacheIdentity,
  type OneMcpConfigCacheRequestObservation,
  type OneMcpConfigCacheUpdate,
  type OneMcpHostCacheMap,
  type OneMcpHostCacheState,
  type OneMcpLastSync,
  type OneMcpLastSyncOutcome,
  type OneMcpLastSyncReason,
} from './cache-schema';
export { ONE_MCP_CACHE_LOCK_TIMEOUT_MS } from '../../config/one-mcp';
