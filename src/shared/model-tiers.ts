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

export type ModelTierSnapshot = Readonly<Record<TierId, readonly string[]>>;

export interface HostModelSnapshot {
  readonly plan: UserPlan;
  readonly updatedAt: string;
  readonly tiers: ModelTierSnapshot;
}

export type ModelStatusResponse = HostModelSnapshot;

export interface ParseModelStatusOptions {
  readonly expectedHost?: unknown;
  readonly expectedPlan?: unknown;
  readonly current?: HostModelSnapshot | null;
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
// family/tier (e.g. `gpt-5.5-medium` vs a highest opus family) never matches, so tier
// enforcement holds. Claude/Codex pass bare ids, so this is exact-equality there in practice.
// An empty/absent model never matches (deny → inherit guard).
export function modelMatchesExpected(passed: unknown, expected: unknown): boolean {
  const e = typeof expected === 'string' ? expected.trim() : '';
  const p = typeof passed === 'string' ? passed.trim() : '';
  if (!e || !p) return false;
  return p === e || p.startsWith(`${e}-`);
}

// Build the serializable catalog saved during onboarding. Every tier is ordered
// preferred-first. Plan overrides replace a whole row and omitted rows inherit.
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
    updatedAt: HOST_MODELS[h].updatedAt,
    tiers: modelTierSnapshot(h, p),
  };
}

export function modelStatusSnapshot(host: unknown, plan: unknown): ModelStatusResponse {
  return hostModelSnapshot(host, plan);
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

function validDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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
    if (!Array.isArray(models) || models.length === 0 || models.length > 32 || !models.every(validModelId)) return null;
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
  if (!plan || !validDateOnly(value.updatedAt) || !tiers) return null;
  return { plan, updatedAt: value.updatedAt, tiers };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function sameTierSnapshot(left: ModelTierSnapshot, right: ModelTierSnapshot): boolean {
  return TIER_IDS.every((tier) => {
    const a = left[tier];
    const b = right[tier];
    return a.length === b.length && a.every((model, index) => model === b[index]);
  });
}

// Strictly parse the unauthenticated /model-status payload. When the server
// claims the same catalog date as the applicable local or bundled target-plan
// baseline, the tier lists must also be byte-for-byte equivalent; otherwise the
// server changed catalog semantics without bumping its version and the client
// fails open on local data.
export function parseModelStatusResponse(
  value: unknown,
  options: ParseModelStatusOptions = {},
): ModelStatusResponse | null {
  if (!isRecord(value) || !hasExactKeys(value, ['plan', 'updatedAt', 'tiers'])) return null;
  const host = options.expectedHost === undefined ? undefined : strictHost(options.expectedHost);
  if (options.expectedHost !== undefined && !host) return null;
  const snapshot = parseHostModelSnapshot(value, host);
  if (!snapshot) return null;

  if (options.expectedPlan !== undefined) {
    if (!planIsRecognized(options.expectedPlan)) return null;
    const expectedPlan = host
      ? canonicalPlan(host, options.expectedPlan)
      : strictPlan(options.expectedPlan);
    if (!expectedPlan || expectedPlan !== snapshot.plan) return null;
  }
  // A same-plan local snapshot is the strongest comparison baseline. On first
  // use or a plan transition there is no such snapshot, so compare against the
  // bundled host + target-plan catalog instead. This prevents an endpoint from
  // silently changing tiers while retaining the bundled catalog date.
  const comparisons = [
    ...(options.current?.plan === snapshot.plan ? [options.current] : []),
    ...(host ? [hostModelSnapshot(host, snapshot.plan)] : []),
  ];
  if (comparisons.some((comparison) => comparison.updatedAt === snapshot.updatedAt
    && !sameTierSnapshot(comparison.tiers, snapshot.tiers))) return null;

  return snapshot;
}

// True when `passed` matches ANY model in the acceptable set (family-aware).
export function modelMatchesAny(passed: unknown, acceptable: readonly string[]): boolean {
  return acceptable.some((e) => modelMatchesExpected(passed, e));
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
