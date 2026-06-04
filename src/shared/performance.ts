// src/shared/performance.ts
// Performance-level → team-mode + per-role model resolution. Ported 1:1 from
// the resolver functions in scripts/hook-runtime/agents-performance-prompt.cjs.
// (The popup/chat PROSE lands in the agent-model module's skill.)

import { type TierId } from '../config/model-tiers';
import { canonicalTier, resolveModel, tierModelTable } from './model-tiers';
import { agentTierForPlan } from './performance-config';
import { PERFORMANCE_CONFIG } from '../config/performance';

// Optional plan context. When present, the per-role tier becomes plan-aware (see
// agentTierForPlan). Derived once at the call boundary (host + detected plan +
// OpenCode flag) and threaded so the spawn gate and the wizard line-up agree.
export interface PlanCtx { readonly host: string; readonly plan: string; readonly useOpenCode: boolean; }

export function teamModeForLevel(level: string): 'main-agent' | 'subagents' {
  const cfg = PERFORMANCE_CONFIG[level];
  return cfg ? cfg.teamMode : 'main-agent';
}

export function autoLaunchesTeam(level: string): boolean {
  return level === 'balanced' || level === 'high';
}

// Effective tier for a role at a level. Precedence: user `team.overrides` →
// plan-aware tier (when planCtx is given) → PERFORMANCE_CONFIG default. Null when
// the level has no subagents (low) or the role isn't configured.
export function effectiveTierForRole(
  level: string,
  role: string,
  overrides?: Record<string, unknown> | null,
  planCtx?: PlanCtx | null,
): TierId | null {
  const cfg = PERFORMANCE_CONFIG[level];
  const agent = cfg ? cfg.agents[role] : undefined;
  if (!agent) return null;
  if (overrides && typeof overrides === 'object') {
    const override = canonicalTier(overrides[role]);
    if (override) return override;
  }
  if (planCtx) {
    const planned = agentTierForPlan(planCtx.host, planCtx.plan, level, role, planCtx.useOpenCode);
    if (planned) return planned;
  }
  return agent.tier;
}

export function modelForRole(
  level: string,
  role: string,
  overrides?: Record<string, unknown> | null,
  planCtx?: PlanCtx | null,
): { tier: TierId; claude: string; codex: string; cursor: string } | null {
  const tier = effectiveTierForRole(level, role, overrides, planCtx);
  return tier ? tierModelTable(tier) : null;
}

export function modelForRoleHost(
  level: string,
  role: string,
  host: string,
  overrides?: Record<string, unknown> | null,
  planCtx?: PlanCtx | null,
): string | null {
  const tier = effectiveTierForRole(level, role, overrides, planCtx);
  return tier ? resolveModel(tier, host) : null;
}
