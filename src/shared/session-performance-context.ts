// Dynamic, machine-local performance context injected by SessionStart. This is
// the only parent-session role→model lineup; generated project artifacts remain
// plan/model agnostic so different users and hosts can share the same checkout.

import { AGENT_ROLES, PERFORMANCE_CONFIG } from '../config/performance';
import { currentHostModelSnapshot, currentModelForTier } from './current-model-tiers';
import { detectHostPlan } from './host-plan';
import { canonicalHost } from './model-tiers';
import { obj } from './obj';
import { effectiveTierForRole, teamModeForLevel } from './performance';

export function sessionPerformanceContext(
  stateInput: unknown,
  hostInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const state = obj(stateInput);
  const performance = obj(state?.performance);
  const level = typeof performance?.level === 'string' ? performance.level : '';
  if (!state || !PERFORMANCE_CONFIG[level]) return '';

  const host = canonicalHost(hostInput);
  const plan = detectHostPlan(host, env);
  const catalog = currentHostModelSnapshot(host, plan, env);
  const team = obj(state.team);
  const mode = typeof team?.mode === 'string' ? team.mode : teamModeForLevel(level);
  const lines = [
    `[local performance] performance: ${level} · team: ${mode} · host: ${host} · plan: ${plan} · catalog: ${catalog.updatedAt}`,
  ];

  if (mode === 'subagents') {
    const overrides = obj(team?.overrides);
    const planCtx = { host, plan };
    const lineup: string[] = [];
    for (const role of AGENT_ROLES) {
      const tier = effectiveTierForRole(level, role, overrides, planCtx);
      if (!tier) continue;
      const model = currentModelForTier(tier, host, plan, env);
      if (model) lineup.push(`${role} → ${tier} → ${model}`);
    }
    if (lineup.length) lines.push(`[local team lineup] ${lineup.join('; ')}`);
  }

  return `${lines.join('\n')}\n`;
}
