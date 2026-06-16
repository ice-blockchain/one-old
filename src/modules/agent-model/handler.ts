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
import { resolveModel } from '../../shared/model-tiers';
import { modelForRoleHost, openCodeDelegationActive, teamModeForLevel } from '../../shared/performance';
import { PERFORMANCE_LEVEL_IDS } from '../../config/state';
import { makeSkillBlock } from '../../shared/skill-block';
import { markOpenCodeGateDenied, openCodeGateDenied, openCodeRoleAttempted, shouldRunRoleOnOpenCode } from '../../shared/opencode-roles';
import {
  ensureCurrentRunId,
  ensureRunAgentClaim,
  hookSessionIdentity,
  isTeamApproved,
  liveRunAgent,
  markRunAgentReplaced,
  readEffectiveState,
  REPLACE_AGENT_MARKER,
  subagentContinuationAvailable,
} from '../../shared/state';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import { isCompletedTrafficOneMaterialization, materializeIfNeeded } from './converge';
import { inferTrafficOneSpawnRole } from './role-infer';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string => skillBlock('agent-model', name, vars);

// NOTE: model-tier gating DOES fire on Cursor — the generic before-tool-use hook
// derives spawn-agent from tool_name=Task (cursor.ts GENERIC_PRE_ADMIT), and this
// gate has no host guard, so the tier deny applies once per spawn (the run-claim is
// staked here ONLY; subagentStart is a different canonical event, so no double-claim).
// Only agent REUSE/continuation stays inert on Cursor — subagentContinuationAvailable()
// is false there (no SendMessage/continuation primitive), so the reuse path no-ops.
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

  // A role spawn is imminent → make sure the version-stable runner shims exist
  // BEFORE any subagent runs prose that references ~/.traffic-one/bin. This is
  // the reliable cross-host site: Codex executes PreToolUse but not the
  // SessionStart injection path. Idempotent, ~1ms when already current.
  ensureRunnerShims();

  // OpenCode role delegation (all modes, all hosts): a configured role MUST run
  // on OpenCode first when delegation is enabled. Deny its paid spawn until
  // OpenCode has actually reached the CLI for this role in the current run — the
  // runner writes a per-run attempt marker at that point, after which the
  // fallback spawn is allowed. The marker is scoped by currentRunId; mint one
  // when absent so existing-codebase runs (and fresh/interrupted sessions that
  // skipped the orchestrator's Phase 0) still enforce — ensureRunAgentClaim
  // below is reached only on the new-project path. A freshly minted run id has
  // no marker yet, so this always denies once before allowing the fallback.
  //
  // NO-DEADLOCK INVARIANT: the gate denies a (runId, role) at most ONCE. If the
  // opencode_delegate tool call can't complete for any reason (tool not yet
  // loaded, transient error), the attempt marker may never be written; without
  // the deny marker the delegate path AND the spawn path would both be blocked
  // forever. After one deny the next spawn attempt goes through as the fallback.
  if (shouldRunRoleOnOpenCode(role, state)) {
    const runId = ensureCurrentRunId(cwd, state);
    if (runId && !openCodeRoleAttempted(cwd, runId, role) && !openCodeGateDenied(cwd, runId, role)) {
      markOpenCodeGateDenied(cwd, runId, role);
      return deny(block('opencode-role-delegate', { ROLE: role, RUN_ID: runId, PROJECT_ROOT: cwd }));
    }
  }

  // Subagent reuse (hosts with agent continuation): when this run already holds
  // a LIVE agent for the role, a fresh same-role spawn re-loads the entire
  // rules+skills context and re-explores the codebase — measured at 7 frontend
  // spawns in one build where 1 should have served. Deny the duplicate spawn and
  // point the orchestrator at the recorded agent id to continue via SendMessage.
  // Escape hatch: a spawn prompt carrying REPLACE_AGENT_MARKER retires the
  // recorded agent (context exhausted / SendMessage errored) and passes through,
  // so the recorder can capture the replacement. Entries from another parent
  // session never match (liveRunAgent) — in-process agents die with their
  // session, so a resumed orchestrator spawns fresh without friction.
  if (subagentContinuationAvailable()) {
    const runId = typeof state.currentRunId === 'string' && state.currentRunId.trim() ? state.currentRunId.trim() : null;
    if (runId) {
      const promptText = [toolInput.prompt, toolInput.message, toolInput.task, toolInput.description]
        .filter((v): v is string => typeof v === 'string')
        .join('\n');
      if (promptText.includes(REPLACE_AGENT_MARKER)) {
        markRunAgentReplaced(cwd, runId, role);
      } else {
        const live = liveRunAgent(cwd, runId, role, hookSessionIdentity(raw).sessionId);
        if (live) {
          return deny(block('agent-reuse-continue', { ROLE: role, RUN_ID: runId, AGENT_ID: live.agentId, MARKER: REPLACE_AGENT_MARKER }));
        }
      }
    }
  }

  // quick-fix is the post-build maintenance worker: its cheapest-model pin is
  // enforced in EVERY mode — the per-role tier gate below is new-project-scoped,
  // but maintenance triage mostly fires on existing codebases — and the pin is
  // absolute (team.overrides cannot lift it). Stake the run claim too, so the
  // run-team write gate can resolve the worker's role on its first write.
  if (role === 'quick-fix') {
    const expected = resolveModel('cheapest', ctx.host);
    const passedModel = typeof toolInput.model === 'string' ? toolInput.model.trim() : '';
    if (expected && passedModel !== expected) {
      const passedNote = passedModel
        ? `You passed model="${passedModel}". `
        : 'You passed no `model` parameter, so the subagent would inherit the parent model (e.g. opus). ';
      return deny(block('performance-model-param', { LEVEL: 'maintenance', HOST: ctx.host, ROLE: role, EXPECTED: expected, PASSED_NOTE: passedNote }));
    }
    ensureRunAgentClaim(cwd, state, role, raw, {
      toolName,
      agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || undefined,
      model: passedModel,
    });
    return noop();
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
