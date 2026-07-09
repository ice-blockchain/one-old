// src/shared/build-orchestration-directive.ts
// Post-setup build-start directive for OpenCode/Kilo hosts: the orchestrator must
// spawn senior-architect via task/general BEFORE any feature-source or monorepo
// scaffold writes. Observed on Kilo/WebStorm when the parent jumped straight to
// root tsconfig + src/vite-env.d.ts and hit plan/run-team gates.

import * as fs from 'fs';
import * as path from 'path';

import { architectPhaseIncompleteReasons } from '../modules/plan-guard/plan-readiness';
import { canonicalHost } from './model-tiers';
import { obj, type Rec } from './obj';
import { pluginRoot } from './paths';
import { teamModeForLevel } from './performance';
import { makeSkillBlock } from './skill-block';
import { ensureCurrentRunId, readEffectiveState } from './state';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);

function kiloOpenCodeSubagentsBuild(state: Rec, host: string): boolean {
  if (state.mode !== 'new-project') return false;
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

  const hostLabel = canonicalHost(host) === 'kilo' ? 'Kilo' : 'OpenCode';

  if (shouldEmitBuildOrchestration(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    return block('kilo-opencode-spawn-first', {
      HOST: hostLabel,
      RUN_ID: runId,
      TASK_TOOL: 'task',
      SUBAGENT_TYPE: 'general',
    });
  }

  if (shouldEmitArchitectCompletionReminder(cwd, state, host)) {
    const runId = ensureCurrentRunId(cwd, state);
    const missing = architectPhaseIncompleteReasons(cwd, state).join('; ');
    return block('kilo-opencode-architect-incomplete', {
      HOST: hostLabel,
      RUN_ID: runId,
      TASK_TOOL: 'task',
      SUBAGENT_TYPE: 'general',
      MISSING: missing,
    });
  }

  return '';
}
