// src/shared/materialize/cursor-spawn-map.ts
// Resolves the EXACT Cursor Task `model` slug per senior-team role from the captured
// build list + tier families. Shared by onboarding-wait (pre-spawn directive)
// and model-gate (spawn map stdout). Project agent contracts stay model-agnostic.

import { AGENT_ROLES } from '../../config/performance';
import { detectHostPlan } from '../host-plan';
import { currentAcceptableModels } from '../current-model-tiers';
import { buildTeamLineup } from '../onboarding-server/flow';
import { modelForRoleHost } from '../performance';
import { obj } from '../obj';
import { policyModelsForExpected, readRunModelPolicy, type RunModelPolicyV1 } from '../run-model-policy';
import { freshCursorModels, pickCursorSlug } from './cursor-models';

type Rec = Record<string, unknown>;

export function resolveCursorTierSlug(cwd: string, tierFamily: string, plan?: string, runId?: string): string {
  const policy = runId ? readRunModelPolicy(cwd, runId) : null;
  if (runId && (!policy || policy.host !== 'cursor')) return tierFamily;
  if (policy) {
    return pickCursorSlug(
      policyModelsForExpected(policy, tierFamily),
      policy.cursorAvailableModels || [],
    ) || tierFamily;
  }
  const captured = freshCursorModels(cwd, plan ?? detectHostPlan('cursor'));
  if (!captured.length) return tierFamily;
  const activePlan = plan ?? detectHostPlan('cursor');
  return pickCursorSlug(currentAcceptableModels(tierFamily, 'cursor', activePlan), captured) || tierFamily;
}

/** True when `slug` is a bare tier family anchor, not a build-specific Task id. */
export function isBareCursorTierFamily(slug: string, tierFamily: string): boolean {
  const s = slug.trim();
  const f = tierFamily.trim();
  return s.length > 0 && s === f;
}

function frozenCursorSpawnModelMap(policy: RunModelPolicyV1): Record<string, string> {
  if (policy.host !== 'cursor') return {};
  const captured = [...(policy.cursorAvailableModels || [])];
  if (!captured.length) return {};
  const map: Record<string, string> = {};
  for (const role of AGENT_ROLES) {
    const rolePolicy = policy.roles[role];
    if (!rolePolicy) continue;
    const exact = pickCursorSlug(rolePolicy.acceptableModels, captured);
    if (exact) map[role] = exact;
  }
  return map;
}

export function buildCursorSpawnModelMap(cwd: string, state: Rec): Record<string, string> {
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (runId) {
    const policy = readRunModelPolicy(cwd, runId);
    // A published run never falls back to mutable plan/catalog/preferences. An
    // absent or corrupt snapshot therefore produces no spawn map (the caller's
    // parent gate turns that into an explicit fail-closed stop).
    return policy ? frozenCursorSpawnModelMap(policy) : {};
  }

  // Before the parent has minted a run, onboarding may show a capture preview.
  // This is the only path allowed to inspect the current mutable target.
  const team = obj(state.team);
  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  if (!level || team?.mode !== 'subagents') return {};

  const overrides = team && obj(team.overrides) ? (team.overrides as Rec) : null;
  const planCtx = { host: 'cursor' as const, plan: detectHostPlan('cursor') };
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
      ? (pickCursorSlug(currentAcceptableModels(entry.model, 'cursor', planCtx.plan), captured) || entry.model)
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

/** Ensure model-agnostic Cursor role contracts exist after a model capture. */
export function syncCursorSpawnAgentFiles(cwd: string, state: Rec): void {
  // Lazy import breaks cursor-agents ↔ cursor-spawn-map cycle (spawn-map also drives agent writes).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./cursor-agents').writeCursorAgentFiles(cwd, state);
}
