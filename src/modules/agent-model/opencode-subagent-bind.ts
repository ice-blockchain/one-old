// src/modules/agent-model/opencode-subagent-bind.ts
// OpenCode subagent role-claim binder (UserPromptSubmit). OpenCode exposes no
// SubagentStart hook, and its tool-call payload carries no transcript — so a
// spawned senior-* subagent has no way to resolve its run-team claim, and every
// feature-source write is denied as "main agent" (observed: tests/11d, all role
// writes `resolved:false, role:"main agent"`).
//
// The fix uses the one signal OpenCode does surface for a child session: its FIRST
// chat.message (mapped here to user-prompt-submit) is the orchestrator's spawn
// prompt, which opens with the `[t1-role: senior-x]` contract marker. We parse the
// role from that marker and stake the run-claim on the child session id, mirroring
// the Codex SubagentStart bind (claimThreadRole consumes the matching pending claim,
// so resolveRunAgentContext resolves the role on the child's first write).
//
// Kilo rides the same OpenCode-compatible hook path. Inert on other hosts (they
// bind via SubagentStart) and outside subagents mode — guarded so Claude/Codex/
// Cursor behavior is unchanged.

import { asString } from '../../adapters/coerce';
import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { obj } from '../../shared/obj';
import { captureClaimDebug, claimThreadRole, readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { canonicalHost } from '../../shared/model-tiers';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';

export function opencodeSubagentBind(ctx: Ctx): HookResult {
  if (ctx.host !== 'opencode' && ctx.host !== 'kilo') return noop();
  if (pluginUseDeclined(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const sessionId = asString(raw.session_id ?? raw.sessionID ?? raw.sessionId);
  const prompt = asString(ctx.input.prompt) || asString(raw.prompt) || asString(raw.message);
  if (!sessionId || !prompt) return noop();

  // Only relevant when the team is subagents — main-agent builds have no role claims.
  const state = readEffectiveState(ctx.cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const team = obj(obj(state)?.team);
  if (!team || team.mode !== 'subagents') return noop();

  // The marker (or "Traffic One <role>" declaration) is the contract; a prompt
  // without one is the orchestrator's own message (the user's request never carries
  // it), so no claim is staked for the parent. See inferTrafficOneSpawnRole.
  const roleResolution = inferTrafficOneSpawnRoleEvidence({ prompt, message: prompt });
  if (roleResolution.kind !== 'evidence') return noop();
  const evidence = roleResolution.evidence;
  const role = evidence.role;

  const stateObj = obj(state);
  const runId = stateObj && typeof stateObj.currentRunId === 'string' ? stateObj.currentRunId : null;
  const policy = runId ? readRunModelPolicy(ctx.cwd, runId) : null;
  if (!runId || !policy || policy.host !== canonicalHost(ctx.host)) {
    return context(
      `Traffic One blocked this child prompt: immutable model-policy.json is missing, corrupt, or belongs to another host for run ${runId || '(missing)'}. `
      + 'No role claim was created. Only the parent may create/freeze the run; stop this child and repair/respawn it from the parent.',
    );
  }
  if (!policy.roles[role]) {
    return context(
      `Traffic One blocked this child prompt: role ${role} is absent from immutable policy ${policy.policyId}. `
      + 'No role claim was created; stop this child and repair/respawn it from the parent.',
    );
  }
  captureClaimDebug(ctx.cwd, runId, 'opencode-subagent-prompt', { sessionId, role });
  // Claim only. This used to ALSO mirror the child into the role-keyed reuse
  // registry, and that row was the one piece of state here that no host ever
  // corroborated: its role came from the marker parsed above, i.e. the prompt the
  // orchestrator wrote. The reuse registry now stands down on both hosts this
  // handler serves (subagentContinuationAvailable), so the row would be unread
  // by the spawn gate yet still able to disown a live same-role claim.
  claimThreadRole(ctx.cwd, state, sessionId, role, { recordAgent: false, evidence });
  return noop();
}
