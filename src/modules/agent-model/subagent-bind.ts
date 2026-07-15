// src/modules/agent-model/subagent-bind.ts
// SubagentStart handler. Best-effort EARLY bind: Codex fires no PreToolUse for
// spawns, so the agent-model gate never stakes a claim. Copilot fires SubagentStart
// with the background agent name/display name; record that immediately so later
// same-role tasks reuse the live background agent instead of respawning.

import { asString } from '../../adapters/coerce';
import { obj } from '../../shared/obj';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { detectHostPlan } from '../../shared/host-plan';
import { cursorModelsFresh } from '../../shared/materialize/cursor-models';
import { effectiveTierForRole, modelForRoleHost } from '../../shared/performance';
import { recordMainOnboardingSession } from '../../shared/onboarding-server/onboarding-session';
import { captureClaimDebug, claimThreadRole, ensureCurrentRunId, hookSessionIdentity, inferRoleFromTranscript, readEffectiveState, recordCursorSpawnObservation, recordRunAgent, transcriptThreadId } from '../../shared/state';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { modelChoiceReplyPending } from './model-choice';
import { inferTrafficOneSpawnRole } from './role-infer';
import { settleCorrelatedCursorRetryOnStart } from './cursor-failures';

export function subagentStartBind(ctx: Ctx): HookResult {
  // Cursor may fire SubagentStart from a nested package (or one of its own
  // internal working directories). Resolve the authoritative project root once
  // and use it for every state read/write below; otherwise a start event can
  // split the run across nested `.traffic-one` trees.
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (authChoiceAllowsContinue(cwd) || pluginUseDeclined(cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const payload = obj(raw.payload) || {};

  // Record the PARENT (orchestrator) session as a known MAIN onboarding session. subagentStart
  // fires in the spawner's context (its session_id / parent_conversation_id IS the orchestrator)
  // BEFORE the subagent runs, so this is the reliable anchor that lets the onboarding gate treat
  // the subagent's own (differently-id'd) events as foreign. Done EARLY, before the subagents-mode
  // guard below — an onboarding-incomplete build has no team prefs yet, but this is exactly when a
  // prematurely-spawned subagent must NOT be sent to the wizard. Root-resolved to match the gate.
  const parentSession = asString(
    raw.parent_conversation_id
    ?? raw.parentConversationId
    ?? payload.parent_conversation_id
    ?? payload.parentConversationId,
  ) || hookSessionIdentity(raw).sessionId;
  if (parentSession) {
    recordMainOnboardingSession(cwd, parentSession);
  }

  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const team = obj(obj(state)?.team);
  const stateObj = obj(state);
  const runId = stateObj && typeof stateObj.currentRunId === 'string' ? stateObj.currentRunId : null;

  // DIAGNOSTIC (best-effort): record the raw SubagentStart payload in subagents
  // mode — captured BEFORE the field guards so we learn whether agent-teams even
  // fires SubagentStart and what identity it carries (see
  // project_agent_teams_claim_deadlock). Does NOT affect the binding below.
  if (team && team.mode === 'subagents') captureClaimDebug(cwd, runId, 'subagent-start', raw);
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
    agent_type: raw.agent_type,
    agentType: raw.agentType,
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

  // PERSISTING RUN-ID MINT: Codex fires no PreToolUse for spawns, so the
  // ensureCurrentRunId self-heal inside agentModelGate never runs there —
  // SubagentStart is that host's spawn signal. Without this, an existing-codebase
  // Codex build finishes setup with NO currentRunId in project state, and the
  // run-team write gate denies the architect's first coordination write
  // (run-team-not-subagent) against a run id that was never persisted.
  // Idempotent everywhere else (returns the existing id unchanged).
  const boundRunId = runId || ensureCurrentRunId(cwd, state);

  // REUSE REGISTRY (Cursor): Cursor surfaces the spawned subagent id on subagent-start
  // as `subagent_id` (= tool_<uuid>) — the PostToolUse(Task) recorder never sees it, so
  // without recording it here agents.json stays empty and every fix-cycle / follow-up
  // RE-SPAWNS the role fresh (observed 10b: backend ×3, frontend ×3 → 11 unbound pending
  // claims, stalled mid-review-fix-cycle). Record it so the spawn gate finds a live agent
  // and the orchestrator CONTINUES it (Task resume continuation) instead of re-spawning.
  // Cursor-only (gated on the subagent_id field; Claude/Codex record via the PostToolUse
  // recorder, which sees their agent_id in the tool result).
  const cursorSubagentId = asString(raw.subagent_id);
  if (ctx.host === 'cursor' && cursorSubagentId && boundRunId) {
    const level = typeof stateObj?.performance === 'object'
      && stateObj.performance !== null
      && typeof (stateObj.performance as Record<string, unknown>).level === 'string'
      ? String((stateObj.performance as Record<string, unknown>).level)
      : '';
    const overrides = team && obj(team.overrides) ? team.overrides as Record<string, unknown> : null;
    const planCtx = { host: 'cursor', plan: detectHostPlan('cursor') };
    const tier = effectiveTierForRole(level, role, overrides, planCtx);
    const expectedModel = modelForRoleHost(level, role, 'cursor', overrides, planCtx);
    const requestedModel = asString(raw.subagent_model ?? raw.subagentModel ?? raw.model);
    const rawStartedAt = raw.started_at ?? raw.startedAt ?? raw.timestamp ?? raw.created_at ?? raw.createdAt;
    const parsedStartedAt = typeof rawStartedAt === 'number' && Number.isFinite(rawStartedAt)
      ? (rawStartedAt < 1_000_000_000_000 ? rawStartedAt * 1000 : rawStartedAt)
      : Date.parse(asString(rawStartedAt));

    // Immutable spawn evidence survives even when the child fails before Cursor
    // emits postToolUse/subagentStop and the live-agent registry is later retired.
    // Task attempts denied in preToolUse never reach SubagentStart, so they create
    // no observation and cannot be mistaken for a model that actually ran.
    let recordedCursorStart = false;
    if (tier && expectedModel && requestedModel && parentSession) {
      recordedCursorStart = Boolean(recordCursorSpawnObservation(cwd, boundRunId, {
        parentSessionId: parentSession,
        toolCallId: cursorSubagentId,
        role,
        requestedModel,
        tier,
        expectedModel,
        ...(Number.isFinite(parsedStartedAt) ? { startedAtMs: parsedStartedAt } : {}),
      }));
    }
    if (recordedCursorStart && requestedModel && parentSession) {
      settleCorrelatedCursorRetryOnStart(cwd, boundRunId, {
        parentSessionId: parentSession,
        role,
        startedToolCallId: cursorSubagentId,
        startedModel: requestedModel,
      });
    }
  }

  if (ctx.host === 'cursor' && stateObj) {
    const captureMissing = stateObj.mode === 'new-project' && !cursorModelsFresh(cwd, detectHostPlan('cursor'));
    const choicePending = modelChoiceReplyPending(cwd, stateObj);
    if (captureMissing || choicePending) {
      const reason = captureMissing
        ? 'traffic-one — STOP: Cursor model capture is required before starting the senior team. Run the internal model-gate `--capture-models` command with the exact offered ids, then rerun model-gate. This subagent must stop now and must not write files.'
        : 'traffic-one — STOP: model choice required before starting the senior team. Reply `fallback` to use the listed fallback model(s), or `enable` to enable the picked model(s) and retry. Do not spawn subagents, scaffold directly, or edit project files until the user replies. This subagent must stop now and must not write files.';
      return deny(`${reason}\nBlocked role: ${role}.`, {
        agentMessage: `${reason} Blocked role: ${role}.`,
      });
    }
  }

  // Keep the immutable start observation above even when the already-started
  // child must be stopped for a pending choice. The reusable live-agent slot,
  // however, is written only after that guard passes; a denied child must not
  // block the replacement as falsely live.
  if (ctx.host === 'cursor' && cursorSubagentId && boundRunId) {
    recordRunAgent(cwd, boundRunId, role, {
      agentId: cursorSubagentId,
      toolCallId: cursorSubagentId,
      model: asString(raw.subagent_model ?? raw.subagentModel ?? raw.model) || null,
      agentType: asString(raw.subagent_type) || null,
      parentSessionId: parentSession,
    });
  }

  const copilotAgentId = ctx.host === 'copilot'
    ? asString(raw.agent_id ?? raw.agentId ?? raw.agentDisplayName ?? raw.agent_display_name ?? raw.name)
    : '';
  if (copilotAgentId && boundRunId) {
    recordRunAgent(cwd, boundRunId, role, {
      agentId: copilotAgentId,
      resumeId: copilotAgentId,
      model: asString(raw.model) || null,
      agentType: asString(raw.agentName ?? raw.agent_name ?? raw.agent_type ?? raw.agentType) || null,
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
    claimThreadRole(cwd, state, threadId, role, { parentSessionId: identity.sessionId });
  }
  return noop();
}
