// Deterministic operator publication artifacts for the anonymous One MCP
// model catalog. HOST_MODELS remains the only editable catalog: this module
// expands its sparse plan overrides into the complete schema-v2 wire shape and
// renders the reviewed rows into a fail-closed SQL CAS template.

import * as fs from 'node:fs';

import {
  HOST_IDS,
  HOST_MODELS,
  type HostModelKey,
} from '../../config/model-tiers';
import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_OPERATOR_MANIFEST_SCHEMA_VERSION,
  ONE_MCP_LIVE_RELEASE_SNAPSHOT_MAX_AGE_MS,
  ONE_MCP_LIVE_RELEASE_SNAPSHOT_SCHEMA_VERSION,
  ONE_MCP_PAYLOAD_SCHEMA_VERSION,
} from '../../config/one-mcp';
import { bundledOneMcpPayload } from '../../shared/one-mcp/bundled-catalog';
import { oneMcpPayloadFingerprint } from '../../shared/one-mcp/fingerprint';
import { parseOneMcpModelConfigPayload } from '../../shared/one-mcp/get-config';
import type { OneMcpModelConfigPayloadV2 } from '../../shared/one-mcp/types';

export interface OneMcpOperatorRow {
  readonly host: HostModelKey;
  readonly configName: string;
  readonly catalogUpdatedAt: string;
  readonly payloadFingerprint: string;
  readonly payload: OneMcpModelConfigPayloadV2;
}

export interface OneMcpOperatorManifestV1 {
  readonly schemaVersion: 1;
  readonly payloadSchemaVersion: 2;
  readonly generatedFrom: 'src/config/model-tiers.ts#HOST_MODELS';
  readonly versionPolicy: 'compare-and-swap-increment';
  readonly rows: readonly OneMcpOperatorRow[];
}

export interface OneMcpLiveReleaseRowV2 {
  readonly host: HostModelKey;
  readonly configName: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly servedPublicly: true;
  readonly payloadFingerprint: string;
  readonly payload: OneMcpModelConfigPayloadV2;
}

export interface OneMcpLiveProbeResultV2 {
  readonly outcome: 'full' | 'up-to-date';
  readonly requestedVersion: number;
  readonly observedVersion: number;
  readonly payloadFingerprint?: string;
}

export interface OneMcpLiveHostProbeV2 {
  readonly host: HostModelKey;
  readonly configName: string;
  readonly checkedAt: string;
  readonly json: OneMcpLiveProbeResultV2;
  readonly sse: OneMcpLiveProbeResultV2;
  readonly upToDate: OneMcpLiveProbeResultV2;
}

export interface OneMcpLiveReleaseEvidenceV2 {
  readonly hostedOnboarding: {
    readonly checkedAt: string;
    readonly route: '/onboarding/agent';
    readonly outcome: 'passed';
  };
  readonly publicProbes: readonly OneMcpLiveHostProbeV2[];
  readonly codexHookObservation: {
    readonly checkedAt: string;
    readonly outcome: 'passed';
    readonly observations: readonly [{
      readonly tier: 'highest';
      readonly model: 'gpt-5.6-sol';
      readonly hookEvent: 'SubagentStart' | 'PreToolUse';
    }, {
      readonly tier: 'balanced';
      readonly model: 'gpt-5.6-terra';
      readonly hookEvent: 'SubagentStart' | 'PreToolUse';
    }];
  };
}

export interface OneMcpLiveReleaseSnapshotV2 {
  readonly schemaVersion: 2;
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly rows: readonly OneMcpLiveReleaseRowV2[];
  readonly evidence: OneMcpLiveReleaseEvidenceV2;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function releaseSnapshotError(reason: string): never {
  throw new Error(`One MCP public release blocked: live row snapshot ${reason}`);
}

function assertFreshEvidenceTimestamp(value: unknown, label: string, nowMs: number): void {
  if (!validTimestamp(value)) releaseSnapshotError(`${label} timestamp is invalid`);
  const checkedAt = Date.parse(value);
  if (checkedAt > nowMs + 5 * 60 * 1000 || nowMs - checkedAt > ONE_MCP_LIVE_RELEASE_SNAPSHOT_MAX_AGE_MS) {
    releaseSnapshotError(`${label} evidence is stale or from the future`);
  }
}

function assertLiveProbeResult(
  value: unknown,
  label: string,
  expectedOutcome: 'full' | 'up-to-date',
  expectedVersion: number,
  expectedFingerprint: string,
): void {
  const raw = record(value);
  const expectedKeys = expectedOutcome === 'full'
    ? ['outcome', 'requestedVersion', 'observedVersion', 'payloadFingerprint']
    : ['outcome', 'requestedVersion', 'observedVersion'];
  if (!raw || !hasExactKeys(raw, expectedKeys)) releaseSnapshotError(`${label} evidence is malformed`);
  if (raw.outcome !== expectedOutcome
    || raw.requestedVersion !== (expectedOutcome === 'full' ? 0 : expectedVersion)
    || raw.observedVersion !== expectedVersion) {
    releaseSnapshotError(`${label} did not observe the published version`);
  }
  if (expectedOutcome === 'full' && raw.payloadFingerprint !== expectedFingerprint) {
    releaseSnapshotError(`${label} payload fingerprint differs from HOST_MODELS`);
  }
}

function assertLiveReleaseEvidence(
  value: unknown,
  rowsByHost: ReadonlyMap<HostModelKey, OneMcpLiveReleaseRowV2>,
  manifest: OneMcpOperatorManifestV1,
  nowMs: number,
): void {
  const evidence = record(value);
  if (!evidence || !hasExactKeys(evidence, ['hostedOnboarding', 'publicProbes', 'codexHookObservation'])) {
    releaseSnapshotError('evidence bundle is missing or malformed');
  }

  const onboarding = record(evidence.hostedOnboarding);
  if (!onboarding
    || !hasExactKeys(onboarding, ['checkedAt', 'route', 'outcome'])
    || onboarding.route !== '/onboarding/agent'
    || onboarding.outcome !== 'passed') {
    releaseSnapshotError('hosted onboarding smoke evidence is missing or failed');
  }
  assertFreshEvidenceTimestamp(onboarding.checkedAt, 'hosted onboarding smoke', nowMs);

  if (!Array.isArray(evidence.publicProbes) || evidence.publicProbes.length !== manifest.rows.length) {
    releaseSnapshotError('must contain JSON, SSE, and upToDate probe evidence for every host');
  }
  const seen = new Set<HostModelKey>();
  const expectedByHost = new Map(manifest.rows.map((row) => [row.host, row]));
  for (const value of evidence.publicProbes) {
    const probe = record(value);
    if (!probe
      || !hasExactKeys(probe, ['host', 'configName', 'checkedAt', 'json', 'sse', 'upToDate'])
      || typeof probe.host !== 'string'
      || !expectedByHost.has(probe.host as HostModelKey)) {
      releaseSnapshotError('public probe evidence contains an unknown host or field');
    }
    const host = probe.host as HostModelKey;
    if (seen.has(host)) releaseSnapshotError(`public probe evidence contains duplicate host ${host}`);
    seen.add(host);
    const expected = expectedByHost.get(host)!;
    const live = rowsByHost.get(host);
    if (!live || probe.configName !== expected.configName) {
      releaseSnapshotError(`${host} public probe config_name does not match`);
    }
    assertFreshEvidenceTimestamp(probe.checkedAt, `${host} public probes`, nowMs);
    assertLiveProbeResult(probe.json, `${host} JSON probe`, 'full', live.version, expected.payloadFingerprint);
    assertLiveProbeResult(probe.sse, `${host} SSE probe`, 'full', live.version, expected.payloadFingerprint);
    assertLiveProbeResult(probe.upToDate, `${host} upToDate probe`, 'up-to-date', live.version, expected.payloadFingerprint);
  }

  const codex = record(evidence.codexHookObservation);
  if (!codex
    || !hasExactKeys(codex, ['checkedAt', 'outcome', 'observations'])
    || codex.outcome !== 'passed'
    || !Array.isArray(codex.observations)
    || codex.observations.length !== 2) {
    releaseSnapshotError('live Codex hook evidence is missing or failed');
  }
  assertFreshEvidenceTimestamp(codex.checkedAt, 'live Codex hook', nowMs);
  const expectedModels = new Map([['highest', 'gpt-5.6-sol'], ['balanced', 'gpt-5.6-terra']]);
  const observedTiers = new Set<string>();
  for (const value of codex.observations) {
    const observation = record(value);
    if (!observation
      || !hasExactKeys(observation, ['tier', 'model', 'hookEvent'])
      || typeof observation.tier !== 'string'
      || observedTiers.has(observation.tier)
      || observation.model !== expectedModels.get(observation.tier)
      || (observation.hookEvent !== 'SubagentStart' && observation.hookEvent !== 'PreToolUse')) {
      releaseSnapshotError('live Codex hook evidence did not observe exact Sol and Terra models');
    }
    observedTiers.add(observation.tier);
  }
  if (observedTiers.size !== expectedModels.size) {
    releaseSnapshotError('live Codex hook evidence did not cover highest and balanced tiers');
  }
}

function canonicalExactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalExactJson);
  const raw = record(value);
  if (!raw) return value;
  return Object.fromEntries(
    Object.keys(raw).sort().map((key) => [key, canonicalExactJson(raw[key])]),
  );
}

// Validate bounded release evidence for the seven LIVE rows. Endpoint safety
// alone is insufficient: a custom domain can still serve stale or cross-host
// payloads. A Milestone-2 generator run accepts only a fresh exact row snapshot,
// public JSON/SSE/upToDate probes, hosted onboarding smoke, and live Codex model
// observations. The schema intentionally has no free-form text or identity data.
export function assertOneMcpLiveReleaseSnapshot(
  value: unknown,
  endpoint: string,
  manifest: OneMcpOperatorManifestV1 = oneMcpOperatorManifest(),
  nowMs: number = Date.now(),
): asserts value is OneMcpLiveReleaseSnapshotV2 {
  const raw = record(value);
  if (!raw
    || !hasExactKeys(raw, ['schemaVersion', 'endpoint', 'capturedAt', 'rows', 'evidence'])
    || raw.schemaVersion !== ONE_MCP_LIVE_RELEASE_SNAPSHOT_SCHEMA_VERSION) {
    releaseSnapshotError('has an unsupported schema');
  }
  if (raw.endpoint !== endpoint) releaseSnapshotError('endpoint does not match the compiled public endpoint');
  if (!validTimestamp(raw.capturedAt)) releaseSnapshotError('capturedAt is invalid');
  const capturedAt = Date.parse(raw.capturedAt);
  if (capturedAt > nowMs + 5 * 60 * 1000 || nowMs - capturedAt > ONE_MCP_LIVE_RELEASE_SNAPSHOT_MAX_AGE_MS) {
    releaseSnapshotError('is stale or from the future');
  }
  if (!Array.isArray(raw.rows) || raw.rows.length !== manifest.rows.length) {
    releaseSnapshotError('must contain exactly seven rows');
  }

  const seen = new Set<string>();
  const liveRows = new Map<HostModelKey, OneMcpLiveReleaseRowV2>();
  const expectedByHost = new Map(manifest.rows.map((row) => [row.host, row]));
  for (const item of raw.rows) {
    const row = record(item);
    if (!row
      || !hasExactKeys(row, ['host', 'configName', 'version', 'updatedAt', 'servedPublicly', 'payloadFingerprint', 'payload'])
      || typeof row.host !== 'string'
      || !expectedByHost.has(row.host as HostModelKey)) {
      releaseSnapshotError('contains an unknown host');
    }
    const host = row.host as HostModelKey;
    if (seen.has(host)) releaseSnapshotError(`contains duplicate host ${host}`);
    seen.add(host);
    const expected = expectedByHost.get(host)!;
    if (row.configName !== expected.configName) releaseSnapshotError(`${host} config_name does not match`);
    // The pre-release seed is version 1. A public row must have passed at least
    // one reviewed CAS publication before release activation.
    if (!Number.isInteger(row.version) || (row.version as number) < 2) {
      releaseSnapshotError(`${host} version was not incremented`);
    }
    if (!validTimestamp(row.updatedAt)
      || Date.parse(row.updatedAt) < Date.parse(`${expected.catalogUpdatedAt}T00:00:00.000Z`)) {
      releaseSnapshotError(`${host} updatedAt predates the bundled catalog`);
    }
    if (row.servedPublicly !== true) releaseSnapshotError(`${host} is not served_publicly`);
    const payload = parseOneMcpModelConfigPayload(row.payload, host);
    if (!payload) releaseSnapshotError(`${host} payload is invalid`);
    const fingerprint = oneMcpPayloadFingerprint(payload);
    if (row.payloadFingerprint !== fingerprint || fingerprint !== expected.payloadFingerprint) {
      releaseSnapshotError(`${host} payload fingerprint differs from HOST_MODELS`);
    }
    // Runtime decoding is additive-tolerant, but activation proof is exact: a
    // live row with an unreviewed field/tier must not pass merely because the
    // decoder drops it before comparison. Object key order is irrelevant;
    // array/model order and the complete structural key set are not.
    if (JSON.stringify(canonicalExactJson(row.payload))
      !== JSON.stringify(canonicalExactJson(expected.payload))) {
      releaseSnapshotError(`${host} payload differs from HOST_MODELS`);
    }
    liveRows.set(host, row as unknown as OneMcpLiveReleaseRowV2);
  }
  if (seen.size !== HOST_IDS.length) releaseSnapshotError('does not cover every host');
  assertLiveReleaseEvidence(raw.evidence, liveRows, manifest, nowMs);
}

export function assertOneMcpLiveReleaseSnapshotFile(
  filePath: string,
  endpoint: string,
  manifest: OneMcpOperatorManifestV1 = oneMcpOperatorManifest(),
  nowMs: number = Date.now(),
): void {
  if (!filePath) releaseSnapshotError('path is missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    releaseSnapshotError('cannot be read as JSON');
  }
  assertOneMcpLiveReleaseSnapshot(parsed, endpoint, manifest, nowMs);
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function oneMcpOperatorManifest(): OneMcpOperatorManifestV1 {
  const rows = HOST_IDS.map((host): OneMcpOperatorRow => {
    const config = HOST_MODELS[host];
    if (!validDateOnly(config.updatedAt)) {
      throw new Error(`One MCP operator catalog has invalid ${host}.updatedAt: ${config.updatedAt}`);
    }
    const payload = bundledOneMcpPayload(host, config);
    return Object.freeze({
      host,
      configName: ONE_MCP_CONFIG_NAME_BY_HOST[host],
      catalogUpdatedAt: config.updatedAt,
      payloadFingerprint: oneMcpPayloadFingerprint(payload),
      payload,
    });
  });
  return Object.freeze({
    schemaVersion: ONE_MCP_OPERATOR_MANIFEST_SCHEMA_VERSION,
    payloadSchemaVersion: ONE_MCP_PAYLOAD_SCHEMA_VERSION,
    generatedFrom: 'src/config/model-tiers.ts#HOST_MODELS',
    versionPolicy: 'compare-and-swap-increment',
    rows: Object.freeze(rows),
  });
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function oneMcpOperatorCasSql(
  manifest: OneMcpOperatorManifestV1 = oneMcpOperatorManifest(),
): string {
  const values = manifest.rows.map((row) => [
    '  (',
    sqlLiteral(row.host), ', ',
    sqlLiteral(row.configName), ', ',
    `${sqlLiteral(row.catalogUpdatedAt)}::date, `,
    // Intentionally non-runnable. An operator must replace every NULL with the
    // version observed immediately before applying the reviewed transaction.
    'null::integer, ',
    sqlLiteral(row.payloadFingerprint), ', ',
    `${sqlLiteral(JSON.stringify(row.payload))}::jsonb`,
    ')',
  ].join('')).join(',\n');

  return [
    '-- GENERATED by `npm run gen` from src/config/model-tiers.ts#HOST_MODELS.',
    '-- REVIEW REQUIRED: replace every null::integer expected_version below with',
    '-- the currently observed public.plugin_config.version. The transaction',
    '-- refuses missing/unpublished rows, stale versions, partial updates, and',
    '-- integer overflow. It never changes served_publicly.',
    '',
    'begin;',
    '',
    'create temporary table traffic_one_one_mcp_desired (',
    '  host text primary key,',
    '  config_name text unique not null,',
    '  catalog_updated_at date not null,',
    '  expected_version integer,',
    '  payload_fingerprint text not null,',
    '  payload jsonb not null',
    ') on commit drop;',
    '',
    'insert into traffic_one_one_mcp_desired (',
    '  host, config_name, catalog_updated_at, expected_version, payload_fingerprint, payload',
    ') values',
    `${values};`,
    '',
    'do $traffic_one_preflight$',
    'begin',
    '  if exists (',
    '    select 1 from traffic_one_one_mcp_desired',
    '    where expected_version is null or expected_version < 1 or expected_version >= 2147483647',
    '  ) then',
    "    raise exception 'fill every Traffic One expected_version with an integer in [1, 2147483646]';",
    '  end if;',
    '',
    `  if (select count(*) from traffic_one_one_mcp_desired) <> ${manifest.rows.length} then`,
    "    raise exception 'Traffic One operator manifest does not contain every host';",
    '  end if;',
    '',
    '  if exists (',
    '    select 1',
    '    from traffic_one_one_mcp_desired d',
    '    left join public.plugin_config pc on pc.config_name = d.config_name',
    '    where pc.config_name is null',
    '  ) then',
    "    raise exception 'a Traffic One plugin_config row is missing; seed it unpublished and review it separately';",
    '  end if;',
    '',
    '  if exists (',
    '    select 1',
    '    from traffic_one_one_mcp_desired d',
    '    join public.plugin_config pc on pc.config_name = d.config_name',
    '    where pc.served_publicly is distinct from true',
    '  ) then',
    "    raise exception 'a Traffic One plugin_config row is not already published';",
    '  end if;',
    '',
    '  if exists (',
    '    select 1',
    '    from traffic_one_one_mcp_desired d',
    '    join public.plugin_config pc on pc.config_name = d.config_name',
    '    where pc.version is distinct from d.expected_version',
    '  ) then',
    "    raise exception 'Traffic One plugin_config CAS preflight failed; re-read versions and regenerate/review';",
    '  end if;',
    'end',
    '$traffic_one_preflight$;',
    '',
    'do $traffic_one_cas$',
    'declare',
    '  changed_count integer;',
    'begin',
    '  update public.plugin_config pc',
    '  set payload = d.payload,',
    '      version = pc.version + 1,',
    '      updated_at = now()',
    '  from traffic_one_one_mcp_desired d',
    '  where pc.config_name = d.config_name',
    '    and pc.version = d.expected_version;',
    '',
    '  get diagnostics changed_count = row_count;',
    '  if changed_count <> (select count(*) from traffic_one_one_mcp_desired) then',
    "    raise exception 'Traffic One plugin_config CAS update was partial; transaction rolled back';",
    '  end if;',
    'end',
    '$traffic_one_cas$;',
    '',
    'do $traffic_one_verify$',
    'begin',
    '  if exists (',
    '    select 1',
    '    from traffic_one_one_mcp_desired d',
    '    join public.plugin_config pc on pc.config_name = d.config_name',
    '    where pc.version <> d.expected_version + 1',
    '       or pc.payload is distinct from d.payload',
    '       or pc.served_publicly is distinct from true',
    '  ) then',
    "    raise exception 'Traffic One plugin_config post-update verification failed; transaction rolled back';",
    '  end if;',
    'end',
    '$traffic_one_verify$;',
    '',
    'select',
    '  d.host,',
    '  pc.config_name,',
    '  pc.version,',
    '  pc.updated_at,',
    '  d.catalog_updated_at,',
    '  d.payload_fingerprint',
    'from traffic_one_one_mcp_desired d',
    'join public.plugin_config pc on pc.config_name = d.config_name',
    'order by d.host;',
    '',
    'commit;',
    '',
  ].join('\n');
}
