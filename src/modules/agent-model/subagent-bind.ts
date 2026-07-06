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
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { detectHostPlan } from '../../shared/host-plan';
import { cursorModelsFresh } from '../../shared/materialize/cursor-models';
import { recordMainOnboardingSession } from '../../shared/onboarding-server/onboarding-session';
import { captureClaimDebug, claimThreadRole, hookSessionIdentity, inferRoleFromTranscript, readEffectiveState, recordRunAgent, transcriptThreadId } from '../../shared/state';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import { modelChoiceReplyPending } from './model-choice';
import { inferTrafficOneSpawnRole } from './role-infer';

export function subagentStartBind(ctx: Ctx): HookResult {
  if (authChoiceAllowsContinue(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};

  // Record the PARENT (orchestrator) session as a known MAIN onboarding session. subagentStart
  // fires in the spawner's context (its session_id / parent_conversation_id IS the orchestrator)
  // BEFORE the subagent runs, so this is the reliable anchor that lets the onboarding gate treat
  // the subagent's own (differently-id'd) events as foreign. Done EARLY, before the subagents-mode
  // guard below — an onboarding-incomplete build has no team prefs yet, but this is exactly when a
  // prematurely-spawned subagent must NOT be sent to the wizard. Root-resolved to match the gate.
  const parentSession = asString(raw.parent_conversation_id) || hookSessionIdentity(raw).sessionId;
  if (parentSession) {
    recordMainOnboardingSession(resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot }), parentSession);
  }

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
  // by hookSessionIdentity.declaredRole). Cursor may also send a generic
  // subagent_type and put the real `[t1-role: senior-x]` marker in the task body;
  // Codex carries no role, so infer from the child transcript when present.
  const taskText = asString(raw.task ?? raw.prompt ?? raw.message ?? raw.instructions ?? raw.description);
  const role = identity.declaredRole || inferTrafficOneSpawnRole({
    subagent_type: raw.subagent_type,
    subagentType: raw.subagentType,
    agent: raw.agent,
    agentName: raw.agentName,
    agent_name: raw.agent_name,
    role: raw.role,
    type: raw.type,
    prompt: taskText,
    message: raw.message,
    instructions: raw.instructions,
    description: raw.description,
  }) || (transcriptPath ? inferRoleFromTranscript(transcriptPath) : '');
  if (!role) return noop();

  if (ctx.host === 'cursor' && stateObj) {
    const captureMissing = stateObj.mode === 'new-project' && !cursorModelsFresh(ctx.cwd, detectHostPlan('cursor'));
    const choicePending = modelChoiceReplyPending(ctx.cwd, stateObj);
    if (captureMissing || choicePending) {
      const reason = captureMissing
        ? 'traffic-one — STOP: Cursor model capture is required before starting the senior team. Write `.traffic-one/cursor-models.json`, then rerun model-gate. This subagent must stop now and must not write files.'
        : 'traffic-one — STOP: model choice required before starting the senior team. Reply `fallback` to use the listed fallback model(s), or `enable` to enable the picked model(s) and retry. Do not spawn subagents, scaffold directly, or edit project files until the user replies. This subagent must stop now and must not write files.';
      return deny(`${reason}\nBlocked role: ${role}.`, {
        agentMessage: `${reason} Blocked role: ${role}.`,
      });
    }
  }

  // REUSE REGISTRY (Cursor): Cursor surfaces the spawned subagent id on subagent-start
  // as `subagent_id` (= tool_<uuid>) — the PostToolUse(Task) recorder never sees it, so
  // without recording it here agents.json stays empty and every fix-cycle / follow-up
  // RE-SPAWNS the role fresh (observed 10b: backend ×3, frontend ×3 → 11 unbound pending
  // claims, stalled mid-review-fix-cycle). Record it so the spawn gate finds a live agent
  // and the orchestrator CONTINUES it (Task resume continuation) instead of re-spawning.
  // Cursor-only (gated on the subagent_id field; Claude/Codex record via the PostToolUse
  // recorder, which sees their agent_id in the tool result).
  const cursorSubagentId = asString(raw.subagent_id);
  if (cursorSubagentId && runId) {
    recordRunAgent(ctx.cwd, runId, role, {
      agentId: cursorSubagentId,
      toolCallId: cursorSubagentId,
      model: asString(raw.subagent_model) || null,
      agentType: asString(raw.subagent_type) || null,
      parentSessionId: identity.sessionId,
    });
  }

  // Best-effort EARLY claim bind: needs the child's thread id and its own transcript
  // to confirm the child. Cursor SubagentStart reports `subagent_id=tool_<id>` plus
  // the PARENT transcript, while later child writes report the real child
  // conversation id with `transcript_path:null`; binding `tool_<id>` here creates a
  // duplicate claim the child can never resolve. For Cursor, only bind when the
  // transcript filename yields a child id distinct from the parent session; otherwise
  // resolveRunAgentContext will bind from Cursor's child transcript cache on first write.
  const transcriptThread = transcriptThreadId(transcriptPath);
  const threadId = ctx.host === 'cursor' ? transcriptThread : (identity.agentId || transcriptThread);
  if (threadId && transcriptPath && threadId !== identity.sessionId) {
    claimThreadRole(ctx.cwd, state, threadId, role, { parentSessionId: identity.sessionId });
  }
  return noop();
}
