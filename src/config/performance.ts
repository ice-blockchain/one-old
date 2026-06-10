// src/config/performance.ts
// Per-performance-level defaults + plan-aware subagent tier tables. THE knobs for
// tuning team composition and per-role model strength. `tier` is a host-agnostic
// capability tier (see config/model-tiers); the model id resolves per host at spawn.
// The functions that interpret this data live in shared/performance-config.ts.

import type { HostModelKey, TierId, UserPlan } from './model-tiers';

export interface PerformanceLevelConfig {
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
// to `cheapest` via PERFORMANCE_CONFIG and never tier-shifts with plan/OpenCode.
export const AGENT_ROLES = [
  'senior-architect',
  'senior-frontend',
  'senior-backend',
  'senior-reviewer',
  'senior-tester',
  'senior-shipper',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// `base` = OpenCode delegation off; `withOpenCode` = on (usually one step up).
export interface PlanTier { readonly base: TierId; readonly withOpenCode: TierId; }

// Levels that run a subagent team (low is solo main-agent, no per-role tiers).
export type TeamLevel = 'balanced' | 'high';

// Plan → recommended performance level (what the wizard pre-selects). base =
// OpenCode off; withOpenCode = on. Edit freely; DEFAULT_HOST_PLAN is always present.
export const PLAN_PERFORMANCE_RECOMMENDATIONS: Readonly<
  Record<HostModelKey, Partial<Record<UserPlan, { base: PerformanceLevelId; withOpenCode: PerformanceLevelId }>>>
> = {
  claude: {
    free: { base: 'low', withOpenCode: 'balanced' },
    pro: { base: 'balanced', withOpenCode: 'high' },
    max: { base: 'high', withOpenCode: 'high' },
    team: { base: 'high', withOpenCode: 'high' },
    enterprise: { base: 'high', withOpenCode: 'high' },
  },
  codex: {
    free: { base: 'low', withOpenCode: 'balanced' },
    plus: { base: 'balanced', withOpenCode: 'high' },
    pro: { base: 'balanced', withOpenCode: 'high' },
    business: { base: 'high', withOpenCode: 'high' },
    enterprise: { base: 'high', withOpenCode: 'high' },
    team: { base: 'high', withOpenCode: 'high' },
  },
  cursor: {
    free: { base: 'low', withOpenCode: 'balanced' },
    pro: { base: 'balanced', withOpenCode: 'high' },
    business: { base: 'high', withOpenCode: 'high' },
  },
};

// ── Editable default subagent tiers (THE knob to hand-tune) ──────────────────
// Level-aware, every role spelled out. Mirrors PERFORMANCE_CONFIG's per-role shape
// so the generous default (max plan / undetected host) is a no-op versus today.
// Lower a single subagent here (e.g. senior-tester) and it applies everywhere
// unless a plan overrides it in PLAN_AGENT_TIERS below.
export const DEFAULT_AGENT_TIERS: Readonly<Record<TeamLevel, Record<AgentRole, PlanTier>>> = {
  balanced: {
    'senior-architect': { base: 'balanced', withOpenCode: 'highest' },
    'senior-frontend': { base: 'balanced', withOpenCode: 'highest' },
    'senior-backend': { base: 'balanced', withOpenCode: 'highest' },
    'senior-reviewer': { base: 'balanced', withOpenCode: 'highest' },
    'senior-tester': { base: 'cheapest', withOpenCode: 'balanced' },
    'senior-shipper': { base: 'balanced', withOpenCode: 'highest' },
  },
  high: {
    'senior-architect': { base: 'highest', withOpenCode: 'highest' },
    'senior-frontend': { base: 'highest', withOpenCode: 'highest' },
    'senior-backend': { base: 'highest', withOpenCode: 'highest' },
    'senior-reviewer': { base: 'highest', withOpenCode: 'highest' },
    'senior-tester': { base: 'cheapest', withOpenCode: 'balanced' },
    'senior-shipper': { base: 'balanced', withOpenCode: 'highest' },
  },
};

// Free plans run the team a step cheaper than the (max-shaped) default. Shared
// across hosts; replace a host's entry with an inline object to diverge one host.
// internal: consumed by PLAN_AGENT_TIERS below.
export const FREE_BALANCED: Readonly<Partial<Record<AgentRole, PlanTier>>> = {
  'senior-architect': { base: 'cheapest', withOpenCode: 'balanced' },
  'senior-frontend': { base: 'cheapest', withOpenCode: 'balanced' },
  'senior-backend': { base: 'cheapest', withOpenCode: 'balanced' },
  'senior-reviewer': { base: 'cheapest', withOpenCode: 'balanced' },
  'senior-shipper': { base: 'cheapest', withOpenCode: 'balanced' },
};
// internal: consumed by PLAN_AGENT_TIERS below.
export const FREE_HIGH: Readonly<Partial<Record<AgentRole, PlanTier>>> = {
  'senior-architect': { base: 'balanced', withOpenCode: 'highest' },
  'senior-frontend': { base: 'balanced', withOpenCode: 'highest' },
  'senior-backend': { base: 'balanced', withOpenCode: 'highest' },
  'senior-reviewer': { base: 'balanced', withOpenCode: 'highest' },
};

// Sparse per-(host, plan, level) deviations from DEFAULT_AGENT_TIERS. List only the
// roles that differ; omit a plan/level/role to inherit the default. Paid plans
// mostly inherit (empty); free is cheaper.
export const PLAN_AGENT_TIERS: Readonly<
  Record<HostModelKey, Partial<Record<UserPlan, Partial<Record<TeamLevel, Partial<Record<AgentRole, PlanTier>>>>>>>
> = {
  claude: { free: { balanced: FREE_BALANCED, high: FREE_HIGH } },
  codex: { free: { balanced: FREE_BALANCED, high: FREE_HIGH } },
  cursor: { free: { balanced: FREE_BALANCED, high: FREE_HIGH } },
};
