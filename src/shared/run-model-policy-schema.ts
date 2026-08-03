// src/shared/run-model-policy-schema.ts
// Model-policy schema, parse/validation, and read.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AGENT_ROLES } from '../config/performance';
import {
  isSafeOneMcpModelId,
  ONE_MCP_MAX_AVAILABLE_MODELS,
  ONE_MCP_MAX_CONFIG_VERSION,
  ONE_MCP_MAX_MODELS_PER_TIER,
} from '../config/one-mcp';
import type { HostModelKey, TierId, UserPlan } from '../config/model-tiers';
import { RUNS_REL_DIR, VALID_AGENT_ROLES } from '../config/state';
import {
  RUN_HOST_CAPABILITY_RELATIVE_FILE,
} from './host/capabilities';
import { canonicalHost, canonicalPlan, modelMatchesExpected, type ModelTierSnapshot } from './model-tiers';
import { obj } from './obj';

export const RUN_MODEL_POLICY_SCHEMA_VERSION = 1;
const POLICY_FILE = 'model-policy.json';
export const POLICY_LOCK_TIMEOUT_MS = 1_000;
export const POLICY_LOCK_STALE_MS = 10_000;

export interface RunRoleModelPolicy {
  readonly tier: TierId;
  readonly preferredModel: string;
  readonly acceptableModels: readonly string[];
}

export interface RunModelPolicyV1 {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly runId: string;
  readonly host: HostModelKey;
  readonly hostCapabilityFile: typeof RUN_HOST_CAPABILITY_RELATIVE_FILE;
  readonly plan: UserPlan;
  readonly source: 'remote' | 'bundled';
  readonly configVersion: number | null;
  readonly payloadFingerprint: string;
  readonly appliedFingerprint: string;
  readonly performanceLevel: string;
  readonly teamOverrides: Readonly<Record<string, TierId>>;
  readonly tiers: ModelTierSnapshot;
  readonly roles: Readonly<Record<string, RunRoleModelPolicy>>;
  readonly cursorAvailableModels?: readonly string[];
  readonly capturedAt: string;
}

export interface RunPolicyFallbackRequest {
  readonly tier: TierId;
  readonly exhaustedModels?: readonly string[];
  readonly unavailableModels?: readonly string[];
  readonly capturedModels?: readonly string[];
}

export interface RunPolicyFallbackCandidate {
  readonly family: string;
  readonly model: string;
}

function sameModelFamily(left: string, right: string): boolean {
  return modelMatchesExpected(left, right) || modelMatchesExpected(right, left);
}

export function resolveRunPolicyFallback(
  policy: RunModelPolicyV1,
  request: RunPolicyFallbackRequest,
): RunPolicyFallbackCandidate | null {
  const row = policy.tiers[request.tier] || [];
  const excluded = [
    ...(request.exhaustedModels || []),
    ...(request.unavailableModels || []),
  ].filter((model) => typeof model === 'string' && model.trim().length > 0);
  for (const family of row) {
    if (excluded.some((model) => sameModelFamily(model, family))) continue;
    if (request.capturedModels !== undefined) {
      const model = request.capturedModels.find((candidate) => modelMatchesExpected(candidate, family));
      if (!model) continue;
      return { family, model };
    }
    return { family, model: family };
  }
  return null;
}

export function policyModelsForExpected(
  policy: RunModelPolicyV1,
  expected: string,
): readonly string[] {
  for (const row of Object.values(policy.tiers)) {
    const preferred = row[0];
    if (preferred && sameModelFamily(expected, preferred)) return row;
  }
  for (const row of Object.values(policy.tiers)) {
    if (row.some((candidate) => sameModelFamily(expected, candidate))) return row;
  }
  return expected ? [expected] : [];
}

function safeRunId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

export function runModelPolicyPath(cwd: string, runId: string): string {
  return path.join(cwd, RUNS_REL_DIR, safeRunId(runId), POLICY_FILE);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validModel(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function parseTierRows(value: unknown): ModelTierSnapshot | null {
  const raw = obj(value);
  if (!raw) return null;
  const out = {} as Record<TierId, readonly string[]>;
  for (const tier of ['highest', 'balanced', 'cheapest'] as const) {
    const row = raw[tier];
    if (!Array.isArray(row)
      || row.length === 0
      || row.length > ONE_MCP_MAX_MODELS_PER_TIER
      || !row.every(validModel)) return null;
    if (new Set(row).size !== row.length) return null;
    out[tier] = [...row];
  }
  return out;
}

function parsePolicy(value: unknown, expectedRunId?: string): RunModelPolicyV1 | null {
  const raw = obj(value);
  if (!raw
    || raw.schemaVersion !== RUN_MODEL_POLICY_SCHEMA_VERSION
    || typeof raw.policyId !== 'string'
    || !validFingerprint(raw.policyId)
    || typeof raw.runId !== 'string'
    || (expectedRunId && raw.runId !== expectedRunId)
    || typeof raw.host !== 'string'
    || raw.hostCapabilityFile !== RUN_HOST_CAPABILITY_RELATIVE_FILE
    || typeof raw.plan !== 'string'
    || (raw.source !== 'remote' && raw.source !== 'bundled')
    || !(raw.configVersion === null || (typeof raw.configVersion === 'number'
      && Number.isInteger(raw.configVersion)
      && raw.configVersion >= 0
      && raw.configVersion <= ONE_MCP_MAX_CONFIG_VERSION))
    || !validFingerprint(raw.payloadFingerprint)
    || !validFingerprint(raw.appliedFingerprint)
    || typeof raw.performanceLevel !== 'string'
    || typeof raw.capturedAt !== 'string') return null;
  const host = canonicalHost(raw.host);
  if (host !== raw.host) return null;
  const plan = canonicalPlan(host, raw.plan);
  if (plan !== raw.plan) return null;
  const tiers = parseTierRows(raw.tiers);
  const rolesRaw = obj(raw.roles);
  const overridesRaw = obj(raw.teamOverrides);
  if (!tiers || !rolesRaw || !overridesRaw) return null;
  const roles: Record<string, RunRoleModelPolicy> = {};
  for (const [role, value] of Object.entries(rolesRaw)) {
    if (!VALID_AGENT_ROLES.has(role)) return null;
    const item = obj(value);
    const tier = item?.tier;
    const acceptable = item?.acceptableModels;
    if ((tier !== 'highest' && tier !== 'balanced' && tier !== 'cheapest')
      || !validModel(item?.preferredModel)
      || !Array.isArray(acceptable)
      || acceptable.length === 0
      || !acceptable.every(validModel)
      || new Set(acceptable).size !== acceptable.length
      || acceptable[0] !== item.preferredModel
      || acceptable.length !== tiers[tier].length
      || acceptable.some((model) => !tiers[tier].includes(model))
      || tiers[tier].some((model) => !acceptable.includes(model))) return null;
    roles[role] = { tier, preferredModel: item.preferredModel, acceptableModels: [...acceptable] };
  }
  for (const role of [...AGENT_ROLES, 'quick-fix']) {
    if (!roles[role]) return null;
  }
  const teamOverrides: Record<string, TierId> = {};
  for (const [role, tier] of Object.entries(overridesRaw)) {
    if (!VALID_AGENT_ROLES.has(role)) continue;
    if (tier === 'highest' || tier === 'balanced' || tier === 'cheapest') teamOverrides[role] = tier;
  }
  const cursorAvailableModels = raw.cursorAvailableModels;
  if (host === 'cursor') {
    if (!Array.isArray(cursorAvailableModels)
      || cursorAvailableModels.length === 0
      || cursorAvailableModels.length > ONE_MCP_MAX_AVAILABLE_MODELS
      || !cursorAvailableModels.every((model) => isSafeOneMcpModelId(model, 'cursor'))
      || new Set(cursorAvailableModels).size !== cursorAvailableModels.length
      || missingCursorPolicyTiers(roles, cursorAvailableModels).length > 0) return null;
  } else if (cursorAvailableModels !== undefined) {
    return null;
  }
  const canonical = {
    schemaVersion: 1 as const,
    runId: raw.runId,
    host,
    hostCapabilityFile: RUN_HOST_CAPABILITY_RELATIVE_FILE as typeof RUN_HOST_CAPABILITY_RELATIVE_FILE,
    plan,
    source: raw.source as 'remote' | 'bundled',
    configVersion: raw.configVersion,
    payloadFingerprint: raw.payloadFingerprint,
    appliedFingerprint: raw.appliedFingerprint,
    performanceLevel: raw.performanceLevel,
    teamOverrides,
    tiers,
    roles,
    ...(host === 'cursor' ? { cursorAvailableModels: [...(cursorAvailableModels as string[])] } : {}),
  };
  if (sha256(JSON.stringify(canonical)) !== raw.policyId) return null;
  return { ...canonical, policyId: raw.policyId, capturedAt: raw.capturedAt };
}

export function readRunModelPolicy(cwd: string, runId: string): RunModelPolicyV1 | null {
  try {
    return parsePolicy(JSON.parse(fs.readFileSync(runModelPolicyPath(cwd, runId), 'utf8')), runId);
  } catch {
    return null;
  }
}


export function missingCursorPolicyTiers(
  roles: Readonly<Record<string, RunRoleModelPolicy>>,
  capturedModels: readonly string[],
): TierId[] {
  const missing = new Set<TierId>();
  for (const role of Object.values(roles)) {
    if (!capturedModels.some((model) => role.acceptableModels.some((family) => modelMatchesExpected(model, family)))) {
      missing.add(role.tier);
    }
  }
  return (['highest', 'balanced', 'cheapest'] as const).filter((tier) => missing.has(tier));
}
