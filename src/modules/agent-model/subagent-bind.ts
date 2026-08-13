// src/modules/agent-model/subagent-bind.ts
// SubagentStart handler. Best-effort EARLY bind: Codex fires no PreToolUse for
// spawns, so the agent-model gate never stakes a claim. Copilot fires SubagentStart
// with the background agent name/display name; record that immediately so later
// same-role tasks reuse the live background agent instead of respawning.

import { asString } from '../../adapters/coerce';
import { obj } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook/paths';
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
  normalizeHostCallId,
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
import { isNonProjectRoot } from '../../shared/authoring-root';

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
  // SubagentStart is lifecycle-only and has no target path. The plugin source
  // and installed plugin trees are not Traffic One projects, so do not record a
  // parent session or require a model policy there.
  if (isNonProjectRoot(cwd)) return noop();
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
        { denyId: 'subagent-bind-cursor-policy-missing', denyTarget: runId || undefined },
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
  // session_meta; when the spawn omitted task_name (schema-variant spawn tools),
  // the plaintext spawn prompt in the child rollout carries the `[t1-role: …]`
  // marker and the transcript inference below recovers it (or the first
  // PreToolUse does, once the record has landed).
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
  // Codex reports the ROOT conversation as session_id for EVERY child while
  // line-zero `parent_thread_id` names the IMMEDIATE parent — for a depth-2
  // spawn (a senior child spawning a same-role replacement sibling) the two are
  // different TRUE statements, not an identity mismatch (observed 9c-codex: the
  // frontend-spawned backend replacement failed role binding here). A parent
  // contradiction exists only when the hook EXPLICITLY names a parent that is
  // neither the line-zero immediate parent nor the root session.
  const codexIdentityMismatch = Boolean(codexMeta && (
    (codexMeta.threadId && transcriptThread && codexMeta.threadId.toLowerCase() !== transcriptThread.toLowerCase())
    || (codexMeta.threadId && identity.agentId && codexMeta.threadId.toLowerCase() !== identity.agentId.toLowerCase())
    || (codexMeta.parentThreadId && identity.parentSessionId
      && codexMeta.parentThreadId !== identity.parentSessionId
      && identity.parentSessionId !== identity.sessionId)
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
  // Observation parent: line-zero's immediate parent when readable; otherwise
  // NOTHING. Recording the SubagentStart-time guess (the hook's root session)
  // made the first PreToolUse — which reads the line-zero parent — a terminal
  // `parent-session-conflict` for every depth-2 replacement (observed 9c-codex).
  const codexObservedParent = codexMeta?.parentThreadId || null;
  let codexObservation = ctx.host === 'codex' && runId && codexChildId
    ? observeCodexChildModel(cwd, runId, {
      childId: codexChildId,
      parentSessionId: codexObservedParent,
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
      + '`task_name` contract (`quick_fix`, `senior_architect`, `senior_frontend`, `senior_backend`, `senior_reviewer`, '
      + '`senior_tester`, or `senior_shipper`), the exact role model from the immutable run policy, and '
      + '`fork_turns: "none"`. If the exposed spawn tool has NO task_name field, the FIRST line of the spawn '
      + 'message must carry the literal role marker `[t1-role: senior-<role>]` (with the actual role substituted) — '
      + 'the child rollout records the spawn prompt readably and the write gate recovers the role from it. '
      + 'This binding may also complete on the child\'s first tool call once the spawn prompt lands in its '
      + 'rollout. Do not self-assert a role in assistant prose.',
    );
  }

  if (!runPolicy.roles[role]) {
    if (ctx.host === 'cursor') {
      return deny(
        `traffic-one — Cursor child blocked: role ${role} is absent from immutable policy ${runPolicy.policyId}. `
        + 'Stop this child and repair the parent run; do not infer a tier from current preferences.',
        { denyId: 'subagent-bind-cursor-role-missing', denyTarget: role },
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
      parentSessionId: codexObservedParent,
      actualModel: codexActualModel || null,
      role,
      source: 'SubagentStart',
    });
    // Three different answers used to render as one destroy instruction, and only
    // one of them is a breach. By this line `runId`, `runPolicy`, its host, the
    // child id and the role are all established, which are every OTHER null path
    // observeCodexChildModel has — so a MISSING record can only be its store's own
    // lock or write failing, and the old text guessed "model policy missing" at it.
    // `pending-role` is not a verdict either: it means the model is not observable
    // YET, and the child's own first PreToolUse observes it and verifies it against
    // the same frozen policy. Only mismatch/conflict retire the thread.
    if (!codexObservation || codexObservation.status !== 'verified') {
      if (!codexObservation) {
        return context(
          `Traffic One could not record this Codex child's observed model for ${role}: the run's `
          + 'model-observation store was unavailable — a concurrent hook holds its lock, or the write was '
          + `refused. This is NOT a policy or identity failure: run ${runId}'s immutable policy `
          + `${runPolicy.policyId} is readable, names host codex, and lists this role. The child's own first `
          + 'tool call re-observes the same model and verifies it there. Do NOT interrupt or replace this child '
          + 'on this message; if its first tool call is denied for the same reason, replace it then.',
        );
      }
      if (codexObservation.status === 'pending-role') {
        return context(
          `Traffic One has not finished verifying this Codex child for ${role}: its observed-model record is `
          + `\`pending-role\` (${codexObservation.reason || 'model not observed yet'}). SubagentStart does not `
          + 'always carry the child\'s model, so this is "not known yet", not a breach — the child\'s first tool '
          + 'call observes the model and verifies it against the immutable run policy before anything else runs, '
          + 'and is denied if it does not match. Parent: let this child take that first turn; replace it only on a '
          + 'mismatch/conflict verdict from it.',
        );
      }
      return context(
        `Traffic One blocked Codex child activation for ${role}: observed model verification is `
        + `${codexObservation.status} (${codexObservation.reason || 'unknown'}). `
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
  // Normalize at the SOURCE. Cursor 3.12.30 leaks an HTTP chunk-length line into this
  // id ("16\\nfc_…"), and this ONE value is written to TWO stores below
  // (cursor-spawns.json via recordCursorSpawnObservation, agents.json via
  // recordRunAgent). Normalizing only on the read side made those stores DIVERGE — the
  // spawn ledger held the clean id while the agent registry held the raw one — which
  // breaks every cross-store comparison (live-agent match, replace-if-matches retirement,
  // PostToolUse result correlation, lifecycle followup targeting). One normalization here
  // keeps both stores byte-identical, whichever spelling the host sent.
  const cursorSubagentId = normalizeHostCallId(raw.subagent_id);
  // Set when the spawn ledger was ASKED for a row and could not give one. Read
  // at the single exit below, not returned from here: the model-choice deny and
  // the reuse-registry/claim writes underneath this block all still have to
  // happen, and an early return would skip them to report a ledger gap.
  let cursorStartUnrecorded = false;
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
    // A REFUSAL THAT NOBODY HEARS. `recordCursorSpawnObservation` answers null
    // when it never got `.cursor-spawns.lock` inside CURSOR_SPAWN_LOCK_TIMEOUT_MS
    // (2 s), and until this branch existed that answer went nowhere: the hook
    // wrote no row, told no one, and returned noop() — the run proceeded on a
    // ledger that is missing this spawn, and reported success doing it.
    //
    // The gap is PERMANENT and this is the only place that can report it. This
    // call site is the ledger's sole minter; the postToolUse path
    // (persistCorrelatedCursorPostToolFailure) starts from
    // correlatedPostToolObservation, which READS the ledger and returns null when
    // the row is absent, and the reset's carry only copies rows that exist. So
    // nothing later re-mints it, and everything the row feeds is dead for this
    // child: no transcript claim, so no terminal classification; no directive, so
    // no fallback follow-up; no recordExhaustedModel, so modelExhaustionTerminal-
    // ForRole never trips and a respawn on the same API-limited model is never
    // denied; and unavailableModelsForRun/rolesAwaitingModelChoice under-count,
    // so siblings keep spawning on a slug already known to be gone.
    //
    // Non-blocking `context`, deliberately, and it is the SAME answer the Codex
    // model-observation store above gives for the same shape of failure ("a
    // concurrent hook holds its lock, or the write was refused"). This is not a
    // policy or identity breach — the child is bound and running correctly, and
    // denying it would destroy a healthy spawn over a transient store. What the
    // orchestrator loses is Traffic One's failure recovery for THIS child, so
    // what it is told is to own that recovery itself.
    //
    // Not retried here and not waited on: the caller has already spent the whole
    // 2 s budget, and a second attempt just moves the same cliff further out
    // while holding a spawn hook open. Measured — 0 refusals in 562
    // barrier-synchronised writer attempts from 2- to 64-way contention, worst
    // single acquisition 1851 ms at 32 writers — so reaching this branch
    // takes a holder that WEDGES, not a queue that is long, and the bound is what
    // keeps a wedged holder from hanging the spawn instead.
    if (!recordedCursorStart && tier && expectedModel && requestedModel && parentSession) {
      cursorStartUnrecorded = true;
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
        denyId: 'subagent-bind-model-choice-pending',
        denyTarget: role,
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
      // Cursor's SubagentStart transcript is the PARENT rollout (see the
      // `mayUseTranscript` note above), so recording it as the CHILD agent's
      // transcript is wrong data — and it re-clobbered the real child path on
      // every continuation. Let the child-owned path recorded by `claimThreadRole`
      // stand instead.
      transcriptPath: transcriptIsChildOwned ? (transcriptPath || null) : null,
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
  if (cursorStartUnrecorded) {
    return context(
      `Traffic One could not record the spawn observation for ${role} in run ${boundRunId}: the run's Cursor `
      + 'spawn ledger was unavailable — a concurrent hook held its lock for the full acquisition budget, or the '
      + 'write was refused. This is NOT a policy or identity failure and this child is correctly bound: it is '
      + 'running, its role claim and reuse-registry entry are recorded, and it must keep working. '
      + 'What is missing is this run\'s immutable record of the spawn, and nothing re-creates it later. So if THIS '
      + 'child dies, Traffic One cannot correlate its transcript, will not classify an API limit or an unavailable '
      + 'model, will not emit a fallback/retry directive for it, and will not block a respawn on the same model. '
      + 'Parent/orchestrator: handle a failure of this child yourself — read its error, and choose the retry model '
      + 'from the immutable run policy rather than waiting for a Traffic One prescription that will not arrive. '
      + 'Sibling roles are unaffected.',
    );
  }
  return noop();
}
