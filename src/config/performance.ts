// src/config/performance.ts
// Per-performance-level defaults + plan-aware subagent tier tables. THE knobs for
// tuning team composition and per-role model strength. `tier` is a host-agnostic
// capability tier (see config/model-tiers); the model id resolves per host at spawn.
// The functions that interpret this data live in shared/performance-config.ts.

import type { HostModelKey, TierId, UserPlan } from './model-tiers';

interface PerformanceLevelConfig {
  readonly teamMode: 'main-agent' | 'subagents';
  readonly useRoadmapChecklist: boolean;
  readonly agents: Readonly<Record<string, { tier: TierId }>>;
}

export const PERFORMANCE_CONFIG: Readonly<Record<string, PerformanceLevelConfig>> = {
  low: {
    teamMode: 'main-agent',
    useRoadmapChecklist: true,
    agents: {},
  },
  balanced: {
    teamMode: 'subagents',
    useRoadmapChecklist: false,
    agents: {
      'senior-architect': { tier: 'balanced' },
      'senior-frontend': { tier: 'balanced' },
      'senior-backend': { tier: 'balanced' },
      'senior-reviewer': { tier: 'balanced' },
      'senior-tester': { tier: 'cheapest' },
      'senior-shipper': { tier: 'balanced' },
      'quick-fix': { tier: 'cheapest' },
    },
  },
  high: {
    teamMode: 'subagents',
    useRoadmapChecklist: false,
    agents: {
      'senior-architect': { tier: 'highest' },
      'senior-frontend': { tier: 'highest' },
      'senior-backend': { tier: 'highest' },
      'senior-reviewer': { tier: 'highest' },
      'senior-tester': { tier: 'cheapest' },
      'senior-shipper': { tier: 'balanced' },
      'quick-fix': { tier: 'cheapest' },
    },
  },
};

// ── Plan-aware performance level + per-subagent tiers ───────────────────────

export type PerformanceLevelId = 'low' | 'balanced' | 'high';

// The senior roster, in roster order. A strict subset of VALID_AGENT_ROLES
// (config/state): the `quick-fix` maintenance worker is a valid spawn role but is
// deliberately NOT part of the roster or the plan-aware tier tables — it is pinned
// to `cheapest` via PERFORMANCE_CONFIG and never varies with the host plan.
export const AGENT_ROLES = [
  'senior-architect',
  'senior-frontend',
  'senior-backend',
  'senior-reviewer',
  'senior-tester',
  'senior-shipper',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// Levels that run a subagent team (low is solo main-agent, no per-role tiers).
type TeamLevel = 'balanced' | 'high';

// Plan → recommended performance level (what the wizard pre-selects). Model and
// performance selection depend only on the active host plan; OpenCode remains an
// independent delegation preference. DEFAULT_HOST_PLAN is always present.
export const PLAN_PERFORMANCE_RECOMMENDATIONS: Readonly<
  Record<HostModelKey, Partial<Record<UserPlan, PerformanceLevelId>>>
> = {
  claude: {
    // `free` is the undetectable-metadata fallback (DEFAULT_HOST_PLAN.claude),
    // not a real Claude Code plan — assume nothing about paid capacity and
    // recommend the conservative solo mode, like every other host's free plan.
    free: 'low',
    pro: 'balanced',
    max: 'high',
    // Standard/unknown Team and Enterprise seats follow Claude Code's Sonnet
    // daily-driver guidance. The local metadata does not reliably distinguish
    // a Team Premium seat, so generic Team must not assume Premium/Opus.
    team: 'balanced',
    enterprise: 'balanced',
  },
  codex: {
    free: 'low',
    plus: 'balanced',
    pro: 'high',
    business: 'high',
    enterprise: 'high',
    team: 'high',
  },
  cursor: {
    free: 'low',
    pro: 'balanced',
    // Pro+(plus) / Ultra(max) / Teams(team or business) / Enterprise: larger usage
    // budgets than Pro (same model set) → recommend the full High team by default.
    plus: 'high',
    max: 'high',
    business: 'high',
    team: 'high',
    enterprise: 'high',
  },
  opencode: {
    free: 'low',
    plus: 'balanced',
  },
  kilo: {
    free: 'low',
  },
  copilot: {
    free: 'low',
    pro: 'balanced',
    plus: 'high',
    max: 'high',
    business: 'high',
    team: 'high',
    enterprise: 'high',
  },
  windsurf: {
    free: 'low',
    pro: 'balanced',
    max: 'high',
    team: 'high',
    enterprise: 'high',
  },
};

// ── Editable default subagent tiers (THE knob to hand-tune) ──────────────────
// Level-aware, every role spelled out. Mirrors PERFORMANCE_CONFIG's per-role shape
// so the generous default (max plan / undetected host) is a no-op versus today.
// Lower a single subagent here (e.g. senior-tester) and it applies everywhere
// unless a plan overrides it in PLAN_AGENT_TIERS below.
export const DEFAULT_AGENT_TIERS: Readonly<Record<TeamLevel, Record<AgentRole, TierId>>> = {
  balanced: {
    'senior-architect': 'balanced',
    'senior-frontend': 'balanced',
    'senior-backend': 'balanced',
    'senior-reviewer': 'balanced',
    'senior-tester': 'cheapest',
    'senior-shipper': 'balanced',
  },
  high: {
    'senior-architect': 'highest',
    'senior-frontend': 'highest',
    'senior-backend': 'highest',
    'senior-reviewer': 'highest',
    'senior-tester': 'cheapest',
    'senior-shipper': 'balanced',
  },
};

// Free plans run the team a step cheaper than the (max-shaped) default. Shared
// across hosts; replace a host's entry with an inline object to diverge one host.
// internal: consumed by PLAN_AGENT_TIERS below.
const FREE_BALANCED: Readonly<Partial<Record<AgentRole, TierId>>> = {
  'senior-architect': 'cheapest',
  'senior-frontend': 'cheapest',
  'senior-backend': 'cheapest',
  'senior-reviewer': 'cheapest',
  'senior-shipper': 'cheapest',
};
// internal: consumed by PLAN_AGENT_TIERS below.
const FREE_HIGH: Readonly<Partial<Record<AgentRole, TierId>>> = {
  'senior-architect': 'balanced',
  'senior-frontend': 'balanced',
  'senior-backend': 'balanced',
  'senior-reviewer': 'balanced',
};

const WINDSURF_FREE_ALL_CHEAPEST: Readonly<Record<AgentRole, TierId>> = {
  'senior-architect': 'cheapest',
  'senior-frontend': 'cheapest',
  'senior-backend': 'cheapest',
  'senior-reviewer': 'cheapest',
  'senior-tester': 'cheapest',
  'senior-shipper': 'cheapest',
};

// Sparse per-(host, plan, level) deviations from DEFAULT_AGENT_TIERS. List only the
// roles that differ; omit a plan/level/role to inherit the default. Paid plans
// mostly inherit (empty); free is cheaper.
export const PLAN_AGENT_TIERS: Readonly<
  Record<HostModelKey, Partial<Record<UserPlan, Partial<Record<TeamLevel, Partial<Record<AgentRole, TierId>>>>>>>
> = {
  claude: {},
  codex: { free: { balanced: FREE_BALANCED, high: FREE_HIGH } },
  cursor: { free: { balanced: FREE_BALANCED, high: FREE_HIGH } },
  opencode: { free: { balanced: FREE_BALANCED, high: FREE_HIGH } },
  // Kilo has no stable local subscription signal yet, so `free` means
  // "undetected" rather than "only a free model tier is selectable". Do not
  // collapse a user-picked Balanced/High Kilo team to cheapest; the Kilo picker
  // exposes native recommended models for all three capability tiers.
  kilo: {},
  copilot: { free: { balanced: FREE_BALANCED, high: FREE_HIGH } },
  windsurf: { free: { balanced: WINDSURF_FREE_ALL_CHEAPEST, high: WINDSURF_FREE_ALL_CHEAPEST } },
};
