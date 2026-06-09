// src/modules/agent-model/handler.ts
// PreToolUse spawn-agent gate (priority 40): for new-project builds, enforce
// materialization → performance level → team approval → the per-role model
// parameter, then stake a run-agent claim. Ported 1:1 from runCheckAgentModel
// (gates.cjs). Spawn-specific fields (subagent_type, model, …) come from
// ctx.input.raw (the canonical ToolInput doesn't carry them). Deny PROSE → skill.

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import { deny, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import { pluginRoot } from '../../shared/paths';
import { detectHostPlan } from '../../shared/host-plan';
import { modelForRoleHost, openCodeDelegationActive, teamModeForLevel } from '../../shared/performance';
import { PERFORMANCE_LEVEL_IDS } from '../../config/state';
import { makeSkillBlock } from '../../shared/skill-block';
import { openCodeRoleAttempted, shouldRunRoleOnOpenCode } from '../../shared/opencode-roles';
import { ensureRunAgentClaim, isTeamApproved, readEffectiveState } from '../../shared/state';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from './converge';
import { inferTrafficOneSpawnRole } from './role-infer';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string => skillBlock('agent-model', name, vars);

export function agentModelGate(ctx: Ctx): HookResult {
  if (authChoiceAllowsContinue(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  // Normalize a host namespace (Codex `multi_agent_v1.spawn_agent`) to the bare name
  // before matching, so the gate can't silently bail on a qualified spawn tool.
  if (toolName && !/^(Task|Agent|spawn_agent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const role = inferTrafficOneSpawnRole(toolInput);
  if (!role) return noop();

  const cwd = ctx.cwd;
  const state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return noop();

  // OpenCode role delegation (all modes): a configured role MUST run on the free
  // OpenCode agent first (when `openCode.enabled`). Deny its paid spawn until
  // OpenCode has been tried for this role in the current run — the runner writes
  // a per-run attempt marker, after which the fallback spawn is allowed. Needs a
  // currentRunId to scope the marker; without one we can't track attempts, so skip.
  if (shouldRunRoleOnOpenCode(role, state)) {
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    if (runId && !openCodeRoleAttempted(cwd, runId, role)) {
      return deny(block('opencode-role-delegate', { ROLE: role, RUN_ID: runId }));
    }
  }

  if (state.mode !== 'new-project') return noop();

  if (!isCompletedTrafficOneMaterialization(cwd, state)) {
    materializeIfNeeded(cwd);
    if (isCompletedTrafficOneMaterialization(cwd, readEffectiveState(cwd))) return deny(block('agent-materialization-deny'));
    return deny(block('agent-materialization-missing'));
  }

  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' && PERFORMANCE_LEVEL_IDS.has(performance.level)
    ? performance.level
    : null;
  if (!level) return noop();

  if (teamModeForLevel(level) === 'main-agent') {
    return deny(block('performance-main-agent', { LEVEL: level, ROLE: role }));
  }
  if (!isTeamApproved(state.team)) {
    return deny(block('team-confirmation', { LEVEL: level }));
  }

  const team = obj(state.team);
  const overrides = team && obj(team.overrides) ? (team.overrides as Rec) : null;
  const planCtx = { host: ctx.host, plan: detectHostPlan(ctx.host), useOpenCode: openCodeDelegationActive(state) };
  const expected = modelForRoleHost(level, role, ctx.host, overrides, planCtx);
  if (!expected) return noop();

  const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
  if (passedModel !== expected) {
    const passedNote = passedModel
      ? `You passed model="${passedModel}". `
      : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ';
    return deny(block('performance-model-param', { LEVEL: level, HOST: ctx.host, ROLE: role, EXPECTED: expected, PASSED_NOTE: passedNote }));
  }

  ensureRunAgentClaim(cwd, state, role, raw, {
    toolName,
    agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || undefined,
    model: passedModel,
  });
  return noop();
}
