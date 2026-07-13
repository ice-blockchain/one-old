// src/shared/performance-config.ts
// Functions that resolve plan-aware performance levels and per-subagent tiers.
// The tunable tables (PERFORMANCE_CONFIG, DEFAULT_AGENT_TIERS, plan recommendations)
// live in src/config/performance.ts — edit knobs there, not here.

import { DEFAULT_HOST_PLAN, type TierId } from '../config/model-tiers';
import {
  DEFAULT_AGENT_TIERS,
  PERFORMANCE_CONFIG,
  PLAN_AGENT_TIERS,
  PLAN_PERFORMANCE_RECOMMENDATIONS,
  type AgentRole,
  type PerformanceLevelId,
} from '../config/performance';
import { canonicalHost, canonicalPlan } from './model-tiers';

export function recommendLevelForPlan(host: unknown, plan: unknown): PerformanceLevelId {
  const h = canonicalHost(host);
  const p = canonicalPlan(h, plan);
  const table = PLAN_PERFORMANCE_RECOMMENDATIONS[h];
  return table[p] ?? table[DEFAULT_HOST_PLAN[h]] ?? 'balanced';
}

// Resolve the capability tier for one subagent given host + plan + level.
// Precedence: PLAN_AGENT_TIERS deviation → DEFAULT_AGENT_TIERS → PERFORMANCE_CONFIG
// (last resort). Returns null for solo/unknown levels or
// unconfigured roles. (User `team.overrides` win a layer up in effectiveTierForRole.)
export function agentTierForPlan(
  host: unknown, plan: unknown, level: string, role: string,
): TierId | null {
  if (level !== 'balanced' && level !== 'high') return null;
  const h = canonicalHost(host);
  const p = canonicalPlan(h, plan);
  const r = role as AgentRole;
  const choice = PLAN_AGENT_TIERS[h]?.[p]?.[level]?.[r] ?? DEFAULT_AGENT_TIERS[level][r];
  if (choice) return choice;
  return PERFORMANCE_CONFIG[level]?.agents[role]?.tier ?? null;
}
