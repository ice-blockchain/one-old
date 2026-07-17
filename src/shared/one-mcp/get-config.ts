import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_GET_CONFIG_TOOL,
  ONE_MCP_MAX_CONFIG_VERSION,
  ONE_MCP_MAX_MODELS_PER_TIER,
  ONE_MCP_MAX_PAYLOAD_DEPTH,
  ONE_MCP_PAYLOAD_SCHEMA_VERSION,
  isSafeOneMcpModelId,
} from '../../config/one-mcp';
import {
  HOST_IDS,
  PLAN_IDS,
  type HostModelKey,
  type UserPlan,
} from '../../config/model-tiers';
import {
  oneMcpPayloadFingerprint,
} from './fingerprint';
import {
  postOneMcpJsonRpc,
  type OneMcpJsonRpcRequest,
  type OneMcpTransportOptions,
} from './transport';
import type {
  OneMcpCanonicalFullConfig,
  OneMcpGetConfigOutcome,
  OneMcpInvalidResponseReason,
  OneMcpModelConfigPayloadV2,
  OneMcpRemoteTiersV2,
} from './types';

type Rec = Record<string, unknown>;
type JsonRpcId = string | number;

const CONFIG_NAME_RE = /^[a-z0-9_]{1,128}$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface OneMcpGetConfigOptions extends OneMcpTransportOptions {
  readonly requestId?: JsonRpcId;
}

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid(
  reason: OneMcpInvalidResponseReason,
  observedVersion?: number,
): OneMcpGetConfigOutcome {
  return {
    kind: 'invalid-response',
    reason,
    ...(observedVersion === undefined ? {} : { observedVersion }),
  };
}

function safeObjectGraph(value: unknown, maxDepth: number): boolean {
  try {
    const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.depth > maxDepth) return false;
      if (typeof current.value !== 'object' || current.value === null) continue;
      const array = Array.isArray(current.value);
      const prototype = Object.getPrototypeOf(current.value) as unknown;
      if (array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null) return false;
      const descriptors = Object.getOwnPropertyDescriptors(current.value);
      for (const rawKey of Reflect.ownKeys(descriptors)) {
        if (typeof rawKey !== 'string') return false;
        if (array && rawKey === 'length') continue;
        if (DANGEROUS_KEYS.has(rawKey)) return false;
        const descriptor = descriptors[rawKey]!;
        if ('get' in descriptor || 'set' in descriptor) return false;
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
    return true;
  } catch {
    // Proxy traps and other exotic objects are not valid JSON payloads.
    return false;
  }
}

function validVersion(value: unknown, allowZero: boolean): value is number {
  return Number.isInteger(value)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= ONE_MCP_MAX_CONFIG_VERSION;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 20 || value.length > 64) return null;
  const match = RFC3339_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0
    || month < 1 || month > 12
    || day < 1 || day > days[month - 1]!
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  try {
    return new Date(time).toISOString();
  } catch {
    return null;
  }
}

function parseModelRow(value: unknown, host?: HostModelKey): readonly string[] | null {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > ONE_MCP_MAX_MODELS_PER_TIER) return null;
  const models: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, String(index))) return null;
    const model = value[index];
    if (!isSafeOneMcpModelId(model, host) || seen.has(model)) return null;
    seen.add(model);
    models.push(model);
  }
  return Object.freeze(models);
}

function parseRemoteTiers(value: unknown, host?: HostModelKey): OneMcpRemoteTiersV2 | null {
  if (!isRecord(value)) return null;
  if (!['high', 'balanced', 'low', 'auto'].every((tier) => hasOwn(value, tier))) return null;
  const high = parseModelRow(value.high, host);
  const balanced = parseModelRow(value.balanced, host);
  const low = parseModelRow(value.low, host);
  const auto = parseModelRow(value.auto, host);
  return high && balanced && low && auto
    ? Object.freeze({ high, balanced, low, auto })
    : null;
}

function parsePayloadDetailed(
  value: unknown,
  host?: HostModelKey,
): OneMcpModelConfigPayloadV2 | OneMcpInvalidResponseReason {
  if (!isRecord(value)) return 'invalid-full-config';
  if (!safeObjectGraph(value, ONE_MCP_MAX_PAYLOAD_DEPTH)) return 'unsafe-object-graph';
  if (!hasOwn(value, 'payloadSchemaVersion') || !hasOwn(value, 'tiers')) return 'invalid-full-config';
  if (value.payloadSchemaVersion !== ONE_MCP_PAYLOAD_SCHEMA_VERSION) {
    return 'unsupported-payload-schema';
  }
  const tiers = parseRemoteTiers(value.tiers, host);
  if (!tiers) return 'invalid-full-config';
  const plans: Partial<Record<UserPlan, OneMcpRemoteTiersV2>> = {};
  if (hasOwn(value, 'plans')) {
    if (!isRecord(value.plans)) return 'invalid-full-config';
    for (const plan of PLAN_IDS) {
      if (!hasOwn(value.plans, plan)) continue;
      const parsed = parseRemoteTiers(value.plans[plan], host);
      if (!parsed) return 'invalid-full-config';
      plans[plan] = parsed;
    }
  }
  return Object.freeze({
    payloadSchemaVersion: ONE_MCP_PAYLOAD_SCHEMA_VERSION,
    tiers,
    ...(Object.keys(plans).length > 0 ? { plans: Object.freeze(plans) } : {}),
  });
}

// Revalidate a cache entry before it can influence model selection. This uses
// the same forward-compatible parser as a live response: known v2 fields stay
// strict, additive fields are ignored, and unsafe/deep object graphs fail.
export function parseOneMcpModelConfigPayload(
  value: unknown,
  host?: HostModelKey,
): OneMcpModelConfigPayloadV2 | null {
  const parsed = parsePayloadDetailed(value, host);
  return typeof parsed === 'string' ? null : parsed;
}

function textContent(result: Rec): string | null {
  if (!hasOwn(result, 'content') || !Array.isArray(result.content)) return null;
  const text = result.content
    .filter(isRecord)
    .filter((entry) => hasOwn(entry, 'type') && hasOwn(entry, 'text')
      && entry.type === 'text' && typeof entry.text === 'string')
    .map((entry) => entry.text as string);
  return text.length === 1 ? text[0]! : null;
}

function successBody(result: Rec): Rec | null {
  if (hasOwn(result, 'structuredContent')) {
    return isRecord(result.structuredContent) ? result.structuredContent : null;
  }
  const text = textContent(result);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseFullConfig(
  body: Rec,
  requestedVersion: number,
  host?: HostModelKey,
): OneMcpGetConfigOutcome {
  const observedVersion = validVersion(body.version, false) ? body.version : undefined;
  if (!['upToDate', 'version', 'createdAt', 'updatedAt'].every((key) => hasOwn(body, key))) {
    return invalid('invalid-full-config', observedVersion);
  }
  if (body.upToDate !== false || !validVersion(body.version, false) || body.version === requestedVersion) {
    return invalid('invalid-full-config', observedVersion);
  }
  const createdAt = canonicalTimestamp(body.createdAt);
  const updatedAt = canonicalTimestamp(body.updatedAt);
  if (!createdAt || !updatedAt || Date.parse(updatedAt) < Date.parse(createdAt)) {
    return invalid('invalid-full-config', observedVersion);
  }
  const payload = parsePayloadDetailed(body, host);
  if (typeof payload === 'string') return invalid(payload, observedVersion);
  const config: OneMcpCanonicalFullConfig = Object.freeze({
    payload,
    version: body.version,
    createdAt,
    updatedAt,
  });
  return {
    kind: 'full',
    config,
    payloadFingerprint: oneMcpPayloadFingerprint(payload),
  };
}

function hostForConfigName(configName: string): HostModelKey | undefined {
  return HOST_IDS.find((host) => ONE_MCP_CONFIG_NAME_BY_HOST[host] === configName);
}

export function buildOneMcpGetConfigRequest(
  configName: string,
  version: number,
  id: JsonRpcId = 1,
): OneMcpJsonRpcRequest {
  if (!CONFIG_NAME_RE.test(configName)) throw new TypeError('invalid one-mcp config name');
  if (!validVersion(version, true)) throw new TypeError('invalid one-mcp cached config version');
  if (!((typeof id === 'string' && id.length > 0 && id.length <= 128)
    || (typeof id === 'number' && Number.isSafeInteger(id)))) {
    throw new TypeError('invalid one-mcp JSON-RPC id');
  }
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: ONE_MCP_GET_CONFIG_TOOL,
      arguments: { config_name: configName, version },
    },
  };
}

export function classifyOneMcpGetConfigResponse(
  response: unknown,
  requestedVersion: number,
  expectedId: JsonRpcId = 1,
  host?: HostModelKey,
): OneMcpGetConfigOutcome {
  if (!validVersion(requestedVersion, true)) return invalid('invalid-json-rpc-envelope');
  // Account for the JSON-RPC + CallToolResult wrapper without weakening the
  // configured depth bound on the operator payload itself.
  if (!safeObjectGraph(response, ONE_MCP_MAX_PAYLOAD_DEPTH + 8)) return invalid('unsafe-object-graph');
  if (!isRecord(response)
    || !hasOwn(response, 'jsonrpc') || !hasOwn(response, 'id')
    || response.jsonrpc !== '2.0' || response.id !== expectedId) {
    return invalid('invalid-json-rpc-envelope');
  }
  const hasResult = Object.prototype.hasOwnProperty.call(response, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(response, 'error');
  if (hasResult === hasError) return invalid('invalid-json-rpc-envelope');

  if (hasError) {
    const error = isRecord(response.error) ? response.error : null;
    if (error && hasOwn(error, 'message') && error.message === 'get_config: temporary backend error') {
      return { kind: 'temporary-error' };
    }
    return invalid('unexpected-json-rpc-error');
  }

  const result = isRecord(response.result) ? response.result : null;
  const hasIsError = result ? hasOwn(result, 'isError') : false;
  if (!result || (hasIsError && typeof result.isError !== 'boolean')) {
    return invalid('invalid-tool-result');
  }
  if (hasIsError && result.isError === true) {
    return textContent(result) === 'config_not_found'
      ? { kind: 'config-not-found' }
      : invalid('invalid-tool-result');
  }

  const body = successBody(result);
  if (!body) return invalid('invalid-tool-result');
  if (!safeObjectGraph(body, ONE_MCP_MAX_PAYLOAD_DEPTH)) return invalid('unsafe-object-graph');
  if (hasOwn(body, 'upToDate') && body.upToDate === true) {
    return hasOwn(body, 'version') && validVersion(body.version, true) && body.version === requestedVersion
      ? { kind: 'up-to-date', version: body.version }
      : invalid(
        'invalid-up-to-date-sentinel',
        validVersion(body.version, true) ? body.version : undefined,
      );
  }
  return parseFullConfig(body, requestedVersion, host);
}

export async function callOneMcpGetConfig(
  endpoint: string,
  configName: string,
  version: number,
  options: OneMcpGetConfigOptions = {},
): Promise<OneMcpGetConfigOutcome> {
  const request = buildOneMcpGetConfigRequest(configName, version, options.requestId ?? 1);
  const response = await postOneMcpJsonRpc(endpoint, request, options);
  return classifyOneMcpGetConfigResponse(
    response,
    version,
    request.id,
    hostForConfigName(configName),
  );
}
