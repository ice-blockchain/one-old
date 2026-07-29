// src/shared/opencode-plan/directive.ts
// Orchestrator directives for Step-0 OpenCode plan-batch (only when delegation is
// active). Observed live (6b/Cursor): the orchestrator issued parallel implementer
// Task spawns immediately after PLAN_READY and hit the spawn gate — wasting a turn
// and confusing spawnIndex. These directives front-load the contract and re-inject
// it at PLAN_READY and on every orchestrator prompt while the batch is pending.

import { detectHost } from '../host';
import { capabilityProfileForRun } from '../architecture-contract';
import { obj } from '../obj';
import {
  pendingOpenCodePlanRoles,
  shouldBlockImplementerForPlanBatch,
} from '../opencode-roles';
import { openCodeDelegationActive, teamModeForLevel } from '../performance';
import { ensureCurrentRunId, readEffectiveState } from '../state';

// Re-export for callers that need the gate predicate.
export { shouldBlockImplementerForPlanBatch as shouldWaitForOpenCodePlanBatch } from '../opencode-roles';

function orchestratorSubagentsBuild(state: unknown): boolean {
  const s = obj(state);
  if (!s || s.mode !== 'new-project') return false;
  return subagentsTeamActive(state);
}

// Phase-independent: is the orchestrator running the senior team in subagents
// mode? The plan-batch phase gate (new-project OR fresh maintenance queue) lives
// in `shouldBlockImplementerForPlanBatch`, so this only asks about team mode.
function subagentsTeamActive(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  const performance = obj(s.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  return Boolean(level && teamModeForLevel(level) === 'subagents');
}

function planBatchContext(cwd: string, state: unknown, host: string = detectHost()): { runId: string; pendingRoles: string[] } | null {
  if (!subagentsTeamActive(state) || !openCodeDelegationActive(state, host)) return null;
  const runId = ensureCurrentRunId(cwd, state);
  if (!runId || !shouldBlockImplementerForPlanBatch(cwd, runId, state, host)) return null;
  const pendingRoles = pendingOpenCodePlanRoles(cwd, runId, state, host);
  if (pendingRoles.length === 0) return null;
  return { runId, pendingRoles };
}

function eligibleImplementers(cwd: string, state: unknown): string[] {
  return capabilityProfileForRun(cwd, state).roles.filter(
    (role) => role === 'senior-frontend' || role === 'senior-backend',
  );
}

function implementerSpawnStep(cwd: string, state: unknown): string {
  const roles = eligibleImplementers(cwd, state);
  if (roles.length === 0) {
    return '3. After the terminal result, do not invent a frontend/backend worker; continue with the compiled verifier roles.';
  }
  if (roles.length === 1) {
    return `3. Only after the terminal result, spawn \`${roles[0]}\` in the NEXT assistant message. Pass it the batch \`units\` summary (\`touched\` files; units whose \`action !== "delegated"\`). Do not spawn the ineligible sibling role.`;
  }
  return `3. Only after the terminal result, spawn ${roles.map((role) => `\`${role}\``).join(' and ')} in parallel in the NEXT assistant message. Pass each implementer the batch \`units\` summary (\`touched\` files; units whose \`action !== "delegated"\`).`;
}

function planBatchSteps(cwd: string, runId: string, state: unknown): string[] {
  return [
    '1. Call `opencode_delegate_from_plan` (MCP server `opencode-worker`) with:',
    `   - runId: \`${runId}\``,
    `   - projectRoot: \`${cwd}\``,
    '   Do NOT pass `model` unless the project explicitly pinned one.',
    '2. If the result has `running:true`, call `opencode_delegate_from_plan` AGAIN with the SAME arguments. Keep polling in the SAME turn until you get a terminal `{ total, delegated, units }` — do NOT use any shell fallback while `running:true`. Stopping polls for ~15+ minutes cancels the worker.',
    implementerSpawnStep(cwd, state),
    '4. Do not re-implement files OpenCode already touched unless that unit was skipped/failed/no-changes.',
    '5. Fail-open: when the batch reaches a terminal outcome (`ok:false`, `action: "abandoned"`, every unit failed/skipped/no-changes) OR the MCP tool is unavailable, proceed with paid implementer spawns — but only after terminal batch markers exist (`batch.json` with outcome other than `running`, or legacy `COMPLETE`). A bare shell JSON line alone does not clear the spawn gate.',
    `Fallback (MCP unavailable ONLY — never while \`running:true\`): \`node ~/.traffic-one/bin/opencode-runner.cjs --run-id "${runId}" --from-plan\` from the project root (writes the same terminal batch markers as the MCP tool). For a stuck run with terminal unit rows but no batch.json, use \`--finalize-only\` instead of re-delegating.`,
  ];
}

function buildPlanBatchDirective(
  cwd: string,
  state: unknown,
  headline: string,
  extraLines: string[] = [],
  host: string = detectHost(),
): string {
  const ctx = planBatchContext(cwd, state, host);
  if (!ctx) return '';
  const { runId, pendingRoles } = ctx;
  const eligible = eligibleImplementers(cwd, state);
  return [
    headline,
    ...extraLines,
    `Pending queued role(s): ${pendingRoles.join(', ')}.`,
    ...planBatchSteps(cwd, runId, state),
    `HARD STOP: do NOT call Task/spawn_agent for ${eligible.map((role) => `\`${role}\``).join(' or ') || 'an invented implementer'} until Step 0 reaches a terminal result. The spawn gate will deny premature attempts — run OpenCode first instead of retrying implementer spawns.`,
    'Do NOT spawn implementers in the same assistant message as the Step-0 call.',
  ].join('\n');
}

/** SETUP_COMPLETE channel — proactive contract when OpenCode delegation is active. */
export function buildPreSpawnOpenCodeDirective(cwd: string, host: string = detectHost()): string {
  try {
    const state = readEffectiveState(cwd);
    if (!state || !orchestratorSubagentsBuild(state) || !openCodeDelegationActive(state, host)) return '';
    const runId = ensureCurrentRunId(cwd, state);
    if (!runId) return '';
    const implementers = eligibleImplementers(cwd, state);
    const implementerLabel = implementers.map((role) => `\`${role}\``).join(' or ') || 'any invented implementer';
    return [
      `[traffic-one] OpenCode Step 0 — run BEFORE spawning ${implementerLabel}:`,
      'After senior-architect emits PLAN_READY, inspect `.traffic-one/plan.md` for the `<!-- opencode-delegate:start -->` block.',
      'If the block lists bounded units, run the plan batch FIRST in its own turn:',
      ...planBatchSteps(cwd, runId, state),
      `HARD STOP: do NOT call Task/spawn_agent for ${implementerLabel} until Step 0 reaches a terminal result. The spawn gate will deny premature attempts — run OpenCode first instead of retrying implementer spawns.`,
      'Do NOT spawn implementers in the same assistant message as the Step-0 call.',
    ].join('\n');
  } catch {
    return '';
  }
}

/** PostToolUse when architect digest carries PLAN_READY — re-inject while batch pending. */
export function buildPostPlanReadyOpenCodeDirective(cwd: string): string {
  try {
    const state = readEffectiveState(cwd);
    if (!state) return '';
    const implementers = eligibleImplementers(cwd, state);
    const nextAction = implementers.length > 1
      ? `Your NEXT action is ONLY the Step-0 batch — not parallel ${implementers.join('/')} spawns.`
      : implementers.length === 1
        ? `Your NEXT action is ONLY the Step-0 batch — do not spawn \`${implementers[0]}\` yet.`
        : 'Your NEXT action is ONLY the Step-0 batch — do not invent an implementation role.';
    return buildPlanBatchDirective(
      cwd,
      state,
      '[traffic-one] PLAN_READY received — OpenCode Step 0 is REQUIRED before implementers:',
      [
        'The architect finished; the plan includes a bounded OpenCode queue.',
        nextAction,
      ],
      detectHost(),
    );
  } catch {
    return '';
  }
}

/** UserPromptSubmit — remind the orchestrator on each turn while the batch is still open. */
export function buildOpenCodePlanBatchPendingDirective(cwd: string, state?: unknown): string {
  try {
    const s = state ?? readEffectiveState(cwd);
    if (!s) return '';
    return buildPlanBatchDirective(
      cwd,
      s,
      '[traffic-one] OpenCode Step 0 still pending — finish the plan batch before implementer spawns:',
      ['OpenCode delegation is active; implementer spawns stay gated until the batch is terminal.'],
      detectHost(),
    );
  } catch {
    return '';
  }
}

/** Short deny-side context for the spawn gate (plan-batch-required block). */
export function buildOpenCodePlanBatchDenyContext(cwd: string, runId: string, queuedRoles: string[]): string {
  try {
    const state = readEffectiveState(cwd);
    const host = detectHost();
    if (!state || !openCodeDelegationActive(state, host)) return '';
    const pending = queuedRoles.length > 0 ? queuedRoles : pendingOpenCodePlanRoles(cwd, runId, state, host);
    if (pending.length === 0) return '';
    return [
      `NEXT (this turn): run OpenCode Step 0 only — do NOT retry Task spawns for ${eligibleImplementers(cwd, state).join('/') || 'an invented implementer'} yet.`,
      `Pending queued role(s): ${pending.join(', ')}.`,
      ...planBatchSteps(cwd, runId, state),
    ].join('\n');
  } catch {
    return '';
  }
}
