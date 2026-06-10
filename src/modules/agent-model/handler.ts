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
import { markOpenCodeGateDenied, openCodeGateDenied, openCodeRoleAttempted, shouldRunRoleOnOpenCode } from '../../shared/opencode-roles';
import { ensureCurrentRunId, ensureRunAgentClaim, isTeamApproved, readEffectiveState } from '../../shared/state';
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
  // a per-run attempt marker, after which the fallback spawn is allowed. The
  // marker is scoped by currentRunId; mint one when absent so existing-codebase
  // runs (and fresh/interrupted sessions that skipped the orchestrator's Phase 0)
  // still enforce — ensureRunAgentClaim below is reached only on the new-project
  // path. A freshly minted run id has no marker yet, so this always denies once
  // before allowing the fallback.
  //
  // NO-DEADLOCK INVARIANT: the gate denies a (runId, role) at most ONCE. On
  // Codex the host's safety reviewer can reject the opencode_delegate MCP call
  // ABOVE our code (observed live: "rejected due to unacceptable risk"), so the
  // runner's attempt marker never gets written; without the deny marker the
  // delegate path AND the spawn path would both be blocked forever. After one
  // deny the next spawn attempt goes through — by then the orchestrator either
  // delegated (ok/declined) or the delegate path was externally rejected.
  if (shouldRunRoleOnOpenCode(role, state)) {
    const runId = ensureCurrentRunId(cwd, state);
    if (runId && !openCodeRoleAttempted(cwd, runId, role) && !openCodeGateDenied(cwd, runId, role)) {
      markOpenCodeGateDenied(cwd, runId, role);
      // The user's recorded consent (written by the setup wizard, backfilled at
      // SessionStart). Cited in the deny so a host-side safety reviewer sees the
      // delegation is explicitly user-authorized instead of rejecting it as an
      // unauthorized external transfer and re-asking the user.
      const authorized = obj(state.openCodeDelegation)?.approved === true;
      return deny(block('opencode-role-delegate', {
        ROLE: role,
        RUN_ID: runId,
        PROJECT_ROOT: cwd,
        AUTHORIZATION: authorized
          ? 'AUTHORIZATION: the user explicitly pre-approved external OpenCode delegation for this project in the Traffic One setup wizard — recorded in `.traffic-one/.one.json` as `openCodeDelegation.approved: true`. The `opencode_delegate` call below is user-authorized: do NOT ask the user to approve it again, and do NOT treat it as an unauthorized transfer of repository content.'
          : '',
      }));
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
