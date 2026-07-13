// src/shared/build-orchestration-directive.ts
// Post-setup build-start directive for OpenCode/Kilo hosts: the orchestrator must
// spawn senior-architect via the host task tool BEFORE any feature-source or
// monorepo scaffold writes. OpenCode exposes the materialized named role agents;
// Kilo's Task API reliably exposes its built-in general worker, which reads the
// matching materialized role contract before it works.

import * as fs from 'fs';
import * as path from 'path';

import { architectPhaseIncompleteReasons } from '../modules/plan-guard/plan-readiness';
import { canonicalHost } from './model-tiers';
import { obj, type Rec } from './obj';
import { pluginRoot } from './paths';
import { teamModeForLevel } from './performance';
import { makeSkillBlock } from './skill-block';
import { ensureCurrentRunId, isMaintenancePhase, readEffectiveState } from './state';
import { openCodeGlobalAgentName, openCodeGlobalAgentPath } from './materialize/opencode-assets';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);

function kiloOpenCodeSubagentsBuild(state: Rec, host: string): boolean {
  if (state.mode !== 'new-project') return false;
  // `mode` deliberately remains `new-project` after the first build so the
  // original stack/plan gates stay available. The lifecycle is what tells us the
  // greenfield build is over. Never inject an architect-first build directive for
  // a maintenance prompt; maintenance triage owns its direct-role vs architect
  // decision and only complex work may re-enter the orchestrator.
  if (isMaintenancePhase(state, state.mode)) return false;
  const h = canonicalHost(host);
  if (h !== 'kilo' && h !== 'opencode') return false;
  const team = obj(state.team);
  if (!team || team.mode !== 'subagents' || team.approved !== true) return false;
  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  if (level && teamModeForLevel(level) !== 'subagents') return false;
  return true;
}

export function shouldEmitBuildOrchestration(cwd: string, state: Rec, host: string): boolean {
  if (!kiloOpenCodeSubagentsBuild(state, host)) return false;
  try {
    return !fs.existsSync(path.join(cwd, '.traffic-one', 'plan.md'));
  } catch {
    return true;
  }
}

export function shouldEmitArchitectCompletionReminder(cwd: string, state: Rec, host: string): boolean {
  if (!kiloOpenCodeSubagentsBuild(state, host)) return false;
  try {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', 'plan.md'))) return false;
  } catch {
    return false;
  }
  return architectPhaseIncompleteReasons(cwd, state).length > 0;
}

export function buildOrchestrationDirective(cwd: string, host: string, stateIn?: Rec): string {
  const loadedState = stateIn ?? readEffectiveState(cwd);
  const state = obj(loadedState) ? (loadedState as Rec) : {};
  if (!kiloOpenCodeSubagentsBuild(state, host)) return '';

  const canonical = canonicalHost(host);
  const kilo = canonical === 'kilo';
  const hostLabel = canonical === 'kilo' ? 'Kilo' : 'OpenCode';
  const architectSubagentType = kilo ? 'general' : openCodeGlobalAgentName(cwd, 'senior-architect');
  const spawnRule = kilo
    ? 'use Kilo\'s built-in `general` Task type. It is a real subagent; do not use `explore` and do not fall back to main-agent mode.'
    : `use the project-scoped global agent \`${architectSubagentType}\` materialized at ${openCodeGlobalAgentPath(cwd, 'senior-architect')}; do not use built-in \`general\`/\`explore\`.`;
  const roleContractInstruction = kilo
    ? 'Immediately after the role marker, tell the child to read `.kilo/agents/senior-architect.md` before acting; that file is the full Traffic One role contract.'
    : 'The named OpenCode agent already carries the full Traffic One role contract.';

  if (shouldEmitBuildOrchestration(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    return block('kilo-opencode-spawn-first', {
      HOST: hostLabel,
      RUN_ID: runId,
      TASK_TOOL: 'task',
      SUBAGENT_TYPE: architectSubagentType,
      SPAWN_RULE: spawnRule,
      ROLE_CONTRACT_INSTRUCTION: roleContractInstruction,
    });
  }

  if (shouldEmitArchitectCompletionReminder(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    const missing = architectPhaseIncompleteReasons(cwd, state).join('; ');
    return block('kilo-opencode-architect-incomplete', {
      HOST: hostLabel,
      RUN_ID: runId,
      TASK_TOOL: 'task',
      SUBAGENT_TYPE: architectSubagentType,
      SPAWN_RULE: spawnRule,
      ROLE_CONTRACT_INSTRUCTION: roleContractInstruction,
      MISSING: missing,
    });
  }

  return '';
}
