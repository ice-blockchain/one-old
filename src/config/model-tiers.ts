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
  // cursor: the EXACT slugs Cursor's subagent Task tool accepts (confirmed from Cursor's
  // own "available subagent models" answer, 2026-06-17) — NOT the Anthropic family
  // aliases (Cursor rejects those), and NOT the chat model-picker variants (a different
  // surface with different suffixes: the Task tool wants `-thinking-high`/`-medium-thinking`,
  // not the picker's `-thinking-max`/`-extra-high`). ENFORCED by the spawn-agent gate like
  // claude/codex, matched FAMILY-aware (modelMatchesExpected in shared/model-tiers.ts).
  // highest=Opus mirrors the claude row; balanced=Sonnet; cheapest=Composer (Cursor's own
  // model, always available, no Max Mode). Cursor's subagent lineup is account/plan/build-
  // specific and the suffixes drift → re-confirm by asking Cursor for its Task-tool model
  // list (or the model picker) when syncing (see the model-tier-sync skill). A missing slug
  // is REJECTED as invalid (not gracefully downgraded), so each tier carries fallbacks below.
  cursor: { highest: 'claude-opus-4-8-thinking-high', balanced: 'claude-4.6-sonnet-medium-thinking', cheapest: 'composer-2.5-fast' },
  codex: { highest: 'gpt-5.5', balanced: 'gpt-5.4', cheapest: 'gpt-5.4-mini' },
};

// Cursor's subagent model lineup is account/plan/build-specific and a slug it doesn't
// offer is REJECTED as invalid (observed live: a build with no `claude-4.6-sonnet` →
// the balanced model-param gate became un-satisfiable → the subagent team deadlocked).
// These are same-tier FALLBACKS per preferred slug — every entry is itself a confirmed
// Cursor Task-tool slug — that the gate ALSO accepts and the orchestrator falls back to
// when the runner doesn't offer the preferred one. Keyed by the preferred slug (not tier)
// so claude/codex (stable IDs, no entry here) stay strict exact-match. Per Cursor's own
// tier labels: opus↔fable are both "highest"; sonnet↔gpt-5.5 are both "balanced".
//
// `composer-2.5-fast` is the LAST-RESORT fallback on highest AND balanced: every other
// model in those sets is a premium/API model that draws from the SAME API quota, so when
// that quota is exhausted (100% with on-demand spend off) Cursor makes them ALL unavailable
// at once and the gate would have nothing valid to accept. Composer is Cursor's own model
// in the included "Auto + Composer" bucket — it survives an API-budget exhaustion — so the
// team degrades to it (graceful, last in the list) instead of stalling or forcing on-demand
// spend. (Engages only when on-demand is off, so Cursor rejects the premium model → retry.)
export const CURSOR_MODEL_ALTERNATES: Readonly<Record<string, readonly string[]>> = {
  'claude-opus-4-8-thinking-high': ['claude-fable-5-thinking-high', 'composer-2.5-fast'],
  'claude-4.6-sonnet-medium-thinking': ['gpt-5.5-medium', 'composer-2.5-fast'],
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
