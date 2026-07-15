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
import { noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { obj } from '../../shared/obj';
import { captureClaimDebug, claimThreadRole, readEffectiveState, recordRunAgent } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { inferTrafficOneSpawnRole } from './role-infer';

export function opencodeSubagentBind(ctx: Ctx): HookResult {
  if (ctx.host !== 'opencode' && ctx.host !== 'kilo') return noop();
  if (pluginUseDeclined(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const sessionId = asString(raw.session_id ?? raw.sessionID ?? raw.sessionId);
  const prompt = asString(ctx.input.prompt) || asString(raw.prompt) || asString(raw.message);
  if (!sessionId || !prompt) return noop();

  // Only relevant when the team is subagents — main-agent builds have no role claims.
  const state = readEffectiveState(ctx.cwd);
  const team = obj(obj(state)?.team);
  if (!team || team.mode !== 'subagents') return noop();

  // The marker (or "Traffic One <role>" declaration) is the contract; a prompt
  // without one is the orchestrator's own message (the user's request never carries
  // it), so no claim is staked for the parent. See inferTrafficOneSpawnRole.
  const role = inferTrafficOneSpawnRole({ prompt, message: prompt });
  if (!role) return noop();

  const stateObj = obj(state);
  const runId = stateObj && typeof stateObj.currentRunId === 'string' ? stateObj.currentRunId : null;
  captureClaimDebug(ctx.cwd, runId, 'opencode-subagent-prompt', { sessionId, role });
  claimThreadRole(ctx.cwd, state, sessionId, role, { recordAgent: false });
  if (runId) {
    recordRunAgent(ctx.cwd, runId, role, {
      agentId: sessionId,
      agentType: role,
      parentSessionId: null,
    });
  }
  return noop();
}
