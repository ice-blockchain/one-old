// src/shared/opencode-plan-directive.ts
// Front-load Step-0 OpenCode plan-batch instructions for the orchestrator at
// SETUP_COMPLETE (same channel as preSpawnRunIdDirective / preSpawnModelDirective).
// Observed live (5b/Cursor): the orchestrator spawned senior-backend +
// senior-frontend in parallel immediately after PLAN_READY and skipped
// opencode_delegate_from_plan despite openCode.enabled and a populated queue.

import { detectHost } from './host';
import { obj } from './obj';
import { openCodeDelegationActive, teamModeForLevel } from './performance';
import { ensureCurrentRunId, readEffectiveState } from './state';

export function buildPreSpawnOpenCodeDirective(cwd: string, host: string = detectHost()): string {
  try {
    const state = readEffectiveState(cwd);
    if (!state || state.mode !== 'new-project') return '';
    const performance = obj(state.performance);
    const level = performance && typeof performance.level === 'string' ? performance.level : '';
    if (!level || teamModeForLevel(level) !== 'subagents') return '';
    if (!openCodeDelegationActive(state)) return '';
    const runId = ensureCurrentRunId(cwd, state);
    if (!runId) return '';

    return [
      '[traffic-one] OpenCode Step 0 — run BEFORE spawning senior-backend or senior-frontend:',
      'After senior-architect emits PLAN_READY, inspect `.traffic-one/plan.md` for the `<!-- opencode-delegate:start -->` block.',
      'If the block lists bounded units, run the plan batch FIRST in its own turn — do NOT spawn implementers in the same message:',
      '1. Call `opencode_delegate_from_plan` (MCP server `opencode-worker`) with:',
      `   - runId: \`${runId}\``,
      `   - projectRoot: \`${cwd}\``,
      '   Do NOT pass `model` unless the project explicitly pinned one.',
      '2. If the result has `running:true`, call `opencode_delegate_from_plan` AGAIN with the SAME arguments until you get a terminal `{ total, delegated, units }`.',
      '3. Only after the terminal result, spawn `senior-backend` and `senior-frontend` in parallel (next message). Pass each implementer the batch `units` summary, including `touched` files and any unit whose `action !== "delegated"`.',
      '4. Do not re-implement files OpenCode already touched unless that unit was skipped/failed/no-changes.',
      'Do NOT spawn implementers in the same assistant message as the Step-0 call.',
      'Fallback if the MCP tool is unavailable: `node ~/.traffic-one/bin/opencode-runner.cjs --run-id "'
        + `${runId}" --from-plan` + '` from the project root.',
      'The spawn gate blocks implementer spawns until this batch completes when a queue exists.',
    ].join('\n');
  } catch {
    return '';
  }
}
