// src/modules/agent-model/subagent-bind.ts
// SubagentStart handler (Codex). Best-effort EARLY claim: Codex fires no PreToolUse
// for spawns, so the agent-model gate never stakes a claim. SubagentStart hands us the
// child thread id (`agent_id`) but no role, so we read the child's rollout
// (`transcript_path`) and infer the senior-* role from its spawn prompt, then claim the
// thread. SubagentStart can fire before the rollout is flushed — if the role isn't
// readable yet this is a silent no-op, and resolveRunAgentContext re-attempts the same
// inference at the child's first gated write (when the transcript is populated).

import { asString } from '../../adapters/coerce';
import { obj } from '../../shared/obj';
import { noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { captureClaimDebug, claimThreadRole, hookSessionIdentity, inferRoleFromTranscript, readEffectiveState, transcriptThreadId } from '../../shared/state';
import { authChoiceAllowsContinue } from '../session/auth-choice';

export function subagentStartBind(ctx: Ctx): HookResult {
  if (authChoiceAllowsContinue(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const state = readEffectiveState(ctx.cwd);
  const team = obj(obj(state)?.team);
  const stateObj = obj(state);
  const runId = stateObj && typeof stateObj.currentRunId === 'string' ? stateObj.currentRunId : null;

  // DIAGNOSTIC (best-effort): record the raw SubagentStart payload in subagents
  // mode — captured BEFORE the field guards so we learn whether agent-teams even
  // fires SubagentStart and what identity it carries (see
  // project_agent_teams_claim_deadlock). Does NOT affect the binding below.
  if (team && team.mode === 'subagents') captureClaimDebug(ctx.cwd, runId, 'subagent-start', raw);

  const transcriptPath = asString(raw.transcript_path ?? raw.transcriptPath);
  const threadId = asString(raw.agent_id ?? raw.agentId) || transcriptThreadId(transcriptPath);
  if (!threadId || !transcriptPath) return noop();

  if (!team || team.mode !== 'subagents') return noop();

  // SubagentStart fires in the spawner's context, so session_id is the parent id.
  const identity = hookSessionIdentity(raw);
  // Claude agent-teams declares the role on the payload (agent_type); fall back to
  // transcript inference for Codex, whose SubagentStart carries no role.
  const role = identity.declaredRole || inferRoleFromTranscript(transcriptPath);
  if (!role) return noop();

  claimThreadRole(ctx.cwd, state, threadId, role, { parentSessionId: identity.sessionId });
  return noop();
}
