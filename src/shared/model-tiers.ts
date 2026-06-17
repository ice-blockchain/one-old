// src/shared/model-tiers.ts
// Functions that interpret the host-agnostic tier/host/plan config. The tunable
// data (tier ids, host model map, plan tables, alias maps) lives in
// src/config/model-tiers.ts — edit knobs there, not here.

import {
  CURSOR_MODEL_ALTERNATES,
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

// Does a passed `model` parameter satisfy a tier's expected model? True when it IS
// that model OR a same-family VARIANT of it (the expected id followed by a `-suffix`).
// The cursor row already stores the full Task-tool slug (e.g.
// `claude-opus-4-8-thinking-high`), so this prefix match mainly covers a deeper
// sub-variant; a different family/tier (e.g. `gpt-5.5-medium` vs a highest opus slug)
// never matches, so tier enforcement holds. Claude/Codex pass bare ids, so this is
// exact-equality there in practice. An empty/absent model never matches (deny →
// inherit guard). See acceptableModelsFor for the cursor same-tier fallback set.
export function modelMatchesExpected(passed: unknown, expected: unknown): boolean {
  const e = typeof expected === 'string' ? expected.trim() : '';
  const p = typeof passed === 'string' ? passed.trim() : '';
  if (!e || !p) return false;
  return p === e || p.startsWith(`${e}-`);
}

// The full set of models that satisfy a tier whose PREFERRED model is `expected`,
// ordered preferred-first. On Cursor this folds in CURSOR_MODEL_ALTERNATES so a
// build that doesn't offer the preferred slug can still spawn on a same-class model
// the runner DOES offer (and the gate accepts it). claude/codex have no alternates
// → exactly `[expected]`, preserving strict per-tier enforcement there.
export function acceptableModelsFor(expected: unknown, host: unknown): string[] {
  const e = typeof expected === 'string' ? expected.trim() : '';
  if (!e) return [];
  if (canonicalHost(host) !== 'cursor') return [e];
  const alternates = CURSOR_MODEL_ALTERNATES[e] ?? [];
  return [e, ...alternates.filter((m) => m && m !== e)];
}

// True when `passed` matches ANY model in the acceptable set (family-aware).
export function modelMatchesAny(passed: unknown, acceptable: readonly string[]): boolean {
  return acceptable.some((e) => modelMatchesExpected(passed, e));
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
