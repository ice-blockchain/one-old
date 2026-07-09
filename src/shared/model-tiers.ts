// src/shared/model-tiers.ts
// Functions that interpret the host-agnostic tier/host/plan config. The tunable
// data (tier ids, host model map, plan tables, alias maps) lives in
// src/config/model-tiers.ts — edit knobs there, not here.

import {
  COPILOT_PLAN_MODELS,
  CURSOR_MODEL_ALTERNATES,
  CURSOR_PLAN_MODELS,
  DEFAULT_HOST_PLAN,
  HOST_IDS,
  HOST_MODELS,
  HOST_PLAN_IDS,
  KILO_MODEL_ALTERNATES,
  OPENCODE_MODEL_ALTERNATES,
  OPENCODE_PLAN_MODELS,
  PLAN_ALIASES,
  PLAN_IDS,
  PLAN_TIER_RECOMMENDATIONS,
  TIER_ALIASES,
  TIER_IDS,
  WINDSURF_PLAN_MODELS,
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

// Resolve a tier to a concrete model id for a host. Optional `plan` makes the
// Cursor row plan-aware via CURSOR_PLAN_MODELS (Free resolves frontier tiers to
// Composer; paid plans share the base HOST_MODELS.cursor row). claude/codex ignore
// `plan` — their rows are plan-agnostic.
export function resolveModel(tier: unknown, host: unknown, plan?: unknown): string | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  const h = canonicalHost(host);
  // Apply the per-plan overlay ONLY when a plan was explicitly supplied. A plan-agnostic
  // caller (no plan arg) keeps the generous base row — canonicalPlan(undefined) would
  // otherwise default to 'free' and silently downgrade every plan-less lookup to Composer.
  if (h === 'opencode' && plan !== undefined && plan !== null && plan !== '') {
    // OpenCode "Go" (plus) overlays the paid `opencode-go/*` catalog; free inherits the
    // base HOST_MODELS.opencode row (the `opencode/*-free` chain).
    const overlay = OPENCODE_PLAN_MODELS[canonicalPlan('opencode', plan)];
    const planned = overlay ? overlay[canonical] : undefined;
    if (planned) return planned;
  }
  if (h === 'cursor' && plan !== undefined && plan !== null && plan !== '') {
    const overlay = CURSOR_PLAN_MODELS[canonicalPlan('cursor', plan)];
    const planned = overlay ? overlay[canonical] : undefined;
    if (planned) return planned;
  }
  if (h === 'copilot' && plan !== undefined && plan !== null && plan !== '') {
    const overlay = COPILOT_PLAN_MODELS[canonicalPlan('copilot', plan)];
    const planned = overlay ? overlay[canonical] : undefined;
    if (planned) return planned;
  }
  if (h === 'windsurf' && plan !== undefined && plan !== null && plan !== '') {
    const overlay = WINDSURF_PLAN_MODELS[canonicalPlan('windsurf', plan)];
    const planned = overlay ? overlay[canonical] : undefined;
    if (planned) return planned;
  }
  return HOST_MODELS[h][canonical];
}

// Does a passed `model` parameter satisfy a tier's expected model? True when it IS
// that model OR a same-family VARIANT of it (the expected id followed by a `-suffix`).
// Cursor rows are family anchors whose concrete Task-tool slug is resolved from the captured
// model list when available, so this prefix match covers reasoning/build suffixes. A different
// family/tier (e.g. `gpt-5.5-medium` vs a highest opus family) never matches, so tier
// enforcement holds. Claude/Codex pass bare ids, so this is exact-equality there in practice.
// An empty/absent model never matches (deny → inherit guard). See acceptableModelsFor for the
// cursor same-tier fallback set.
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
  const h = canonicalHost(host);
  // OpenCode "Go" primaries carry a fallback chain (other Go models → free chain) so a
  // build never stalls on an unavailable paid model. claude/codex stay strict `[expected]`.
  const alternates = h === 'opencode'
    ? (OPENCODE_MODEL_ALTERNATES[e] ?? null)
    : h === 'kilo'
      ? (KILO_MODEL_ALTERNATES[e] ?? null)
    : (h === 'cursor' ? (CURSOR_MODEL_ALTERNATES[e] ?? []) : null);
  if (alternates === null) return [e];
  return [e, ...alternates.filter((m) => m && m !== e)];
}

// True when `passed` matches ANY model in the acceptable set (family-aware).
export function modelMatchesAny(passed: unknown, acceptable: readonly string[]): boolean {
  return acceptable.some((e) => modelMatchesExpected(passed, e));
}

// Optional `plan` makes the cursor cell plan-aware (Free → Composer for the
// frontier tiers). claude/codex cells are plan-agnostic.
export function tierModelTable(
  tier: unknown,
  plan?: unknown,
): { tier: TierId; claude: string; codex: string; cursor: string; opencode: string; copilot: string; windsurf: string; kilo: string } | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  return {
    tier: canonical,
    claude: HOST_MODELS.claude[canonical],
    codex: HOST_MODELS.codex[canonical],
    cursor: resolveModel(canonical, 'cursor', plan) ?? HOST_MODELS.cursor[canonical],
    opencode: resolveModel(canonical, 'opencode', plan) ?? HOST_MODELS.opencode[canonical],
    copilot: resolveModel(canonical, 'copilot', plan) ?? HOST_MODELS.copilot[canonical],
    windsurf: resolveModel(canonical, 'windsurf', plan) ?? HOST_MODELS.windsurf[canonical],
    kilo: resolveModel(canonical, 'kilo', plan) ?? HOST_MODELS.kilo[canonical],
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

// True when `plan` is a string we recognize as SOME canonical plan id (directly or
// via an alias), host-agnostic. host-plan.ts uses this to flag an UNRECOGNIZED raw
// membership string for follow-up — distinct from a recognized plan a host simply
// doesn't expose (which canonicalPlan also maps to the fallback). Mirrors
// canonicalPlan's normalization (note: `+` is not stripped, matching the `pro+` alias).
export function planIsRecognized(plan: unknown): boolean {
  if (typeof plan !== 'string') return false;
  const value = plan.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!value) return false;
  return (PLAN_IDS as readonly string[]).includes(value) || Object.prototype.hasOwnProperty.call(PLAN_ALIASES, value);
}

export function recommendTierForPlan(host: unknown, plan: unknown, useOpenCode = false): TierId {
  const h = canonicalHost(host);
  const p = canonicalPlan(h, plan);
  const table = PLAN_TIER_RECOMMENDATIONS[h];
  const choice = table[p] ?? table[DEFAULT_HOST_PLAN[h]];
  if (!choice) return 'balanced';
  return useOpenCode ? choice.withOpenCode : choice.base;
}
