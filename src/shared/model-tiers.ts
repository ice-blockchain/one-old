// src/shared/model-tiers.ts
// Functions that interpret the host-agnostic tier/host/plan config. The tunable
// data (tier ids, host model map, plan tables, alias maps) lives in
// src/config/model-tiers.ts — edit knobs there, not here.

import {
  DEFAULT_HOST_PLAN,
  HOST_IDS,
  HOST_MODELS,
  HOST_PLAN_IDS,
  PLAN_ALIASES,
  PLAN_IDS,
  PLAN_TIER_RECOMMENDATIONS,
  TIER_ALIASES,
  TIER_IDS,
  type HostModelKey,
  type TierId,
  type UserPlan,
} from '../config/model-tiers';

export function canonicalTier(tier: unknown): TierId | null {
  if (typeof tier !== 'string') return null;
  const value = tier.trim().toLowerCase();
  if ((TIER_IDS as readonly string[]).includes(value)) return value as TierId;
  return TIER_ALIASES[value] ?? null;
}

export function canonicalHost(host: unknown): HostModelKey {
  if (typeof host !== 'string') return 'claude';
  const value = host.trim().toLowerCase();
  return (HOST_IDS as readonly string[]).includes(value) ? (value as HostModelKey) : 'claude';
}

export function resolveModel(tier: unknown, host: unknown): string | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  return HOST_MODELS[canonicalHost(host)][canonical];
}

export function tierModelTable(
  tier: unknown,
): { tier: TierId; claude: string; codex: string; cursor: string } | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  return {
    tier: canonical,
    claude: HOST_MODELS.claude[canonical],
    codex: HOST_MODELS.codex[canonical],
    cursor: HOST_MODELS.cursor[canonical],
  };
}

export function canonicalPlan(host: unknown, plan: unknown): UserPlan {
  const h = canonicalHost(host);
  const fallback = DEFAULT_HOST_PLAN[h];
  if (typeof plan !== 'string') return fallback;
  const value = plan.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const resolved = (PLAN_IDS as readonly string[]).includes(value)
    ? (value as UserPlan)
    : (PLAN_ALIASES[value] ?? null);
  if (!resolved) return fallback;
  return HOST_PLAN_IDS[h].has(resolved) ? resolved : fallback;
}

export function recommendTierForPlan(host: unknown, plan: unknown, useOpenCode = false): TierId {
  const h = canonicalHost(host);
  const p = canonicalPlan(h, plan);
  const table = PLAN_TIER_RECOMMENDATIONS[h];
  const choice = table[p] ?? table[DEFAULT_HOST_PLAN[h]];
  if (!choice) return 'balanced';
  return useOpenCode ? choice.withOpenCode : choice.base;
}
