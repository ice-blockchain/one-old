// src/shared/materialize/cursor-spawn-map.ts
// Resolves the EXACT Cursor Task `model` slug per senior-team role from the captured
// build list + tier families. Shared by onboarding-wait (pre-spawn directive)
// and model-gate (spawn map stdout). Project agent contracts stay model-agnostic.

import { AGENT_ROLES } from '../../config/performance';
import { hostSpawnType } from '../host-spawn-types';
import { detectHostPlan } from '../host-plan';
import { currentAcceptableModels } from '../current-model-tiers';
import { roleModelSelection } from '../performance';
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
  const modelSelections = team && obj(team.modelSelections) ? (team.modelSelections as Rec) : null;
  const planCtx = { host: 'cursor' as const, plan: detectHostPlan('cursor') };

  const captured = freshCursorModels(cwd, planCtx.plan);
  const map: Record<string, string> = {};
  for (const role of AGENT_ROLES) {
    const selection = roleModelSelection(
      level,
      role,
      'cursor',
      overrides,
      modelSelections,
      planCtx,
    );
    if (!selection) return {};
    if (!captured.length) {
      map[role] = selection.preferredModel;
      continue;
    }
    const exact = pickCursorSlug(selection.acceptableModels, captured);
    // A captured exact id may legitimately equal its family anchor (for
    // example `gpt-5.4-mini`). Membership in the captured picker snapshot is
    // the invariant; never publish an uncaptured family fallback as exact.
    if (exact) map[role] = exact;
  }
  return map;
}

export function formatCursorSpawnMapLines(map: Record<string, string>): string[] {
  return Object.keys(map)
    .sort()
    .map((role) => {
      const spawn = hostSpawnType('cursor', role);
      return `   - ${role} → subagent_type: "${spawn.primary}", model: ${map[role]}`;
    });
}

export function formatCursorSpawnMapBlock(map: Record<string, string>): string {
  const lines = formatCursorSpawnMapLines(map);
  if (!lines.length) return '';
  const fallback = hostSpawnType('cursor', 'senior-architect').fallback;
  return [
    'traffic-one model-gate: spawn map — pass BOTH values below on every Task spawn. The `model` must be an exact captured id (never an uncaptured family guess):',
    ...lines,
    `   If Cursor rejects a subagent_type (invalid enum / unknown type), the role files were written after this session captured its type list: retry that one spawn with \`subagent_type: "${fallback}"\`, keep \`[t1-role: senior-<role>]\` as the FIRST prompt line, and tell the child to read \`.cursor/agents/<role>.md\`. Do NOT build the role inline.`,
  ].join('\n');
}

/** Ensure model-agnostic Cursor role contracts exist after a model capture. */
export function syncCursorSpawnAgentFiles(cwd: string, state: Rec): void {
  // Lazy import breaks cursor-agents ↔ cursor-spawn-map cycle (spawn-map also drives agent writes).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./cursor-agents').writeCursorAgentFiles(cwd, state);
}
