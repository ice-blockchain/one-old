// src/config/model-tiers.ts
// Host-agnostic capability tiers + per-host model map + subscription plans.
// THE config knobs: to adopt newer models edit only HOST_MODELS (including that
// host's updatedAt); to change
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
  readonly updatedAt: string;
  readonly tiers: Readonly<Record<TierId, ModelRow>>;
  readonly plans?: Readonly<Partial<Record<UserPlan, Readonly<Partial<Record<TierId, ModelRow>>>>>>;
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
    updatedAt: '2026-07-14',
    // Concrete generations are pinned preferred-first; the bare alias at each
    // row's tail keeps Claude Code's native `model: "opus"/"sonnet"/"haiku"`
    // spawns accepted by the gate (aliases track point releases host-side).
    // Fable 5 is org/promo-gated with no availability capture on this host —
    // if a spawn fails at the API, degrade to the next accepted id in the row.
    tiers: {
      highest: ['claude-opus-4-8', 'claude-fable-5', 'claude-opus-4-7', 'opus'],
      balanced: ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'sonnet'],
      cheapest: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'haiku'],
    },
  },
  codex: {
    updatedAt: '2026-07-13',
    tiers: {
      highest: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'],
      balanced: ['gpt-5.6-terra', 'gpt-5.4', 'gpt-5.5'],
      cheapest: ['gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.4'],
    },
  },
  cursor: {
    updatedAt: '2026-07-14',
    tiers: {
      highest: ['claude-fable-5', 'gpt-5.6-sol', 'claude-opus-4-8', 'gpt-5.5', CURSOR_MODEL_FLOOR],
      balanced: ['gpt-5.6-terra', 'claude-sonnet-5', 'gpt-5.5', 'claude-4.6-sonnet', CURSOR_MODEL_FLOOR],
      cheapest: [CURSOR_MODEL_FLOOR, 'gpt-5.4-mini', 'gemini-3.5-flash', 'claude-4.5-haiku'],
    },
    plans: {
      // Free stays pinned to the Composer floor for every tier — without the
      // explicit cheapest row it would inherit the base row's paid-only
      // fallback families.
      free: { highest: [CURSOR_MODEL_FLOOR], balanced: [CURSOR_MODEL_FLOOR], cheapest: [CURSOR_MODEL_FLOOR] },
    },
  },
  opencode: {
    updatedAt: '2026-07-14',
    // These three base preferred models are also the zero-auth delegation
    // fallback chain, in highest → balanced → cheapest order. Paid rows end in
    // the same sequence so every concrete model id remains editable here.
    // gpt-5-nano is Zen's permanently-free model (the other four are the
    // rotating limited-time free set), so it anchors the tail of every row.
    tiers: {
      highest: ['opencode/deepseek-v4-flash-free', 'opencode/mimo-v2.5-free', 'opencode/north-mini-code-free', 'opencode/nemotron-3-ultra-free', 'opencode/gpt-5-nano'],
      balanced: ['opencode/north-mini-code-free', 'opencode/deepseek-v4-flash-free', 'opencode/mimo-v2.5-free', 'opencode/nemotron-3-ultra-free', 'opencode/gpt-5-nano'],
      cheapest: ['opencode/mimo-v2.5-free', 'opencode/deepseek-v4-flash-free', 'opencode/north-mini-code-free', 'opencode/nemotron-3-ultra-free', 'opencode/gpt-5-nano'],
    },
    plans: {
      plus: {
        highest: ['opencode-go/qwen3.7-max', 'opencode-go/minimax-m3', 'opencode-go/kimi-k2.7-code', 'opencode-go/deepseek-v4-pro', 'opencode/deepseek-v4-flash-free'],
        balanced: ['opencode-go/glm-5.2', 'opencode-go/qwen3.7-plus', 'opencode-go/minimax-m2.7', 'opencode-go/glm-5.1', 'opencode/north-mini-code-free'],
        cheapest: ['opencode-go/deepseek-v4-flash', 'opencode-go/mimo-v2.5', 'opencode-go/minimax-m3', 'opencode-go/qwen3.7-plus', 'opencode/mimo-v2.5-free'],
      },
    },
  },
  copilot: {
    updatedAt: '2026-07-14',
    // Capability-first: highest prefers Opus 4.8 (27x premium multiplier) —
    // plan recommendations steer cost-sensitive plans to balanced/cheapest.
    // Cheapest holds only 0.33x-multiplier models (gemini-3-flash, NOT the
    // 14x gemini-3.5-flash).
    tiers: {
      highest: ['claude-opus-4.8', 'claude-sonnet-5', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'],
      balanced: ['claude-sonnet-5', 'gpt-5.4', 'claude-sonnet-4.6', 'gpt-5.3-codex', 'gemini-3.1-pro-preview'],
      cheapest: ['claude-haiku-4.5', 'gpt-5-mini', 'gemini-3-flash', 'raptor-mini', 'mai-code-1-flash'],
    },
    plans: {
      free: { highest: ['auto'], balanced: ['auto'], cheapest: ['auto'] },
    },
  },
  windsurf: {
    updatedAt: '2026-07-14',
    // SWE-1.7 runs at 0 credits per docs.devin.ai, so the free/base rows can
    // prefer it. Display strings are matched verbatim against the Cascade
    // picker — verify on a real Windsurf Free install before shipping changes.
    tiers: {
      highest: ['SWE-1.7 Beta', 'SWE-1.7 Lightning Beta', 'SWE-1.6 Slow'],
      balanced: ['SWE-1.7 Beta', 'SWE-1.6 Slow'],
      cheapest: ['SWE-1.6 Slow', 'SWE-1.7 Beta'],
    },
    plans: {
      pro: {
        highest: ['SWE-1.7 Beta', 'SWE-1.7 Lightning Beta', 'SWE-1.6 Slow'],
        balanced: ['SWE-1.7 Lightning Beta', 'SWE-1.7 Beta', 'SWE-1.6 Slow'],
        cheapest: ['SWE-1.6 Slow', 'SWE-1.7 Lightning Beta', 'SWE-1.7 Beta'],
      },
      max: {
        highest: ['SWE-1.7 Beta', 'SWE-1.7 Lightning Beta', 'SWE-1.6 Slow'],
        balanced: ['SWE-1.7 Lightning Beta', 'SWE-1.7 Beta', 'SWE-1.6 Slow'],
        cheapest: ['SWE-1.6 Slow', 'SWE-1.7 Lightning Beta', 'SWE-1.7 Beta'],
      },
      team: {
        highest: ['SWE-1.7 Beta', 'SWE-1.7 Lightning Beta', 'SWE-1.6 Slow'],
        balanced: ['SWE-1.7 Lightning Beta', 'SWE-1.7 Beta', 'SWE-1.6 Slow'],
        cheapest: ['SWE-1.6 Slow', 'SWE-1.7 Lightning Beta', 'SWE-1.7 Beta'],
      },
      enterprise: {
        highest: ['SWE-1.7 Beta', 'SWE-1.7 Lightning Beta', 'SWE-1.6 Slow'],
        balanced: ['SWE-1.7 Lightning Beta', 'SWE-1.7 Beta', 'SWE-1.6 Slow'],
        cheapest: ['SWE-1.6 Slow', 'SWE-1.7 Lightning Beta', 'SWE-1.7 Beta'],
      },
    },
  },
  kilo: {
    updatedAt: '2026-07-13',
    tiers: {
      highest: ['kilo/kilo-auto/frontier', 'kilo/kilo-auto/balanced', 'kilo/kilo-auto/efficient', 'kilo/kilo-auto/free'],
      balanced: ['kilo/kilo-auto/balanced', 'kilo/kilo-auto/efficient', 'kilo/kilo-auto/frontier', 'kilo/kilo-auto/free'],
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
    free: 'cheapest', plus: 'balanced', pro: 'balanced', business: 'highest', enterprise: 'highest', team: 'highest',
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
