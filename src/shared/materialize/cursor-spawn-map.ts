// src/shared/materialize/cursor-spawn-map.ts
// Resolves the EXACT Cursor Task `model` slug per senior-team role from the captured
// build list + tier families. Shared by onboarding-wait (pre-spawn directive),
// model-gate (spawn map stdout), and cursor-agents (agent file materialization).

import { AGENT_ROLES } from '../../config/performance';
import { detectHostPlan } from '../host-plan';
import { acceptableModelsFor } from '../model-tiers';
import { buildTeamLineup } from '../onboarding-server/flow';
import { modelForRoleHost, openCodeDelegationActive } from '../performance';
import { obj } from '../obj';
import { freshCursorModels, pickCursorSlug } from './cursor-models';

type Rec = Record<string, unknown>;

export function resolveCursorTierSlug(cwd: string, tierFamily: string, plan?: string): string {
  const captured = freshCursorModels(cwd, plan ?? detectHostPlan('cursor'));
  if (!captured.length) return tierFamily;
  return pickCursorSlug(acceptableModelsFor(tierFamily, 'cursor'), captured) || tierFamily;
}

/** True when `slug` is a bare tier family anchor, not a build-specific Task id. */
export function isBareCursorTierFamily(slug: string, tierFamily: string): boolean {
  const s = slug.trim();
  const f = tierFamily.trim();
  return s.length > 0 && s === f;
}

export function buildCursorSpawnModelMap(cwd: string, state: Rec): Record<string, string> {
  const team = obj(state.team);
  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  if (!level || team?.mode !== 'subagents') return {};

  const overrides = team && obj(team.overrides) ? (team.overrides as Rec) : null;
  const planCtx = { host: 'cursor' as const, plan: detectHostPlan('cursor'), useOpenCode: openCodeDelegationActive(state, 'cursor') };
  let lineup;
  try {
    lineup = buildTeamLineup(level, 'cursor', overrides, planCtx);
  } catch {
    return {};
  }
  if (!lineup?.length) return {};

  const captured = freshCursorModels(cwd, planCtx.plan);
  const map: Record<string, string> = {};
  for (const role of AGENT_ROLES) {
    const entry = lineup.find((m) => m.role === role);
    if (!entry?.model) continue;
    map[role] = captured.length
      ? (pickCursorSlug(acceptableModelsFor(entry.model, 'cursor'), captured) || entry.model)
      : entry.model;
  }
  return map;
}

export function formatCursorSpawnMapLines(map: Record<string, string>): string[] {
  return Object.keys(map)
    .sort()
    .map((role) => `   - ${role} → ${map[role]}`);
}

export function formatCursorSpawnMapBlock(map: Record<string, string>): string {
  const lines = formatCursorSpawnMapLines(map);
  if (!lines.length) return '';
  return [
    'traffic-one model-gate: spawn map — pass these EXACT Task `model` params (never tier family aliases):',
    ...lines,
  ].join('\n');
}

/** Refresh `.cursor/agents/<role>.md` with build-specific slugs after capture. */
export function syncCursorSpawnAgentFiles(cwd: string, state: Rec): void {
  // Lazy import breaks cursor-agents ↔ cursor-spawn-map cycle (spawn-map also drives agent writes).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./cursor-agents').writeCursorAgentFiles(cwd, state);
}
