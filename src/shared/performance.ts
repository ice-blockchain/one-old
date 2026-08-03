// src/shared/performance.ts
// Performance-level → team-mode + per-role model resolution. Ported 1:1 from
// the resolver functions in scripts/hook-runtime/agents-performance-prompt.cjs.
// (The popup/chat PROSE lands in the agent-model module's skill.)

import { type TierId } from '../config/model-tiers';
import { canonicalHost, canonicalTier, resolveModel, tierModelTable } from './model-tiers';
import { agentTierForPlan } from './performance-config';
import { PERFORMANCE_CONFIG } from '../config/performance';
import { detectHost } from './host';
import { obj } from './obj';
import { currentModelForTier, currentModelsForTier } from './current-model-tiers';

// Optional plan context. When present, the per-role tier becomes plan-aware (see
// agentTierForPlan). Derived once at the call boundary (host + detected plan) and
// threaded so the spawn gate and the wizard line-up agree.
export interface PlanCtx { readonly host: string; readonly plan: string; }

interface RoleModelSelection {
  readonly tier: TierId;
  readonly preferredModel: string;
  readonly acceptableModels: readonly string[];
}

// OpenCode delegation is independent from performance/model selection. This helper
// remains the canonical readiness gate for queueing, triage, and delegation flows.
export function openCodeDelegationActive(state: unknown, host: unknown = detectHost()): boolean {
  const h = canonicalHost(host);
  if (h === 'opencode' || h === 'kilo') return false;
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
    const planned = agentTierForPlan(planCtx.host, planCtx.plan, level, role);
    if (planned) return planned;
  }
  return agent.tier;
}

export function modelForRole(
  level: string,
  role: string,
  overrides?: Record<string, unknown> | null,
  planCtx?: PlanCtx | null,
): { tier: TierId; claude: string; codex: string; cursor: string; opencode: string; copilot: string; windsurf: string; kilo: string } | null {
  const tier = effectiveTierForRole(level, role, overrides, planCtx);
  return tier ? tierModelTable(tier, planCtx?.plan) : null;
}

export function modelForRoleHost(
  level: string,
  role: string,
  host: string,
  overrides?: Record<string, unknown> | null,
  planCtx?: PlanCtx | null,
  env: NodeJS.ProcessEnv = process.env,
  modelSelections?: Record<string, unknown> | null,
): string | null {
  if (planCtx || modelSelections) {
    const selection = roleModelSelection(
      level,
      role,
      host,
      overrides,
      modelSelections,
      planCtx,
      env,
    );
    if (selection) return selection.preferredModel;
    if (modelSelections && Object.prototype.hasOwnProperty.call(modelSelections, role)) return null;
  }
  const tier = effectiveTierForRole(level, role, overrides, planCtx);
  if (!tier) return null;
  return planCtx
    ? currentModelForTier(tier, host, planCtx.plan, env)
    : resolveModel(tier, host);
}

// Resolve the complete, ordered model row for one role. A wizard selection may
// only move a model that already belongs to the role's effective tier to the
// front; it can never import a model from another tier. Keeping the rest of the
// row preserves same-tier fallback behavior for unavailable/exhausted models.
export function roleModelSelection(
  level: string,
  role: string,
  host: string,
  overrides?: Record<string, unknown> | null,
  modelSelections?: Record<string, unknown> | null,
  planCtx?: PlanCtx | null,
  env: NodeJS.ProcessEnv = process.env,
): RoleModelSelection | null {
  const tier = effectiveTierForRole(level, role, overrides, planCtx);
  if (!tier) return null;
  const row = currentModelsForTier(tier, host, planCtx?.plan, env);
  if (row.length === 0) return null;
  const hasRequested = !!modelSelections
    && Object.prototype.hasOwnProperty.call(modelSelections, role);
  const requested = hasRequested && typeof modelSelections?.[role] === 'string'
    ? String(modelSelections[role]).trim()
    : '';
  if (hasRequested && (!requested || !row.includes(requested))) return null;
  const preferredModel = requested || row[0]!;
  return {
    tier,
    preferredModel,
    acceptableModels: preferredModel === row[0]
      ? [...row]
      : [preferredModel, ...row.filter((model) => model !== preferredModel)],
  };
}
