// src/config/model-tiers.ts
// Host-agnostic capability tiers + per-host model map + subscription plans.
// THE config knobs: to adopt newer models edit only HOST_MODELS; to change
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

export const HOST_IDS = ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'windsurf', 'kilo'] as const;
export type HostModelKey = (typeof HOST_IDS)[number];

export const PLAN_IDS = ['free', 'plus', 'pro', 'max', 'business', 'enterprise', 'team'] as const;
export type UserPlan = (typeof PLAN_IDS)[number];

export type ModelRow = readonly [string, ...string[]];

export interface HostModelsConfig {
  readonly tiers: Readonly<Record<TierId, ModelRow>>;
  readonly plans?: Readonly<Partial<Record<UserPlan, Readonly<Partial<Record<TierId, ModelRow>>>>>>;
}

// Every published high/balanced/low row should carry at least two usable
// choices unless the host really exposes only one. Keep those exceptions
// explicit so a future accidental singleton fails generation instead of
// silently weakening fallback coverage.
export const SINGLE_MODEL_ROW_ALLOWED_PLANS: Readonly<Partial<
Record<HostModelKey, 'all' | readonly UserPlan[]>
>> = Object.freeze({
  codex: 'all',
  cursor: Object.freeze(['free'] as const),
  copilot: Object.freeze(['free'] as const),
});

export function allowsSingleModelTierRow(host: HostModelKey, plan?: UserPlan): boolean {
  const allowed = SINGLE_MODEL_ROW_ALLOWED_PLANS[host];
  return allowed === 'all'
    || (Array.isArray(allowed) && plan !== undefined && allowed.includes(plan));
}

// Cursor's universal free floor: the first-party Composer model every Cursor
// account can always run. The agent-model gate's degradation detection keys on
// this exact family, so a Composer generation bump is a single edit here.
export const CURSOR_MODEL_FLOOR = 'composer-2.5';

// Each row is ordered preferred-first. The remaining models are accepted
// same-tier fallbacks. A plan override replaces one complete row; omitted rows
// inherit the host's base. With no plan argument, resolvers use the base rows.
export const HOST_MODELS: Readonly<Record<HostModelKey, HostModelsConfig>> = {
  claude: {
    // Concrete generations are pinned preferred-first; the bare alias at each
    // row's tail keeps Claude Code's native `model: "opus"/"sonnet"/"haiku"`
    // spawns accepted by the gate (aliases track point releases host-side).
    // Fable 5 is Claude Code's strongest option when the server reports it for
    // the organization (it is unavailable under ZDR). Opus 5 replaces Opus 4.8
    // as the first concrete fallback, followed by Claude Code's native family
    // alias; the gate also recognizes host-scoped `fable`/`best` selectors.
    tiers: {
      highest: ['claude-opus-5', 'claude-fable-5', 'opus'],
      balanced: ['claude-sonnet-5', 'claude-sonnet-4-6', 'sonnet'],
      cheapest: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'haiku'],
    },
  },
  codex: {
    // Codex collaboration currently exposes these two executable model ids.
    // Sol is the sole verified Highest model and Terra the sole verified
    // Balanced/Cheapest model; do not blur exact tier enforcement by crossing
    // them as fallbacks merely to inflate the row length.
    tiers: {
      highest: ['gpt-5.6-sol'],
      balanced: ['gpt-5.6-terra'],
      cheapest: ['gpt-5.6-terra'],
    },
  },
  cursor: {
    // Family anchors, not exact picker ids — the run captures the exact ids
    // offered to subagents and the gate matches them by family prefix. Rows
    // are capped at four: `grok-4.5` (xAI's frontier family on Cursor's paid
    // picker) takes the Highest fallback slot from `gpt-5.6-sol` in the 2026
    // refresh — Sol stays the Codex/Copilot Highest anchor — and the Composer
    // floor stays last (the degradation detector keys on that exact family).
    tiers: {
      highest: ['claude-opus-5', 'gpt-5.6-sol', 'grok-4.5', CURSOR_MODEL_FLOOR],
      balanced: ['gpt-5.6-terra', 'claude-sonnet-5', CURSOR_MODEL_FLOOR],
      cheapest: [CURSOR_MODEL_FLOOR, 'gpt-5.4-mini', 'gpt-5.6-luna'],
    },
    plans: {
      // Free stays pinned to the Composer floor for every tier — without the
      // explicit cheapest row it would inherit the base row's paid-only
      // fallback families.
      free: { highest: [CURSOR_MODEL_FLOOR], balanced: [CURSOR_MODEL_FLOOR], cheapest: [CURSOR_MODEL_FLOOR] },
    },
  },
  opencode: {
    // These three base preferred models are also the zero-auth delegation
    // fallback chain, in highest → balanced → cheapest order. Paid rows end in
    // the same sequence so every concrete model id remains editable here.
    // The three bounded rows collectively retain the complete live zero-auth
    // catalog. OPENCODE_FREE_MODELS derives the cross-role fallback chain from
    // their union, while each individual role tier stays within the row cap.
    tiers: {
      highest: ['opencode/deepseek-v4-flash-free', 'opencode/nemotron-3-ultra-free', 'opencode/hy3-free'],
      balanced: ['opencode/north-mini-code-free', 'opencode/big-pickle', 'opencode/deepseek-v4-flash-free'],
      cheapest: ['opencode/mimo-v2.5-free', 'opencode/deepseek-v4-flash-free', 'opencode/north-mini-code-free'],
    },
    plans: {
      plus: {
        highest: ['opencode-go/qwen3.7-max', 'opencode-go/minimax-m3', 'opencode/deepseek-v4-flash-free'],
        balanced: ['opencode-go/glm-5.2', 'opencode-go/qwen3.7-plus', 'opencode/north-mini-code-free'],
        cheapest: ['opencode-go/deepseek-v4-flash', 'opencode-go/mimo-v2.5', 'opencode/mimo-v2.5-free'],
      },
    },
  },
  copilot: {
    // Base rows target Pro+/Max/Business/Enterprise. Copilot Pro lacks the
    // three base Highest models, so it carries one plan-specific replacement.
    // Free exposes model selection only through `auto`.
    tiers: {
      highest: ['gpt-5.6-sol', 'claude-opus-4.8', 'gpt-5.5'],
      balanced: ['gpt-5.6-terra', 'claude-sonnet-5', 'gpt-5.3-codex'],
      cheapest: ['gpt-5-mini', 'gpt-5.4-mini', 'claude-haiku-4.5'],
    },
    plans: {
      free: { highest: ['auto'], balanced: ['auto'], cheapest: ['auto'] },
      pro: { highest: ['gpt-5.4', 'gpt-5.3-codex', 'claude-sonnet-5'] },
    },
  },
  windsurf: {
    // SWE-1.7 and SWE-1.6 are currently available without quota usage. The
    // docs do not confirm Lightning for Free and explicitly reserve 1.6 Fast
    // for paying users, so neither is offered in the Free/base rows. When the
    // SWE-1.7 preview ends, update this fallback and publish a new remote row.
    tiers: {
      highest: ['SWE-1.7', 'SWE-1.6'],
      balanced: ['SWE-1.7', 'SWE-1.6'],
      cheapest: ['SWE-1.6', 'SWE-1.7'],
    },
    plans: {
      pro: {
        highest: ['SWE-1.7', 'SWE-1.7 Lightning', 'SWE-1.6 Fast'],
        balanced: ['SWE-1.7', 'SWE-1.6 Fast', 'SWE-1.6'],
        cheapest: ['SWE-1.6', 'SWE-1.6 Fast', 'SWE-1.7'],
      },
      max: {
        highest: ['SWE-1.7', 'SWE-1.7 Lightning', 'SWE-1.6 Fast'],
        balanced: ['SWE-1.7', 'SWE-1.6 Fast', 'SWE-1.6'],
        cheapest: ['SWE-1.6', 'SWE-1.6 Fast', 'SWE-1.7'],
      },
      team: {
        highest: ['SWE-1.7', 'SWE-1.7 Lightning', 'SWE-1.6 Fast'],
        balanced: ['SWE-1.7', 'SWE-1.6 Fast', 'SWE-1.6'],
        cheapest: ['SWE-1.6', 'SWE-1.6 Fast', 'SWE-1.7'],
      },
      enterprise: {
        highest: ['SWE-1.7', 'SWE-1.7 Lightning', 'SWE-1.6 Fast'],
        balanced: ['SWE-1.7', 'SWE-1.6 Fast', 'SWE-1.6'],
        cheapest: ['SWE-1.6', 'SWE-1.6 Fast', 'SWE-1.7'],
      },
    },
  },
  kilo: {
    tiers: {
      highest: ['kilo/kilo-auto/frontier', 'kilo/kilo-auto/balanced', 'kilo/kilo-auto/efficient'],
      balanced: ['kilo/kilo-auto/balanced', 'kilo/kilo-auto/efficient', 'kilo/kilo-auto/frontier'],
      cheapest: ['kilo/kilo-auto/free', 'kilo/kilo-auto/efficient', 'kilo/kilo-auto/balanced'],
    },
  },
};

// Runtime OpenCode delegation reads this derived view. The editable model ids
// remain exclusively in HOST_MODELS above.
export const OPENCODE_FREE_MODELS: readonly string[] = [...new Set([
  ...TIER_IDS.map((tier) => HOST_MODELS.opencode.tiers[tier][0]),
  ...TIER_IDS.flatMap((tier) => HOST_MODELS.opencode.tiers[tier]),
])];

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
  githubcopilotfree: 'free',
  copilotpro: 'pro',
  githubcopilotpro: 'pro',
  copilotbusiness: 'business',
  githubcopilotbusiness: 'business',
  copilotenterprise: 'enterprise',
  githubcopilotenterprise: 'enterprise',
  none: 'free',
  trial: 'free',
  freetrial: 'free',
  professional: 'pro',
  // "Pro-Lite" (chatgpt_plan_type="prolite") is badged "Pro" in the Codex app —
  // observed live on a Pro-Lite account whose telemetry reports `prolite` while
  // the profile shows Pro. Map it to `pro` so stored/displayed plans match the
  // app; ChatGPT Go stays a Plus-equivalent budget tier.
  prolite: 'pro',
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
  // Claude Free does not include Claude Code, so `free` is not a selectable
  // Claude plan here — but undetectable local metadata still falls back to the
  // conservative DEFAULT_HOST_PLAN.claude='free' (assume nothing about paid
  // seats; recommendations resolve via the explicit `free` rows below).
  claude: new Set<UserPlan>(['pro', 'max', 'team', 'enterprise']),
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
  // Devin Desktop self-serve docs list Free / Pro / Max / Teams / Enterprise.
  windsurf: new Set<UserPlan>(['free', 'pro', 'max', 'team', 'enterprise']),
  kilo: new Set<UserPlan>(['free']),
};

// Plan assumed when the host exposes no detectable signal.
export const DEFAULT_HOST_PLAN: Readonly<Record<HostModelKey, UserPlan>> = {
  claude: 'free', codex: 'free', cursor: 'free', opencode: 'free', copilot: 'free', windsurf: 'free', kilo: 'free',
};

// Headline plan → capability tier. Edit any cell freely. DEFAULT_HOST_PLAN[host] is
// always present below, so recommendTierForPlan always resolves.
export const PLAN_TIER_RECOMMENDATIONS: Readonly<Record<HostModelKey, Partial<Record<UserPlan, TierId>>>> = {
  claude: {
    free: 'cheapest', pro: 'balanced', max: 'highest', team: 'balanced', enterprise: 'balanced',
  },
  codex: {
    free: 'cheapest', plus: 'balanced', pro: 'highest', business: 'highest', enterprise: 'highest', team: 'highest',
  },
  cursor: {
    free: 'cheapest', pro: 'balanced', plus: 'highest', max: 'highest', business: 'highest', team: 'highest', enterprise: 'highest',
  },
  opencode: {
    free: 'cheapest', plus: 'balanced',
  },
  kilo: {
    free: 'cheapest',
  },
  copilot: {
    free: 'cheapest', pro: 'balanced', plus: 'highest', max: 'highest', business: 'highest', team: 'highest', enterprise: 'highest',
  },
  windsurf: {
    free: 'cheapest', pro: 'balanced', max: 'highest', team: 'highest', enterprise: 'highest',
  },
};
