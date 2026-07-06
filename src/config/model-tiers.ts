// src/config/model-tiers.ts
// Host-agnostic capability tiers + per-host model map + subscription plans.
// THE config knobs: to adopt newer models edit ONLY HOST_MODELS; to change
// plan→tier policy edit PLAN_TIER_RECOMMENDATIONS; to change what an undetectable
// plan falls back to, edit DEFAULT_HOST_PLAN. The functions that interpret this
// data live in shared/model-tiers.ts; plan detection lives in shared/host-plan.ts.

import { OPENCODE_FREE_MODELS } from './opencode-delegation';

export const TIER_IDS = ['highest', 'balanced', 'cheapest'] as const;
export type TierId = (typeof TIER_IDS)[number];

// internal: consumed by canonicalTier (shared/model-tiers.ts).
export const TIER_ALIASES: Readonly<Record<string, TierId>> = {
  max: 'highest', maximum: 'highest', top: 'highest', best: 'highest', high: 'highest',
  mid: 'balanced', medium: 'balanced', standard: 'balanced', default: 'balanced', balance: 'balanced',
  low: 'cheapest', min: 'cheapest', minimal: 'cheapest', cheap: 'cheapest', fast: 'cheapest', lite: 'cheapest',
};

export const HOST_IDS = ['claude', 'codex', 'cursor', 'opencode', 'copilot'] as const;
export type HostModelKey = (typeof HOST_IDS)[number];

export const HOST_MODELS: Readonly<Record<HostModelKey, Record<TierId, string>>> = {
  claude: { highest: 'opus', balanced: 'sonnet', cheapest: 'haiku' },
  // cursor: bare model-FAMILY anchors (NOT full reasoning-variant slugs). The spawn gate
  // matches FAMILY-aware (modelMatchesExpected: `passed === family || passed.startsWith(family + '-')`),
  // so any reasoning variant the user's plan/build actually offers satisfies the tier —
  // `claude-opus-4-8-thinking-max-fast`, `claude-opus-4-8-thinking-high`, etc. all match the
  // `claude-opus-4-8` family. This is the fix for the earlier bug: pinning a SPECIFIC suffix
  // (`-thinking-high`) is plan/build-specific and rejected a higher-plan build's `-thinking-max`
  // variant of the SAME family. The reasoning suffix is NOT encoded here; the real build slug is
  // discovered from `.traffic-one/cursor-models.json` (captured from the in-Cursor agent — see
  // shared/materialize/cursor-models.ts) and written into `.cursor/agents/<role>.md`.
  // highest=Opus (mirrors the claude row); balanced=Sonnet; cheapest=Composer (Cursor's own
  // always-available model). NOT the Anthropic aliases (Cursor rejects `opus`/`sonnet`). When a
  // family generation bumps (opus-4-8 → opus-5), update it here (see the model-tier-sync skill).
  cursor: { highest: 'claude-opus-4-8', balanced: 'claude-4.6-sonnet', cheapest: 'composer-2.5' },
  codex: { highest: 'gpt-5.5', balanced: 'gpt-5.4', cheapest: 'gpt-5.4-mini' },
  opencode: {
    highest: OPENCODE_FREE_MODELS[0] ?? 'opencode/deepseek-v4-flash-free',
    balanced: OPENCODE_FREE_MODELS[1] ?? OPENCODE_FREE_MODELS[0] ?? 'opencode/deepseek-v4-flash-free',
    cheapest: OPENCODE_FREE_MODELS[2] ?? OPENCODE_FREE_MODELS[0] ?? 'opencode/deepseek-v4-flash-free',
  },
  // copilot: family anchors — validate slugs on target Copilot CLI/VS Code build via
  // model-tier-sync before tightening agent-model enforcement. Free/Student plans use
  // auto model selection only; COPILOT_PLAN_MODELS overlays the free row.
  copilot: { highest: 'claude-opus-4-8', balanced: 'claude-sonnet-4.6', cheapest: 'gpt-5.4-mini' },
};

// Same-tier FALLBACK FAMILIES per preferred family — the orchestrator falls back to one of
// these (and the gate ALSO accepts it, family-aware) when the user's build doesn't offer the
// preferred family. Keyed by the preferred FAMILY (not full slug) so claude/codex (stable IDs,
// no entry here) stay strict exact-match. Per Cursor's own tier labels: opus↔opus(prior-gen)↔
// fable are all "highest"; sonnet↔gpt-5.5 are both "balanced".
//
// `composer-2.5` is the LAST-RESORT fallback on highest AND balanced and the universal floor:
// every other family in those sets is a premium/API model that draws from the SAME API quota,
// so when that quota is exhausted (100% with on-demand spend off) Cursor makes them ALL
// unavailable at once and the gate would have nothing valid to accept. Composer is Cursor's own
// model in the included "Auto + Composer" bucket — it survives an API-budget exhaustion — so the
// team degrades to it (graceful, last in the list) instead of stalling. Entries are FAMILIES;
// the concrete build slug (`composer-2.5-fast`, `gpt-5.5-extra-high`, …) is resolved from the
// captured `.traffic-one/cursor-models.json` (pickCursorSlug) and matched family-aware.
export const CURSOR_MODEL_ALTERNATES: Readonly<Record<string, readonly string[]>> = {
  'claude-opus-4-8': ['claude-opus-4-7', 'claude-fable-5', 'composer-2.5'],
  'claude-4.6-sonnet': ['gpt-5.5', 'composer-2.5'],
};

// Per-plan model OVERLAY for Cursor (consumed by resolveModel/tierModelTable when a
// plan is threaded through). Cursor's PAID plans (Pro / Pro+ / Ultra / Teams /
// Enterprise) all expose the SAME frontier models — they differ only in usage
// BUDGET, not in which models you may pick — so they inherit the base HOST_MODELS.cursor
// row and need NO entry here. Only FREE/Hobby has a genuinely smaller set ("Hobby users
// have access to a smaller set, while paid plans unlock all models" — Cursor docs), where
// the frontier highest/balanced slugs are not selectable, so they resolve to Composer
// (Cursor's own always-available model). `cheapest` is already Composer for every plan,
// so it is omitted (inherits). Sparse by design: omit a (plan, tier) cell to inherit
// HOST_MODELS.cursor. Keyed by CANONICAL plan id (see canonicalPlan). There is NO
// programmatic per-account model API that is plan-scoped (api.cursor.com/v1/models is the
// key-authenticated cloud-agent catalog, not the in-editor set), so this static Free-vs-
// paid overlay is the source of truth — re-confirm via the model-tier-sync skill.
export const CURSOR_PLAN_MODELS: Readonly<Partial<Record<UserPlan, Partial<Record<TierId, string>>>>> = {
  free: { highest: 'composer-2.5', balanced: 'composer-2.5' },
};

// Per-plan model OVERLAY for OpenCode (consumed by resolveModel/tierModelTable when a
// plan is threaded through). The free zero-auth gateway uses the base HOST_MODELS.opencode
// row (the `opencode/*-free` chain). The paid "Go" subscription (`plus`) exposes the
// open-weight `opencode-go/*` catalog — recommended primaries below; OPENCODE_MODEL_ALTERNATES
// supplies the fallback chain (other Go models, then the always-free chain) for when a primary
// is unavailable. The frontier `opencode/*` Zen models (claude/gpt/gemini) are pay-per-use and
// NOT part of Go, so they are intentionally not offered here. Re-confirm Go's catalog against
// `~/.cache/opencode/models.json` (the `opencode-go` provider) via the model-tier-sync skill.
export const OPENCODE_PLAN_MODELS: Readonly<Partial<Record<UserPlan, Partial<Record<TierId, string>>>>> = {
  plus: {
    highest: 'opencode-go/qwen3.7-max',
    balanced: 'opencode-go/glm-5.2',
    cheapest: 'opencode-go/deepseek-v4-flash',
  },
};

// Per-plan model OVERLAY for Copilot (Free/Student → auto model only).
export const COPILOT_PLAN_MODELS: Readonly<Partial<Record<UserPlan, Partial<Record<TierId, string>>>>> = {
  free: { highest: 'gpt-5.4-mini', balanced: 'gpt-5.4-mini' },
};

// Same-tier FALLBACK chain per preferred Go model — the gate accepts any of these (and a
// dropdown can offer them) when the preferred model is unavailable. Each chain degrades
// within the Go open-weight catalog, then to OPENCODE_FREE_MODELS (always reachable on the
// zero-auth gateway), so a paid build never has nothing to fall back to — the owner's note:
// "I have Go and don't have access to Zen models", so no `opencode/*` frontier ids appear here.
export const OPENCODE_MODEL_ALTERNATES: Readonly<Record<string, readonly string[]>> = {
  'opencode-go/qwen3.7-max': ['opencode-go/minimax-m3', 'opencode-go/kimi-k2.7-code', 'opencode-go/deepseek-v4-pro', ...OPENCODE_FREE_MODELS],
  'opencode-go/glm-5.2': ['opencode-go/qwen3.7-plus', 'opencode-go/minimax-m2.7', 'opencode-go/glm-5.1', ...OPENCODE_FREE_MODELS],
  'opencode-go/deepseek-v4-flash': ['opencode-go/glm-5', 'opencode-go/qwen3.5-plus', ...OPENCODE_FREE_MODELS],
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
  student: 'free',
  copilotfree: 'free',
  none: 'free',
  trial: 'free',
  freetrial: 'free',
  professional: 'pro',
  // ChatGPT Go / "Pro-Lite" budget tier (seen as chatgpt_plan_type="prolite") → Plus.
  prolite: 'plus',
  go: 'plus',
  chatgptgo: 'plus',
  // Cursor's 2026 individual tiers. Ultra is the top individual plan → reuse `max`
  // (its capability/recommendation row). Pro+ → `plus`. Keys must match the value
  // AFTER canonicalPlan's normalize (lowercase, `[\s_-]+` stripped — but NOT `+`),
  // so both `pro+` (literal +) and `proplus` (from pro_plus / pro-plus / "pro plus")
  // are listed. The exact stripeMembershipType spelling for Pro+/Ultra is unconfirmed
  // by docs (see host-plan.ts diagnostic) — these tolerant aliases cover the spellings.
  ultra: 'max',
  'pro+': 'plus',
  proplus: 'plus',
};

// Which plans each host actually exposes. canonicalPlan() validates against this;
// a plan not in the host's set falls back to DEFAULT_HOST_PLAN[host].
export const HOST_PLAN_IDS: Readonly<Record<HostModelKey, ReadonlySet<UserPlan>>> = {
  claude: new Set<UserPlan>(['free', 'pro', 'max', 'team', 'enterprise']),
  codex: new Set<UserPlan>(['free', 'plus', 'pro', 'business', 'enterprise', 'team']),
  // Cursor 2026: Hobby(free) / Pro / Pro+(plus) / Ultra(max) individual, plus
  // Teams(team or the historical `business` string) / Enterprise. Previously only
  // {free,pro,business} → any ultra/pro+/teams membership string collapsed to the
  // DEFAULT_HOST_PLAN.cursor='free' fallback, silently downgrading paying users.
  cursor: new Set<UserPlan>(['free', 'pro', 'plus', 'max', 'business', 'team', 'enterprise']),
  // OpenCode: free zero-auth gateway, or a paid "Go" subscription (auth provider
  // `opencode-go`) mapped to `plus` (PLAN_ALIASES `go`→`plus` + detectOpenCodePlan).
  opencode: new Set<UserPlan>(['free', 'plus']),
  copilot: new Set<UserPlan>(['free', 'pro', 'plus', 'max', 'business', 'enterprise', 'team']),
};

// Plan assumed when the host exposes no detectable signal. Generous on purpose so
// undetected paying users are not silently downgraded (Claude stays at its top tier).
export const DEFAULT_HOST_PLAN: Readonly<Record<HostModelKey, UserPlan>> = {
  claude: 'free', codex: 'free', cursor: 'free', opencode: 'free', copilot: 'free',
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
    // Pro+/Ultra/Teams/Enterprise all unlock the same frontier models as Pro — they
    // differ only in usage BUDGET — so the higher individual/business plans top out at
    // 'highest' (their larger budgets can sustain it). pro stays 'balanced' (smaller budget).
    plus: { base: 'highest', withOpenCode: 'highest' },
    max: { base: 'highest', withOpenCode: 'highest' },
    business: { base: 'highest', withOpenCode: 'highest' },
    team: { base: 'highest', withOpenCode: 'highest' },
    enterprise: { base: 'highest', withOpenCode: 'highest' },
  },
  opencode: {
    free: { base: 'cheapest', withOpenCode: 'cheapest' },
    // "Go" subscription (auth `opencode-go` → plus): paid open-weight models, so recommend
    // a real working tier instead of cheapest. Delegation is inert on the opencode host,
    // so base == withOpenCode.
    plus: { base: 'balanced', withOpenCode: 'balanced' },
  },
  copilot: {
    free: { base: 'cheapest', withOpenCode: 'balanced' },
    pro: { base: 'balanced', withOpenCode: 'highest' },
    plus: { base: 'highest', withOpenCode: 'highest' },
    max: { base: 'highest', withOpenCode: 'highest' },
    business: { base: 'highest', withOpenCode: 'highest' },
    team: { base: 'highest', withOpenCode: 'highest' },
    enterprise: { base: 'highest', withOpenCode: 'highest' },
  },
};
