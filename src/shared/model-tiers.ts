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
  type ModelRow,
  type TierId,
  type UserPlan,
} from '../config/model-tiers';
import { ONE_MCP_MAX_MODELS_PER_TIER } from '../config/one-mcp';

export type ModelTierSnapshot = Readonly<Record<TierId, readonly string[]>>;

export interface HostModelSnapshot {
  readonly plan: UserPlan;
  readonly tiers: ModelTierSnapshot;
}

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

function resolvedModelRow(tier: TierId, host: HostModelKey, plan?: unknown): ModelRow {
  const config = HOST_MODELS[host];
  if (plan !== undefined && plan !== null && plan !== '') {
    const override = config.plans?.[canonicalPlan(host, plan)]?.[tier];
    if (override) return override;
  }
  return config.tiers[tier];
}

// Resolve a tier to its preferred model. Supplying no plan deliberately uses
// the base row rather than canonicalizing to the host's Free default.
export function resolveModel(tier: unknown, host: unknown, plan?: unknown): string | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  const h = canonicalHost(host);
  return resolvedModelRow(canonical, h, plan)[0];
}

// Does a passed `model` parameter satisfy a tier's expected model? True when it IS
// that model OR a same-family VARIANT of it (the expected id followed by a `-suffix`).
// Cursor rows are family anchors whose concrete Task-tool slug is resolved from the captured
// model list when available, so this prefix match covers reasoning/build suffixes. A different
// family/tier (e.g. `gpt-5.6-terra-medium` vs a highest Fable family) never matches, so tier
// enforcement holds. Claude/Codex pass bare ids, so this is exact-equality there in practice.
// An empty/absent model never matches (deny → inherit guard).
export function modelMatchesExpected(passed: unknown, expected: unknown): boolean {
  const e = typeof expected === 'string' ? expected.trim() : '';
  const p = typeof passed === 'string' ? passed.trim() : '';
  if (!e || !p) return false;
  return p === e || p.startsWith(`${e}-`);
}

// Build the bundled/runtime applied catalog. Every tier is ordered preferred-first.
// Plan overrides replace a whole row and omitted rows inherit.
export function modelTierSnapshot(host: unknown, plan: unknown): ModelTierSnapshot {
  const h = canonicalHost(host);
  const p = plan === undefined || plan === null || plan === ''
    ? undefined
    : canonicalPlan(h, plan);
  return {
    highest: [...resolvedModelRow('highest', h, p)],
    balanced: [...resolvedModelRow('balanced', h, p)],
    cheapest: [...resolvedModelRow('cheapest', h, p)],
  };
}

export function hostModelSnapshot(host: unknown, plan: unknown): HostModelSnapshot {
  const h = canonicalHost(host);
  const p = canonicalPlan(h, plan);
  return {
    plan: p,
    tiers: modelTierSnapshot(h, p),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strictHost(value: unknown): HostModelKey | null {
  return typeof value === 'string' && (HOST_IDS as readonly string[]).includes(value)
    ? value as HostModelKey
    : null;
}

function strictPlan(value: unknown, host?: HostModelKey): UserPlan | null {
  if (typeof value !== 'string' || !(PLAN_IDS as readonly string[]).includes(value)) return null;
  const plan = value as UserPlan;
  return host && !HOST_PLAN_IDS[host].has(plan) ? null : plan;
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function parseTierSnapshot(value: unknown): ModelTierSnapshot | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== TIER_IDS.length || keys.some((key) => !(TIER_IDS as readonly string[]).includes(key))) return null;
  const parsed = {} as Record<TierId, readonly string[]>;
  for (const tier of TIER_IDS) {
    const models = value[tier];
    if (!Array.isArray(models)
      || models.length === 0
      || models.length > ONE_MCP_MAX_MODELS_PER_TIER
      || !models.every(validModelId)) return null;
    if (new Set(models).size !== models.length) return null;
    parsed[tier] = [...models];
  }
  return parsed;
}

export function parseHostModelSnapshot(value: unknown, expectedHost?: unknown): HostModelSnapshot | null {
  if (!isRecord(value)) return null;
  const host = expectedHost === undefined ? undefined : strictHost(expectedHost);
  if (expectedHost !== undefined && !host) return null;
  const plan = strictPlan(value.plan, host || undefined);
  const tiers = parseTierSnapshot(value.tiers);
  if (!plan || !tiers) return null;
  return { plan, tiers };
}

// True when `passed` matches ANY model in the acceptable set (family-aware).
export function modelMatchesAny(passed: unknown, acceptable: readonly string[]): boolean {
  return acceptable.some((e) => modelMatchesExpected(passed, e));
}

// Apply only aliases owned by the active host. Claude Code exposes `fable` and
// `best` as native selectors for its strongest available Claude model. They may
// satisfy a row that explicitly contains a Fable/Opus model, without occupying
// another bounded catalog slot. Keeping this mapping host-aware is important:
// Cursor accepts concrete model ids/families and rejects these Claude aliases.
export function modelMatchesHostModels(
  passed: unknown,
  acceptable: readonly string[],
  host: unknown,
): boolean {
  const passedId = typeof passed === 'string' ? passed.trim() : '';
  const strongestClaudeAlias = passedId === 'fable' || passedId === 'best';
  if (strongestClaudeAlias && host !== 'claude') return false;
  if (modelMatchesAny(passed, acceptable)) return true;
  if (host !== 'claude' || !strongestClaudeAlias) return false;
  return acceptable.some((model) => {
    const candidate = model.trim();
    return candidate === 'fable'
      || candidate === 'opus'
      || candidate === 'best'
      || candidate.startsWith('claude-fable-')
      || candidate.startsWith('claude-opus-');
  });
}

// Optional `plan` applies each host's sparse plan overrides.
export function tierModelTable(
  tier: unknown,
  plan?: unknown,
): { tier: TierId; claude: string; codex: string; cursor: string; opencode: string; copilot: string; windsurf: string; kilo: string } | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  return {
    tier: canonical,
    claude: resolveModel(canonical, 'claude', plan) ?? HOST_MODELS.claude.tiers[canonical][0],
    codex: resolveModel(canonical, 'codex', plan) ?? HOST_MODELS.codex.tiers[canonical][0],
    cursor: resolveModel(canonical, 'cursor', plan) ?? HOST_MODELS.cursor.tiers[canonical][0],
    opencode: resolveModel(canonical, 'opencode', plan) ?? HOST_MODELS.opencode.tiers[canonical][0],
    copilot: resolveModel(canonical, 'copilot', plan) ?? HOST_MODELS.copilot.tiers[canonical][0],
    windsurf: resolveModel(canonical, 'windsurf', plan) ?? HOST_MODELS.windsurf.tiers[canonical][0],
    kilo: resolveModel(canonical, 'kilo', plan) ?? HOST_MODELS.kilo.tiers[canonical][0],
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

export function recommendTierForPlan(host: unknown, plan: unknown): TierId {
  const h = canonicalHost(host);
  const p = canonicalPlan(h, plan);
  const table = PLAN_TIER_RECOMMENDATIONS[h];
  return table[p] ?? table[DEFAULT_HOST_PLAN[h]] ?? 'balanced';
}
