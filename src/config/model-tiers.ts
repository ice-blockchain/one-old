// src/config/model-tiers.ts
// Host-agnostic capability tiers + per-host model map + subscription plans.
// THE config knobs: to adopt newer models edit ONLY HOST_MODELS; to change
// plan→tier policy edit PLAN_TIER_RECOMMENDATIONS; to change what an undetectable
// plan falls back to, edit DEFAULT_HOST_PLAN. The functions that interpret this
// data live in shared/model-tiers.ts; plan detection lives in shared/host-plan.ts.

export const TIER_IDS = ['highest', 'balanced', 'cheapest'] as const;
export type TierId = (typeof TIER_IDS)[number];

// internal: consumed by canonicalTier (shared/model-tiers.ts).
export const TIER_ALIASES: Readonly<Record<string, TierId>> = {
  max: 'highest', maximum: 'highest', top: 'highest', best: 'highest', high: 'highest',
  mid: 'balanced', medium: 'balanced', standard: 'balanced', default: 'balanced', balance: 'balanced',
  low: 'cheapest', min: 'cheapest', minimal: 'cheapest', cheap: 'cheapest', fast: 'cheapest', lite: 'cheapest',
};

export const HOST_IDS = ['claude', 'codex', 'cursor'] as const;
export type HostModelKey = (typeof HOST_IDS)[number];

export const HOST_MODELS: Readonly<Record<HostModelKey, Record<TierId, string>>> = {
  claude: { highest: 'opus', balanced: 'sonnet', cheapest: 'haiku' },
  // cursor: REAL Cursor model IDs (the values Cursor's subagent `model:` field / Task
  // tool accept) — NOT the Anthropic family aliases, which Cursor rejects. ENFORCED by
  // the spawn-agent gate like claude/codex. `composer-latest` is Cursor's own model
  // (stable alias, no Max Mode, cost-optimized); the others are versioned and drift, so
  // re-confirm against Cursor's `/v1/models` endpoint / model picker when syncing (see
  // the model-tier-sync skill). cheapest is cost-optimized (Composer is cheap despite
  // solid intelligence). An unavailable-but-valid model falls back gracefully inside
  // Cursor; only an INVALID slug rejects — so keep these to confirmed real IDs.
  cursor: { highest: 'gpt-5.5', balanced: 'claude-4.6-sonnet', cheapest: 'composer-latest' },
  codex: { highest: 'gpt-5.5', balanced: 'gpt-5.4', cheapest: 'gpt-5.4-mini' },
};

// ── User subscription plans (per host) ──────────────────────────────────────
export const PLAN_IDS = ['free', 'plus', 'pro', 'max', 'business', 'enterprise', 'team'] as const;
export type UserPlan = (typeof PLAN_IDS)[number];

// Accepted spellings → canonical plan id. Keys are normalized (lowercased, no
// spaces/underscores/hyphens) before lookup, so `Claude Max` / `max_20x` → max.
// internal: consumed by canonicalPlan (shared/model-tiers.ts).
export const PLAN_ALIASES: Readonly<Record<string, UserPlan>> = {
  maximum: 'max',
  teams: 'team',
  edu: 'business',
  education: 'business',
  hobby: 'free',
  none: 'free',
  trial: 'free',
  freetrial: 'free',
  professional: 'pro',
  // ChatGPT Go / "Pro-Lite" budget tier (seen as chatgpt_plan_type="prolite") → Plus.
  prolite: 'plus',
  go: 'plus',
  chatgptgo: 'plus',
};

// Which plans each host actually exposes. canonicalPlan() validates against this;
// a plan not in the host's set falls back to DEFAULT_HOST_PLAN[host].
export const HOST_PLAN_IDS: Readonly<Record<HostModelKey, ReadonlySet<UserPlan>>> = {
  claude: new Set<UserPlan>(['free', 'pro', 'max', 'team', 'enterprise']),
  codex: new Set<UserPlan>(['free', 'plus', 'pro', 'business', 'enterprise', 'team']),
  cursor: new Set<UserPlan>(['free', 'pro', 'business']),
};

// Plan assumed when the host exposes no detectable signal. Generous on purpose so
// undetected paying users are not silently downgraded (Claude stays at its top tier).
export const DEFAULT_HOST_PLAN: Readonly<Record<HostModelKey, UserPlan>> = {
  claude: 'free', codex: 'free', cursor: 'free',
};

// One plan's tier choice: `base` when OpenCode delegation is off, `withOpenCode`
// when it is on (typically one capability step up; top plans stay at 'highest').
export interface PlanTierChoice { readonly base: TierId; readonly withOpenCode: TierId; }

// Headline plan → capability tier. Edit any cell freely. DEFAULT_HOST_PLAN[host] is
// always present below, so recommendTierForPlan always resolves.
export const PLAN_TIER_RECOMMENDATIONS: Readonly<Record<HostModelKey, Partial<Record<UserPlan, PlanTierChoice>>>> = {
  claude: {
    free: { base: 'cheapest', withOpenCode: 'balanced' },
    pro: { base: 'balanced', withOpenCode: 'highest' },
    max: { base: 'highest', withOpenCode: 'highest' },
    team: { base: 'highest', withOpenCode: 'highest' },
    enterprise: { base: 'highest', withOpenCode: 'highest' },
  },
  codex: {
    free: { base: 'cheapest', withOpenCode: 'balanced' },
    plus: { base: 'balanced', withOpenCode: 'highest' },
    pro: { base: 'balanced', withOpenCode: 'highest' },
    business: { base: 'highest', withOpenCode: 'highest' },
    enterprise: { base: 'highest', withOpenCode: 'highest' },
    team: { base: 'highest', withOpenCode: 'highest' },
  },
  cursor: {
    free: { base: 'cheapest', withOpenCode: 'balanced' },
    pro: { base: 'balanced', withOpenCode: 'highest' },
    business: { base: 'highest', withOpenCode: 'highest' },
  },
};
