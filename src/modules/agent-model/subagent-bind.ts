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
import { captureClaimDebug, claimThreadRole, hookSessionIdentity, inferRoleFromTranscript, readEffectiveState, recordRunAgent, transcriptThreadId } from '../../shared/state';
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
  if (!team || team.mode !== 'subagents') return noop();

  // SubagentStart fires in the spawner's context, so session_id is the parent id.
  const identity = hookSessionIdentity(raw);
  const transcriptPath = asString(raw.transcript_path ?? raw.transcriptPath);
  // Role: Claude declares it via agent_type, Cursor via subagent_type (both resolved
  // by hookSessionIdentity.declaredRole); Codex carries no role, so infer from the
  // child transcript when present.
  const role = identity.declaredRole || (transcriptPath ? inferRoleFromTranscript(transcriptPath) : '');
  if (!role) return noop();

  // REUSE REGISTRY (Cursor): Cursor surfaces the spawned subagent id on subagent-start
  // as `subagent_id` (= tool_<uuid>) — the PostToolUse(Task) recorder never sees it, so
  // without recording it here agents.json stays empty and every fix-cycle / follow-up
  // RE-SPAWNS the role fresh (observed 10b: backend ×3, frontend ×3 → 11 unbound pending
  // claims, stalled mid-review-fix-cycle). Record it so the spawn gate finds a live agent
  // and the orchestrator CONTINUES it (Task agentId resume) instead of re-spawning.
  // Cursor-only (gated on the subagent_id field; Claude/Codex record via the PostToolUse
  // recorder, which sees their agent_id in the tool result).
  const cursorSubagentId = asString(raw.subagent_id);
  if (cursorSubagentId && runId) {
    recordRunAgent(ctx.cwd, runId, role, {
      agentId: cursorSubagentId,
      model: asString(raw.subagent_model) || null,
      agentType: asString(raw.subagent_type) || null,
      parentSessionId: identity.sessionId,
    });
  }

  // Best-effort EARLY claim bind: needs the child's thread id (Cursor: subagent_id via
  // identity.agentId) AND its transcript to confirm the child. Skipped silently when
  // either is not available yet — resolveRunAgentContext re-attempts at the child's first
  // gated call.
  const threadId = identity.agentId || transcriptThreadId(transcriptPath);
  if (threadId && transcriptPath) {
    claimThreadRole(ctx.cwd, state, threadId, role, { parentSessionId: identity.sessionId });
  }
  return noop();
}
