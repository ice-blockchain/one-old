// src/shared/opencode-plan-directive.ts
// Orchestrator directives for Step-0 OpenCode plan-batch (only when delegation is
// active). Observed live (6b/Cursor): the orchestrator issued parallel implementer
// Task spawns immediately after PLAN_READY and hit the spawn gate — wasting a turn
// and confusing spawnIndex. These directives front-load the contract and re-inject
// it at PLAN_READY and on every orchestrator prompt while the batch is pending.

import { detectHost } from './host';
import { obj } from './obj';
import {
  pendingOpenCodePlanRoles,
  shouldBlockImplementerForPlanBatch,
} from './opencode-roles';
import { openCodeDelegationActive, teamModeForLevel } from './performance';
import { ensureCurrentRunId, readEffectiveState } from './state';

// Re-export for callers that need the gate predicate.
export { shouldBlockImplementerForPlanBatch as shouldWaitForOpenCodePlanBatch } from './opencode-roles';

function orchestratorSubagentsBuild(state: unknown): boolean {
  const s = obj(state);
  if (!s || s.mode !== 'new-project') return false;
  const performance = obj(s.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  return Boolean(level && teamModeForLevel(level) === 'subagents');
}

function planBatchContext(cwd: string, state: unknown, host: string = detectHost()): { runId: string; pendingRoles: string[] } | null {
  if (!orchestratorSubagentsBuild(state) || !openCodeDelegationActive(state, host)) return null;
  const runId = ensureCurrentRunId(cwd, state);
  if (!runId || !shouldBlockImplementerForPlanBatch(cwd, runId, state, host)) return null;
  const pendingRoles = pendingOpenCodePlanRoles(cwd, runId, state, host);
  if (pendingRoles.length === 0) return null;
  return { runId, pendingRoles };
}

function planBatchSteps(cwd: string, runId: string): string[] {
  return [
    '1. Call `opencode_delegate_from_plan` (MCP server `opencode-worker`) with:',
    `   - runId: \`${runId}\``,
    `   - projectRoot: \`${cwd}\``,
    '   Do NOT pass `model` unless the project explicitly pinned one.',
    '2. If the result has `running:true`, call `opencode_delegate_from_plan` AGAIN with the SAME arguments. Keep polling in the SAME turn until you get a terminal `{ total, delegated, units }` — do NOT use any shell fallback while `running:true`. Stopping polls for ~15+ minutes cancels the worker.',
    '3. Only after the terminal result, spawn `senior-backend` and `senior-frontend` in parallel in the NEXT assistant message. Pass each implementer the batch `units` summary (`touched` files; units whose `action !== "delegated"`).',
    '4. Do not re-implement files OpenCode already touched unless that unit was skipped/failed/no-changes.',
    '5. Fail-open: if the batch returns a terminal failure (`ok:false`, `action: "abandoned"`, or every unit failed/skipped/no-changes) OR the MCP tool is unavailable, proceed with paid implementer spawns — do NOT block the build on OpenCode.',
    `Fallback (MCP unavailable ONLY — never while \`running:true\`): \`node ~/.traffic-one/bin/opencode-runner.cjs --run-id "${runId}" --from-plan\` from the project root.`,
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
  return [
    headline,
    ...extraLines,
    `Pending queued role(s): ${pendingRoles.join(', ')}.`,
    ...planBatchSteps(cwd, runId),
    'HARD STOP: do NOT call Task/spawn_agent for `senior-frontend` or `senior-backend` until Step 0 reaches a terminal result. The spawn gate will deny premature attempts — run OpenCode first instead of retrying implementer spawns.',
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
    return [
      '[traffic-one] OpenCode Step 0 — run BEFORE spawning senior-backend or senior-frontend:',
      'After senior-architect emits PLAN_READY, inspect `.traffic-one/plan.md` for the `<!-- opencode-delegate:start -->` block.',
      'If the block lists bounded units, run the plan batch FIRST in its own turn:',
      ...planBatchSteps(cwd, runId),
      'HARD STOP: do NOT call Task/spawn_agent for `senior-frontend` or `senior-backend` until Step 0 reaches a terminal result. The spawn gate will deny premature attempts — run OpenCode first instead of retrying implementer spawns.',
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
    return buildPlanBatchDirective(
      cwd,
      state,
      '[traffic-one] PLAN_READY received — OpenCode Step 0 is REQUIRED before implementers:',
      [
        'The architect finished; the plan includes a bounded OpenCode queue.',
        'Your NEXT action is ONLY the Step-0 batch — not parallel senior-frontend/senior-backend spawns.',
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
      'NEXT (this turn): run OpenCode Step 0 only — do NOT retry Task spawns for senior-frontend/senior-backend yet.',
      `Pending queued role(s): ${pending.join(', ')}.`,
      ...planBatchSteps(cwd, runId),
    ].join('\n');
  } catch {
    return '';
  }
}
