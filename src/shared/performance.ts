// src/shared/performance.ts
// Performance-level → team-mode + per-role model resolution. Ported 1:1 from
// the resolver functions in scripts/hook-runtime/agents-performance-prompt.cjs.
// (The popup/chat PROSE lands in the agent-model module's skill.)

import { type TierId } from '../config/model-tiers';
import { canonicalTier, resolveModel, tierModelTable } from './model-tiers';
import { agentTierForPlan } from './performance-config';
import { PERFORMANCE_CONFIG } from '../config/performance';
import { obj } from './obj';

// Optional plan context. When present, the per-role tier becomes plan-aware (see
// agentTierForPlan). Derived once at the call boundary (host + detected plan +
// OpenCode flag) and threaded so the spawn gate and the wizard line-up agree.
export interface PlanCtx { readonly host: string; readonly plan: string; readonly useOpenCode: boolean; }

// The OpenCode token-economy tier-shift (`withOpenCode`) must apply ONLY when
// delegation can actually run — the user enabled it AND the CLI is installed
// (stamped under `toolchain.opencode`). Otherwise the team would move to pricier
// models / a higher level for an offload that never happens. Derive `useOpenCode`
// through this everywhere so the wizard line-up and the spawn gate stay in sync.
export function openCodeDelegationActive(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  if (obj(s.openCode)?.enabled !== true) return false;
  const tc = obj(s.toolchain);
  const oc = tc ? obj(tc.opencode) : null;
  return typeof oc?.installedVersion === 'string' && oc.installedVersion.length > 0;
}

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
  return tier ? tierModelTable(tier, planCtx?.plan) : null;
}

export function modelForRoleHost(
  level: string,
  role: string,
  host: string,
  overrides?: Record<string, unknown> | null,
  planCtx?: PlanCtx | null,
): string | null {
  const tier = effectiveTierForRole(level, role, overrides, planCtx);
  return tier ? resolveModel(tier, host, planCtx?.plan) : null;
}
