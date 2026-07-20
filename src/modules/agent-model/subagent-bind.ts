// src/modules/agent-model/subagent-bind.ts
// SubagentStart handler. Best-effort EARLY bind: Codex fires no PreToolUse for
// spawns, so the agent-model gate never stakes a claim. Copilot fires SubagentStart
// with the background agent name/display name; record that immediately so later
// same-role tasks reuse the live background agent instead of respawning.

import { asString } from '../../adapters/coerce';
import { obj } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { recordMainOnboardingSession } from '../../shared/onboarding-server/onboarding-session';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import {
  captureClaimDebug,
  claimThreadRole,
  hookSessionIdentity,
  inferRoleEvidenceFromTranscript,
  readCodexSessionMetaIdentity,
  observeCodexChildModel,
  readEffectiveState,
  recordCursorSpawnObservation,
  recordRunAgent,
  transcriptThreadId,
  type RoleEvidence,
  type RoleEvidenceResolution,
} from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { modelChoiceReplyPending } from './model-choice';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';
import { settleCorrelatedCursorRetryOnStart } from './cursor-failures';
import { canonicalHost } from '../../shared/model-tiers';

function evidenceTier(evidence: RoleEvidence): number {
  if (evidence.source.startsWith('codex-session-meta-') || evidence.source.startsWith('host-')) return 1;
  if (evidence.source === 'spawn-task-name') return 2;
  if (evidence.authority === 'explicit') return 3;
  return 4;
}

function resolutionTier(resolution: RoleEvidenceResolution): number {
  if (resolution.kind === 'none') return Number.POSITIVE_INFINITY;
  const items = resolution.kind === 'evidence' ? [resolution.evidence] : resolution.candidates;
  return Math.min(...items.map(evidenceTier));
}

function combineRoleEvidence(...resolutions: RoleEvidenceResolution[]): RoleEvidenceResolution {
  const bestTier = Math.min(...resolutions.map(resolutionTier));
  if (!Number.isFinite(bestTier)) return { kind: 'none' };
  const relevant = resolutions.filter((resolution) => resolutionTier(resolution) === bestTier);
  const candidates = relevant.flatMap((resolution) => (
    resolution.kind === 'evidence' ? [resolution.evidence]
      : resolution.kind === 'conflict' ? resolution.candidates
        : []
  ));
  const roles = new Set(candidates.map((candidate) => candidate.role));
  return roles.size === 1
    ? { kind: 'evidence', evidence: candidates[0]! }
    : { kind: 'conflict', candidates };
}

export function subagentStartBind(ctx: Ctx): HookResult {
  // Cursor may fire SubagentStart from a nested package (or one of its own
  // internal working directories). Resolve the authoritative project root once
  // and use it for every state read/write below; otherwise a start event can
  // split the run across nested `.traffic-one` trees.
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (pluginUseDeclined(cwd)) return noop();

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
  const runPolicy = runId ? readRunModelPolicy(cwd, runId) : null;

  // DIAGNOSTIC (best-effort): record the raw SubagentStart payload in subagents
  // mode — captured BEFORE the field guards so we learn whether agent-teams even
  // fires SubagentStart and what identity it carries (see
  // project_agent_teams_claim_deadlock). Does NOT affect the binding below.
  if (team?.mode === 'subagents' || runPolicy) captureClaimDebug(cwd, runId, 'subagent-start', raw);
  if (team?.mode !== 'subagents' && !runPolicy) return noop();
  if (!runId || !runPolicy || runPolicy.host !== canonicalHost(ctx.host)) {
    if (ctx.host === 'cursor') {
      return deny(
        `traffic-one — Cursor child blocked: immutable model-policy.json is missing or corrupt for run ${runId || '(missing)'}. `
        + 'The child must not read the current plan, One MCP cache, or project availableModels to repair it. '
        + 'Stop this child and start a repaired parent run before respawning.',
      );
    }
    return context(
      `Traffic One blocked child activation: immutable model-policy.json is missing, corrupt, or belongs to another host for run ${runId || '(missing)'}. `
      + 'This child must not call tools. Only the parent may create the run and freeze the active host policy; stop this child and repair/respawn it from the parent.',
    );
  }

  // SubagentStart fires in the spawner's context, so session_id is the parent id.
  const identity = hookSessionIdentity(raw);
  const transcriptPath = identity.transcriptPath || '';
  const transcriptThread = transcriptThreadId(transcriptPath);
  const transcriptIsChildOwned = Boolean(
    transcriptThread && (!identity.sessionId || transcriptThread !== identity.sessionId),
  );
  // Role: Claude declares it via agent_type, Cursor via subagent_type (both resolved
  // by hookSessionIdentity.declaredRole). Cursor may also send a generic
  // subagent_type and put the real role marker in the task body. Codex identity
  // comes from exact task_name when the hook carries it or line-zero child
  // session_meta; encrypted task content is never treated as role evidence.
  const inputResolution = inferTrafficOneSpawnRoleEvidence(raw);
  // Cursor SubagentStart normally points at the parent's transcript. Never let
  // historical user records there grant the new child a role; the task body or
  // the later child-owned transcript remains available. Other hosts retain their
  // established readable-transcript compatibility.
  const mayUseTranscript = Boolean(
    transcriptPath && (ctx.host !== 'cursor' || transcriptIsChildOwned),
  );
  const codexMeta = ctx.host === 'codex' && transcriptPath
    ? readCodexSessionMetaIdentity(transcriptPath)
    : null;
  const codexIdentityMismatch = Boolean(codexMeta && (
    (codexMeta.threadId && transcriptThread && codexMeta.threadId.toLowerCase() !== transcriptThread.toLowerCase())
    || (codexMeta.threadId && identity.agentId && codexMeta.threadId.toLowerCase() !== identity.agentId.toLowerCase())
    || (codexMeta.parentThreadId && identity.sessionId && codexMeta.parentThreadId !== identity.sessionId)
  ));
  const transcriptResolution = mayUseTranscript
    ? inferRoleEvidenceFromTranscript(transcriptPath)
    : { kind: 'none' } as const;
  const resolvedEvidence = codexIdentityMismatch
    ? { kind: 'conflict', candidates: [] } as RoleEvidenceResolution
    : combineRoleEvidence(inputResolution, transcriptResolution);
  const evidence = resolvedEvidence.kind === 'evidence' ? resolvedEvidence.evidence : null;
  const role = evidence?.role || '';
  const codexChildId = ctx.host === 'codex' ? (identity.agentId || transcriptThread || '') : '';
  const codexActualModel = ctx.host === 'codex'
    ? asString(raw.model ?? payload.model).trim()
    : '';
  let codexObservation = ctx.host === 'codex' && runId && codexChildId
    ? observeCodexChildModel(cwd, runId, {
      childId: codexChildId,
      parentSessionId: parentSession,
      actualModel: codexActualModel || null,
      role: role || null,
      source: 'SubagentStart',
    })
    : null;
  if (!role) {
    // Do not silently let an unbound Traffic One child proceed toward its first
    // write. Keep this diagnostic deliberately structural/bounded: the general
    // SubagentStart capture above already truncates raw strings, while this row
    // records only the identity fields needed to diagnose attribution drift.
    // Returning context is non-blocking (SubagentStart is not a PreToolUse
    // permission event) and, critically, happens before run-id minting or any
    // claim/registry mutation below.
    const diagnosticRunId = runId;
    captureClaimDebug(cwd, diagnosticRunId, 'subagent-start-role-unresolved', {
      host: ctx.host,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      parentSessionId: identity.parentSessionId,
      threadId: identity.threadId,
      declaredRole: identity.declaredRole,
      hasTranscriptPath: Boolean(transcriptPath),
      transcriptIdentityMismatch: codexIdentityMismatch,
      taskName: asString(raw.task_name ?? raw.taskName).slice(0, 96),
      conflicts: resolvedEvidence.kind === 'conflict'
        ? resolvedEvidence.candidates.map(({ role: candidateRole, source }) => ({ role: candidateRole, source }))
        : [],
    });
    return context(
      'Traffic One could not bind this child thread to a senior role, so no per-run role claim was created. '
      + 'Do not write files from this child until the parent/orchestrator repairs the spawn. '
      + 'Parent/orchestrator: stop or replace this child and retry the same role. On Codex use the exact canonical '
      + '`task_name` contract (`senior_architect`, `senior_frontend`, `senior_backend`, `senior_reviewer`, '
      + '`senior_tester`, or `senior_shipper`), the exact role model from the immutable run policy, and '
      + '`fork_turns: "none"`. Current Codex encrypts the spawn message in the child rollout, '
      + 'so task name and line-zero `session_meta`—not prompt prose—carry identity. On hosts with readable task '
      + 'records, retain the unclaimable documentation placeholder `[t1-role: senior-<role>]` and substitute the '
      + 'actual role in the task message; marker position is not an identity requirement. Do not self-assert a role in assistant prose.',
    );
  }

  if (!runPolicy.roles[role]) {
    if (ctx.host === 'cursor') {
      return deny(
        `traffic-one — Cursor child blocked: role ${role} is absent from immutable policy ${runPolicy.policyId}. `
        + 'Stop this child and repair the parent run; do not infer a tier from current preferences.',
      );
    }
    return context(
      `Traffic One blocked child activation: role ${role} is absent from immutable policy ${runPolicy.policyId}. `
      + 'This child must not call tools; stop it and repair/respawn it from the parent.',
    );
  }

  if (ctx.host === 'codex') {
    if (!runId || !codexChildId) {
      return context(
        'Traffic One could not verify this Codex child because the parent did not create a run/model policy before spawning. '
        + 'Do not use tools in this child. Parent: stop it, reopen Performance if prompted, and respawn only after '
        + 'the current run id and model-policy.json are announced.',
      );
    }
    codexObservation = observeCodexChildModel(cwd, runId, {
      childId: codexChildId,
      parentSessionId: parentSession,
      actualModel: codexActualModel || null,
      role,
      source: 'SubagentStart',
    });
    if (!codexObservation || codexObservation.status !== 'verified') {
      return context(
        `Traffic One blocked Codex child activation for ${role}: observed model verification is `
        + `${codexObservation?.status || 'unavailable'} (${codexObservation?.reason || 'model policy missing'}). `
        + 'This SubagentStart event is non-blocking, so the child must not call tools; its first PreToolUse is denied. '
        + 'Parent: interrupt/replace this child and respawn with the canonical task_name, the exact model printed '
        + 'by the run model policy, and `fork_turns: "none"`.',
      );
    }
  }

  // Parent SessionStart owns both run-id minting and policy publication. A child
  // only consumes the already-frozen run and can never repair it from mutable
  // plan/catalog state.
  const boundRunId = runId;

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
    const rolePolicy = runPolicy?.host === 'cursor' ? runPolicy.roles[role] : null;
    const tier = rolePolicy?.tier || null;
    const expectedModel = rolePolicy?.preferredModel || null;
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
    const choicePending = modelChoiceReplyPending(cwd, stateObj);
    if (choicePending) {
      const reason = 'traffic-one — STOP: model choice required before starting the senior team. Reply `fallback` to use the listed fallback model(s), or `enable` to enable the picked model(s) and retry. Do not spawn subagents, scaffold directly, or edit project files until the user replies. This subagent must stop now and must not write files.';
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
      roleSource: evidence?.source || null,
      transcriptPath: transcriptPath || null,
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
      roleSource: evidence?.source || null,
      transcriptPath: transcriptPath || null,
    });
  }

  // Best-effort EARLY claim bind: needs the child's thread id and its own transcript
  // to confirm the child. Cursor SubagentStart reports `subagent_id=tool_<id>` plus
  // the PARENT transcript, while later child writes report the real child
  // conversation id with `transcript_path:null`; binding `tool_<id>` here creates a
  // duplicate claim the child can never resolve. For Cursor, only bind when the
  // transcript filename yields a child id distinct from the parent session; otherwise
  // resolveRunAgentContext will bind from Cursor's child transcript cache on first write.
  const threadId = ctx.host === 'cursor' ? transcriptThread : (identity.agentId || transcriptThread);
  if (threadId && transcriptPath && threadId !== identity.sessionId) {
    claimThreadRole(cwd, state, threadId, role, {
      parentSessionId: identity.sessionId,
      model: ctx.host === 'codex' ? codexObservation?.actualModel : null,
      transcriptPath,
      evidence: evidence || undefined,
      ...(ctx.host === 'codex' ? { refuseOccupiedRole: true } : {}),
    });
  }
  return noop();
}
