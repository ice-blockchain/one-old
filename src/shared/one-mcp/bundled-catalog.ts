// Canonical projection from the bundled HOST_MODELS catalog to the public One
// MCP plan-aware wire payload. Runtime bundled fallback, drift fingerprints, and
// operator generation all consume this function so their semantics cannot
// diverge through parallel mapping logic.

import {
  HOST_MODELS,
  HOST_PLAN_IDS,
  PLAN_IDS,
  allowsSingleModelTierRow,
  type HostModelKey,
  type HostModelsConfig,
  type ModelRow,
  type TierId,
  type UserPlan,
} from '../../config/model-tiers';
import {
  ONE_MCP_MAX_MODELS_PER_TIER,
  ONE_MCP_MAX_PUBLISHED_PAYLOAD_BYTES,
  isSafeOneMcpModelId,
} from '../../config/one-mcp';
import type { OneMcpModelConfigPayload, OneMcpRemoteTiers } from './types';

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalRow(
  host: HostModelKey,
  row: ModelRow,
  label: string,
  plan?: UserPlan,
): readonly string[] {
  if (row.length === 0) throw new Error(`One MCP bundled row ${label} is empty`);
  if (row.length < 2 && !allowsSingleModelTierRow(host, plan)) {
    throw new Error(
      `One MCP bundled row ${label} has one model; at least 2 are required unless explicitly allowlisted`,
    );
  }
  if (row.length > ONE_MCP_MAX_MODELS_PER_TIER) {
    throw new Error(
      `One MCP bundled row ${label} has ${row.length} models; the decoder allows ${ONE_MCP_MAX_MODELS_PER_TIER}`,
    );
  }
  const models = [...row];
  if (models.some((model) => !isSafeOneMcpModelId(model, host))) {
    throw new Error(`One MCP bundled row ${label} contains an invalid model id`);
  }
  if (new Set(models).size !== models.length) {
    throw new Error(`One MCP bundled row ${label} contains duplicate model ids`);
  }
  return Object.freeze(models);
}

function remoteTiers(
  host: HostModelKey,
  config: HostModelsConfig,
  plan?: UserPlan,
): OneMcpRemoteTiers {
  const override = plan ? config.plans?.[plan] : undefined;
  const row = (tier: TierId): readonly string[] => canonicalRow(
    host,
    override?.[tier] ?? config.tiers[tier],
    `${host}${plan ? `.${plan}` : ''}.${tier}`,
    plan,
  );
  const high = row('highest');
  const balanced = row('balanced');
  const low = row('cheapest');
  return Object.freeze({
    high,
    balanced,
    low,
    // Auto is intentionally catalog-only and mirrors the fully resolved
    // balanced row, including order and fallbacks.
    auto: Object.freeze([...balanced]),
  });
}

// `config` is injectable for pure validation tests. Production callers omit it
// and therefore always project the matching HOST_MODELS entry.
export function bundledOneMcpPayload(
  host: HostModelKey,
  config: HostModelsConfig = HOST_MODELS[host],
): OneMcpModelConfigPayload {
  const plans: Partial<Record<UserPlan, OneMcpRemoteTiers>> = {};
  for (const rawPlan of Object.keys(config.plans ?? {})) {
    if (!(PLAN_IDS as readonly string[]).includes(rawPlan)) {
      throw new Error(`One MCP bundled catalog has unknown ${host} plan override: ${rawPlan}`);
    }
    if (!HOST_PLAN_IDS[host].has(rawPlan as UserPlan)) {
      throw new Error(`One MCP bundled catalog has unsupported ${host} plan override: ${rawPlan}`);
    }
  }
  for (const plan of PLAN_IDS) {
    if (!config.plans || !hasOwn(config.plans, plan)) continue;
    plans[plan] = remoteTiers(host, config, plan);
  }
  const payload: OneMcpModelConfigPayload = Object.freeze({
    tiers: remoteTiers(host, config),
    ...(Object.keys(plans).length > 0 ? { plans: Object.freeze(plans) } : {}),
  });
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > ONE_MCP_MAX_PUBLISHED_PAYLOAD_BYTES) {
    throw new Error(
      `One MCP bundled payload for ${host} is ${bytes} bytes; public.plugin_config allows ${ONE_MCP_MAX_PUBLISHED_PAYLOAD_BYTES}`,
    );
  }
  return payload;
}
