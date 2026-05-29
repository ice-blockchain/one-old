// src/shared/performance.ts
// Performance-level → team-mode + per-role model resolution. Ported 1:1 from
// the resolver functions in scripts/hook-runtime/agents-performance-prompt.cjs.
// (The popup/chat PROSE lands in the agent-model module's skill.)

import { canonicalTier, resolveModel, tierModelTable, type TierId } from './model-tiers';
import { PERFORMANCE_CONFIG } from './performance-config';

export function teamModeForLevel(level: string): 'main-agent' | 'subagents' {
  const cfg = PERFORMANCE_CONFIG[level];
  return cfg ? cfg.teamMode : 'main-agent';
}

export function autoLaunchesTeam(level: string): boolean {
  return level === 'balanced' || level === 'high';
}

// Effective tier for a role at a level, honoring user `team.overrides`. Null when
// the level has no subagents (low) or the role isn't configured.
export function effectiveTierForRole(level: string, role: string, overrides?: Record<string, unknown> | null): TierId | null {
  const cfg = PERFORMANCE_CONFIG[level];
  const agent = cfg ? cfg.agents[role] : undefined;
  if (!agent) return null;
  if (overrides && typeof overrides === 'object') {
    const override = canonicalTier(overrides[role]);
    if (override) return override;
  }
  return agent.tier;
}

export function modelForRole(
  level: string,
  role: string,
  overrides?: Record<string, unknown> | null,
): { tier: TierId; claude: string; codex: string; cursor: string } | null {
  const tier = effectiveTierForRole(level, role, overrides);
  return tier ? tierModelTable(tier) : null;
}

export function modelForRoleHost(level: string, role: string, host: string, overrides?: Record<string, unknown> | null): string | null {
  const tier = effectiveTierForRole(level, role, overrides);
  return tier ? resolveModel(tier, host) : null;
}
