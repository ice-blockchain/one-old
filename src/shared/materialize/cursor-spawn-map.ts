// src/shared/materialize/cursor-spawn-map.ts
// Resolves the EXACT Cursor Task `model` slug per senior-team role from the captured
// build list + tier families. Shared by onboarding-wait (pre-spawn directive)
// and model-gate (spawn map stdout). Project agent contracts stay model-agnostic.

import { AGENT_ROLES } from '../../config/performance';
import { hostSpawnType } from '../host/spawn-types';
import { detectHostPlan } from '../host/plan';
import { currentAcceptableModels } from '../current-model-tiers';
import { roleModelSelection } from '../performance';
import { obj } from '../obj';
import { policyModelsForExpected, readRunModelPolicy, type RunModelPolicyV1 } from '../run-model-policy';
import { freshCursorModels, pickCursorSlug } from './cursor-models';
import { type RoleContractOutcome, roleContractFailures } from './role-contracts';

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

/**
 * `freshlyMaterialized` = the role contracts under `.cursor/agents/` were
 * written during the session this map is printed into. Cursor captured its
 * subagent-type list before those files existed, so recommending the role-named
 * type there is a guaranteed-failed first spawn — the user sees "Couldn't
 * start" and the orchestrator burns a retry (observed 1cu and 3cu). Recommend
 * the built-in worker instead; the gate accepts either, and the role travels in
 * the `[t1-role: …]` prompt marker regardless of the type.
 */
export function formatCursorSpawnMapLines(
  map: Record<string, string>,
  freshlyMaterialized = false,
): string[] {
  return Object.keys(map)
    .sort()
    .map((role) => {
      const spawn = hostSpawnType('cursor', role);
      const type = freshlyMaterialized ? (spawn.fallback || spawn.primary) : spawn.primary;
      return `   - ${role} → subagent_type: "${type}", model: ${map[role]}`;
    });
}

export function formatCursorSpawnMapBlock(map: Record<string, string>, freshlyMaterialized = false): string {
  const lines = formatCursorSpawnMapLines(map, freshlyMaterialized);
  if (!lines.length) return '';
  const note = freshlyMaterialized
    ? '   The built-in worker type above is deliberate: `.cursor/agents/<role>.md` was written during THIS session, so a role-named `subagent_type` is not in the type list this session captured and Cursor answers "Couldn\'t start". A later session that starts with those files present may use the role name instead — both are accepted.'
    : `   If Cursor rejects a subagent_type (invalid enum / unknown type), the role files were written after this session captured its type list: retry that one spawn with \`subagent_type: "${hostSpawnType('cursor', 'senior-architect').fallback}"\`.`;
  return [
    'traffic-one model-gate: spawn map — pass BOTH values below on every Task spawn. The `model` must be an exact captured id (never an uncaptured family guess):',
    ...lines,
    note,
    '   Keep `[t1-role: senior-<role>]` as the FIRST prompt line whichever type you pass — that marker is what binds the role — and tell the child to read `.cursor/agents/<role>.md`. Do NOT build the role inline.',
  ].join('\n');
}

/**
 * Ensure model-agnostic Cursor role contracts exist after a model capture.
 *
 * RETURNS the outcome. It used to discard it, which was the one call site where
 * the writer's swallowed `mkdirSync` had no channel at all: model-gate printed
 * the spawn map — whose last line tells the orchestrator to make each child read
 * `.cursor/agents/<role>.md` — and exited 0 with no such directory on disk. The
 * instruction was not merely unhelpful, it named a file that did not exist.
 */
export function syncCursorSpawnAgentFiles(cwd: string, state: Rec): RoleContractOutcome {
  // Lazy import breaks cursor-agents ↔ cursor-spawn-map cycle (spawn-map also drives agent writes).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('./cursor-agents') as typeof import('./cursor-agents')).writeCursorAgentFiles(cwd, state);
}

/**
 * The line model-gate prints INSTEAD of leaving the spawn map's "read
 * `.cursor/agents/<role>.md`" instruction pointing at nothing. Empty on a
 * healthy sync.
 *
 * It does not change the gate's exit code. The gate's subject is model
 * availability, and failing it closed over a filesystem condition on the role
 * directory would block every spawn on a project whose `.cursor` a user made
 * read-only — a strictly worse outcome than an orchestrator that is told the
 * truth and carries the role in the `[t1-role: …]` marker, which is what
 * actually binds it (see formatCursorSpawnMapBlock).
 */
export function cursorSpawnContractWarning(outcome: RoleContractOutcome): string {
  if (outcome.kind === 'complete') return '';
  const failures = roleContractFailures(outcome)
    .slice(0, 3)
    .map((failure) => `${failure.path} (${failure.errno})`)
    .join(', ');
  return 'traffic-one model-gate: WARNING — the per-role Cursor contracts could not be written: '
    + `${failures}. Spawn using the map above, but do NOT tell a child to read \`.cursor/agents/<role>.md\`: `
    + 'that file is not there. Keep `[t1-role: senior-<role>]` as the FIRST prompt line — that marker is what '
    + 'binds the role — and state the role\'s task inline instead. Clear whatever occupies `.cursor/agents` '
    + 'and re-run `materialize-project` to restore the contracts.';
}
