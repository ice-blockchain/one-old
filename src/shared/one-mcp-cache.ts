// Durable cache for anonymous One MCP get_config payloads. Each host owns one
// canonical config plus the generation and bounded diagnostic for its latest
// sync. Fingerprints are derived from the canonical payload on read and are
// never persisted as a second copy of catalog identity.

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
} from '../config/one-mcp';
import { HOST_IDS, type HostModelKey } from '../config/model-tiers';
import {
  oneMcpPayloadFingerprint,
} from './one-mcp/fingerprint';
import { parseOneMcpModelConfigPayload } from './one-mcp/get-config';
import type { OneMcpModelConfigPayload, OneMcpRemoteTiers } from './one-mcp/types';
import { globalTrafficOneDir } from './state/traffic-one-paths';

type Rec = Record<string, unknown>;

export interface OneMcpConfigCacheEntry {
  endpoint: string;
  configName: string;
  decoderVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  payload: OneMcpModelConfigPayload;
  /** Derived from payload; never stored in one-mcp.json. */
  payloadFingerprint: string;
}

export type OneMcpLastSyncOutcome =
  | 'full'
  | 'up-to-date'
  | 'config-not-found'
  | 'temporary-error'
  | 'invalid-response'
  | 'unavailable';

export type OneMcpLastSyncReason =
  | 'cache-unavailable'
  | 'transport-failed'
  | 'unsafe-object-graph'
  | 'invalid-json-rpc-envelope'
  | 'unexpected-json-rpc-error'
  | 'invalid-tool-result'
  | 'invalid-up-to-date-sentinel'
  | 'invalid-full-config';

export interface OneMcpLastSync {
  attemptedAt: string;
  outcome: OneMcpLastSyncOutcome;
  source: 'one-mcp' | 'bundled';
  requestedVersion: number;
  observedVersion: number;
  reason?: OneMcpLastSyncReason;
}

export interface OneMcpHostCacheState {
  syncGeneration: string | null;
  config: OneMcpConfigCacheEntry | null;
  lastSync: OneMcpLastSync | null;
  lastWarningKey: string | null;
}

export type OneMcpHostCacheMap = Partial<Record<HostModelKey, OneMcpHostCacheState>>;

export interface OneMcpCache {
  schemaVersion: number;
  hosts: OneMcpHostCacheMap;
}

export interface OneMcpConfigCacheIdentity {
  endpoint: string;
  configName: string;
  decoderVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  payloadFingerprint: string;
}

export interface OneMcpConfigCacheCasResult {
  written: boolean;
  current: OneMcpConfigCacheEntry | null;
}

export interface OneMcpConfigCacheRequestObservation {
  entry: OneMcpConfigCacheEntry | null;
  identity: OneMcpConfigCacheIdentity | null;
  syncGeneration: string;
}

export type OneMcpConfigCacheUpdate =
  | { kind: 'keep' }
  | { kind: 'replace'; entry: OneMcpConfigCacheEntry }
  | { kind: 'clear' };

export { ONE_MCP_CACHE_LOCK_TIMEOUT_MS };
const GENERATION_RE = /^[a-f0-9]{16,256}$/;
const LAST_SYNC_OUTCOMES = new Set<OneMcpLastSyncOutcome>([
  'full',
  'up-to-date',
  'config-not-found',
  'temporary-error',
  'invalid-response',
  'unavailable',
]);
const LAST_SYNC_REASONS = new Set<OneMcpLastSyncReason>([
  'cache-unavailable',
  'transport-failed',
  'unsafe-object-graph',
  'invalid-json-rpc-envelope',
  'unexpected-json-rpc-error',
  'invalid-tool-result',
  'invalid-up-to-date-sentinel',
  'invalid-full-config',
]);

function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Rec
    : null;
}

function knownHost(value: string): value is HostModelKey {
  return (HOST_IDS as readonly string[]).includes(value);
}

function validString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return validString(value, 128) && Number.isFinite(Date.parse(value));
}

export function parseOneMcpConfigCacheEntry(
  value: unknown,
  expectedHost?: HostModelKey,
): OneMcpConfigCacheEntry | null {
  const raw = record(value);
  const inferredHost = expectedHost ?? HOST_IDS.find(
    (host) => raw?.configName === ONE_MCP_CONFIG_NAME_BY_HOST[host],
  );
  const payload = parseOneMcpModelConfigPayload(raw?.payload, inferredHost);
  if (!raw
    || !validString(raw.endpoint, 2_048)
    || !validString(raw.configName, 128)
    || (expectedHost !== undefined && raw.configName !== ONE_MCP_CONFIG_NAME_BY_HOST[expectedHost])
    || raw.decoderVersion !== ONE_MCP_DECODER_VERSION
    || !Number.isInteger(raw.version)
    || (raw.version as number) < 1
    || (raw.version as number) > ONE_MCP_MAX_CONFIG_VERSION
    || !validTimestamp(raw.createdAt)
    || !validTimestamp(raw.updatedAt)
    || Date.parse(raw.updatedAt as string) < Date.parse(raw.createdAt as string)
    || !payload) return null;

  const payloadFingerprint = oneMcpPayloadFingerprint(payload);

  return {
    endpoint: raw.endpoint,
    configName: raw.configName,
    decoderVersion: raw.decoderVersion as number,
    version: raw.version as number,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    payload,
    payloadFingerprint,
  };
}

function parseLastSync(value: unknown): OneMcpLastSync | null {
  const raw = record(value);
  if (!raw
    || !validTimestamp(raw.attemptedAt)
    || typeof raw.outcome !== 'string'
    || !LAST_SYNC_OUTCOMES.has(raw.outcome as OneMcpLastSyncOutcome)
    || (raw.source !== 'one-mcp' && raw.source !== 'bundled')
    || !Number.isInteger(raw.requestedVersion)
    || (raw.requestedVersion as number) < 0
    || (raw.requestedVersion as number) > ONE_MCP_MAX_CONFIG_VERSION
    || !Number.isInteger(raw.observedVersion)
    || (raw.observedVersion as number) < 0
    || (raw.observedVersion as number) > ONE_MCP_MAX_CONFIG_VERSION
    || (raw.reason !== undefined
      && (typeof raw.reason !== 'string'
        || !LAST_SYNC_REASONS.has(raw.reason as OneMcpLastSyncReason)))) return null;
  return {
    attemptedAt: raw.attemptedAt,
    outcome: raw.outcome as OneMcpLastSyncOutcome,
    source: raw.source,
    requestedVersion: raw.requestedVersion as number,
    observedVersion: raw.observedVersion as number,
    ...(raw.reason === undefined ? {} : { reason: raw.reason as OneMcpLastSyncReason }),
  };
}

export function oneMcpConfigCacheIdentity(
  entry: OneMcpConfigCacheEntry,
): OneMcpConfigCacheIdentity {
  return {
    endpoint: entry.endpoint,
    configName: entry.configName,
    decoderVersion: entry.decoderVersion,
    version: entry.version,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    payloadFingerprint: entry.payloadFingerprint,
  };
}

function sameIdentity(
  current: OneMcpConfigCacheEntry | null,
  expected: OneMcpConfigCacheIdentity | null,
): boolean {
  if (!current || !expected) return current === null && expected === null;
  const actual = oneMcpConfigCacheIdentity(current);
  return actual.endpoint === expected.endpoint
    && actual.configName === expected.configName
    && actual.decoderVersion === expected.decoderVersion
    && actual.version === expected.version
    && actual.createdAt === expected.createdAt
    && actual.updatedAt === expected.updatedAt
    && actual.payloadFingerprint === expected.payloadFingerprint;
}

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

interface CacheLock {
  dirPath: string;
  ownerPath: string;
  token: string;
}

interface CacheLockOwner {
  ownerPath: string;
  token: string;
  pid: number;
  createdAt: number;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // Constrained hook runtimes can disable SharedArrayBuffer. The deadline
    // still bounds the retry loop.
  }
}

function observedLockOwner(lockPath: string): CacheLockOwner | null {
  try {
    const entries = fs.readdirSync(lockPath).filter((name) => /^owner-[a-f0-9]+\.json$/.test(name));
    if (entries.length !== 1) return null;
    const ownerName = entries[0]!;
    const ownerPath = path.join(lockPath, ownerName);
    const raw = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Rec;
    const token = typeof raw.token === 'string' ? raw.token : '';
    const pid = typeof raw.pid === 'number' ? raw.pid : Number.NaN;
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Number.NaN;
    if (!token || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAt)
      || ownerName !== `owner-${token}.json`) return null;
    return { ownerPath, token, pid, createdAt };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function reapObservedLock(lockPath: string, owner: CacheLockOwner): boolean {
  try { fs.unlinkSync(owner.ownerPath); } catch { return false; }
  try {
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function reapAbandonedEmptyLock(lockPath: string, now: number): boolean {
  try {
    if (fs.readdirSync(lockPath).length !== 0) return false;
    if (now - fs.statSync(lockPath).mtimeMs <= ONE_MCP_CACHE_LOCK_STALE_MS) return false;
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    // A legacy owner may have appeared after the empty-directory observation,
    // or another contender may already have recovered it. Both are safe races.
    return false;
  }
}

function acquireCacheLock(filePath: string): CacheLock {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + ONE_MCP_CACHE_LOCK_TIMEOUT_MS;
  fs.mkdirSync(pendingPath, { mode: 0o700 });
  try {
    fs.writeFileSync(
      path.join(pendingPath, ownerName),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  let acquired = false;
  try {
    while (true) {
      try {
        fs.renameSync(pendingPath, lockPath);
        acquired = true;
        return { dirPath: lockPath, ownerPath: path.join(lockPath, ownerName), token };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const contended = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR'
          || (code === 'EPERM' && fs.existsSync(lockPath));
        if (!contended) throw error;
        const now = Date.now();
        const owner = observedLockOwner(lockPath);
        if (owner && now - owner.createdAt > ONE_MCP_CACHE_LOCK_STALE_MS
          && !processAlive(owner.pid) && reapObservedLock(lockPath, owner)) continue;
        if (!owner && reapAbandonedEmptyLock(lockPath, now)) continue;
        if (now >= deadline) {
          throw new Error(`traffic-one One MCP cache lock timed out after ${ONE_MCP_CACHE_LOCK_TIMEOUT_MS}ms`);
        }
        sleepSync(Math.min(ONE_MCP_CACHE_LOCK_RETRY_MS, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function releaseCacheLock(lock: CacheLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    const raw = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8')) as Rec;
    if (raw.token !== lock.token) return;
    // Remove the canonical lock pathname in one atomic operation. Cleanup is
    // token-addressed and best-effort, so a crash can strand only a harmless
    // tombstone rather than an empty canonical lock that blocks every writer.
    fs.renameSync(lock.dirPath, releasedPath);
  } catch {
    // Already removed/replaced. Never remove a lock we cannot prove we own.
    return;
  }
  try { fs.rmSync(releasedPath, { recursive: true, force: true }); } catch { /* best-effort */ }
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
