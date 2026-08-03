// Dynamic, machine-local performance context injected by SessionStart. This is
// the only parent-session role→model lineup; generated project artifacts remain
// plan/model agnostic so different users and hosts can share the same checkout.

import { AGENT_ROLES, PERFORMANCE_CONFIG } from '../config/performance';
import { currentHostModelTarget, currentModelForTier } from './current-model-tiers';
import { detectHostPlan } from './host/plan';
import { canonicalHost } from './model-tiers';
import { obj } from './obj';
import { effectiveTierForRole, teamModeForLevel } from './performance';
import { readRunModelPolicy } from './run-model-policy';

export function sessionPerformanceContext(
  stateInput: unknown,
  hostInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): string {
  const state = obj(stateInput);
  const performance = obj(state?.performance);
  const level = typeof performance?.level === 'string' ? performance.level : '';
  if (!state || !PERFORMANCE_CONFIG[level]) return '';

  const host = canonicalHost(hostInput);
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  const policy = cwd && runId ? readRunModelPolicy(cwd, runId) : null;
  const plan = policy?.plan || detectHostPlan(host, env);
  const catalog = policy ? null : currentHostModelTarget(host, plan, env);
  const team = obj(state.team);
  const mode = typeof team?.mode === 'string' ? team.mode : teamModeForLevel(level);
  const catalogLabel = policy
    ? `run policy ${policy.policyId}`
    : catalog!.source === 'one-mcp'
      ? `one-mcp v${catalog!.configVersion}`
      : 'bundled';
  const lines = [
    `[local performance] performance: ${level} · team: ${mode} · host: ${host} · plan: ${plan} · catalog: ${catalogLabel}`,
  ];

  if (mode === 'subagents') {
    const overrides = obj(team?.overrides);
    const planCtx = { host, plan };
    const lineup: string[] = [];
    for (const role of AGENT_ROLES) {
      const pinned = policy?.roles[role];
      const tier = pinned?.tier || effectiveTierForRole(level, role, overrides, planCtx);
      if (!tier) continue;
      const model = pinned?.preferredModel || currentModelForTier(tier, host, plan, env);
      if (model) lineup.push(`${role} → ${tier} → ${model}`);
    }
    if (lineup.length) lines.push(`[local team lineup] ${lineup.join('; ')}`);
  }

  return `${lines.join('\n')}\n`;
}
