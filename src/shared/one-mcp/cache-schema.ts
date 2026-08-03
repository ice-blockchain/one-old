// src/shared/one-mcp/cache-schema.ts
// One MCP cache shapes, parse/validation, and identity comparison.

import {
  ONE_MCP_CACHE_LOCK_TIMEOUT_MS,
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_MAX_CONFIG_VERSION,
} from '../../config/one-mcp';
import { HOST_IDS, type HostModelKey } from '../../config/model-tiers';
import {
  oneMcpPayloadFingerprint,
} from './fingerprint';
import { parseOneMcpModelConfigPayload } from './get-config';
import type { OneMcpModelConfigPayload } from './types';

export type Rec = Record<string, unknown>;

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
export const GENERATION_RE = /^[a-f0-9]{16,256}$/;
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

export function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Rec
    : null;
}

export function knownHost(value: string): value is HostModelKey {
  return (HOST_IDS as readonly string[]).includes(value);
}

export function validString(value: unknown, maxLength: number): value is string {
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

export function parseLastSync(value: unknown): OneMcpLastSync | null {
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

export function sameIdentity(
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
