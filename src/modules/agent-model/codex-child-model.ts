import { asString } from '../../adapters/coerce';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { obj } from '../../shared/obj';
import {
  claimThreadRole,
  correctCodexChildObservationRole,
  disownConflictedRoleAgent,
  hookSessionIdentity,
  inferRoleEvidenceFromTranscript,
  isSubagentThread,
  observeCodexChildModel,
  readCodexModelObservation,
  readCodexSessionMetaIdentity,
  readEffectiveState,
  resolveRunAgentContext,
  transcriptThreadId,
} from '../../shared/state';
import { canonicalHost } from '../../shared/model-tiers';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

// Blocking half of Codex child activation. SubagentStart records the immutable
// model but cannot deny execution; every child tool reaches this guard before
// the normal auth/onboarding/model pipelines.
export function codexChildModelGate(ctx: Ctx): HookResult {
  const cwd = resolveProjectRoot(ctx.cwd, ctx.input.tool?.filePath, { ceiling: ctx.input.workspaceRoot });
  const raw = obj(ctx.input.raw) || {};
  const payload = obj(raw.payload) || {};
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  const identity = hookSessionIdentity(raw);

  // Every recognized Traffic One child, not only Codex/Cursor, is pinned to the
  // parent-created snapshot. Main-agent projects and unrelated host workers
  // remain unaffected.
  if (ctx.host !== 'codex') {
    const team = obj(state.team);
    if (team?.mode !== 'subagents') return noop();
    const claimed = resolveRunAgentContext(cwd, state, raw, {
      claimPending: false,
      host: ctx.host,
    });
    if (!isSubagentThread(raw) && !claimed) return noop();
    const policy = runId ? readRunModelPolicy(cwd, runId) : null;
    const activeHost = canonicalHost(ctx.host);
    if (!runId || !policy || policy.host !== activeHost) {
      return deny(
        `traffic-one — child blocked: immutable model-policy.json is missing, corrupt, or belongs to another host for run ${runId || '(missing)'}. `
        + 'Only the parent may create the run and freeze the policy; stop this child and repair/respawn it from the parent.',
      );
    }
    return noop();
  }

  const transcriptPath = identity.transcriptPath || '';
  const transcriptId = transcriptThreadId(transcriptPath);
  const candidateIds = unique([identity.agentId, identity.threadId, transcriptId, identity.sessionId]);
  let observation = runId ? readCodexModelObservation(cwd, runId, candidateIds) : null;
  const meta = transcriptPath ? readCodexSessionMetaIdentity(transcriptPath) : null;
  const metaRole = meta?.role.kind === 'evidence' ? meta.role.evidence : null;
  const rawRole = inferTrafficOneSpawnRoleEvidence(raw);
  const rawRoleEvidence = rawRole.kind === 'evidence' ? rawRole.evidence : null;
  // Spawn issued without task_name: line-zero session_meta then carries no role,
  // but the plaintext spawn prompt (first user record, `[t1-role: …]` marker)
  // does. The SubagentStart-time read can race that record landing in the
  // rollout; by the first PreToolUse it is durably present — recover it here
  // instead of retiring the child as role-less (observed 13c-codex: the
  // architect looped on "role not observable" and the run stalled at Phase 1).
  const transcriptRoleResolution = !metaRole && !observation?.role && !rawRoleEvidence && transcriptPath
    ? inferRoleEvidenceFromTranscript(transcriptPath)
    : { kind: 'none' } as const;
  const transcriptRole = transcriptRoleResolution.kind === 'evidence' ? transcriptRoleResolution.evidence : null;
  const evidence = metaRole || rawRoleEvidence || transcriptRole;
  const looksLikeChild = Boolean(observation || metaRole || isSubagentThread(raw));
  if (!looksLikeChild) return noop();

  const hookChildId = identity.agentId || identity.threadId || transcriptId || '';
  const hookParentId = identity.parentSessionId
    || (identity.sessionId && identity.sessionId !== hookChildId ? identity.sessionId : null);
  // Codex hooks report the ROOT conversation as session_id for EVERY child, at
  // any depth, while line-zero `parent_thread_id` names the IMMEDIATE parent.
  // For a depth-2 spawn (a senior child spawning a replacement sibling) the two
  // are different TRUE statements, not a contradiction — comparing them raw
  // stranded every architect-spawned replacement (observed 8c-codex). A parent
  // claim is only contradictory when the hook names a parent that is neither
  // the line-zero immediate parent nor the root session it runs under.
  const hookParentIsRootSession = Boolean(hookParentId && identity.sessionId && hookParentId === identity.sessionId);
  if ((meta?.threadId && hookChildId && meta.threadId.toLowerCase() !== hookChildId.toLowerCase())
    || (meta?.parentThreadId && hookParentId && meta.parentThreadId !== hookParentId && !hookParentIsRootSession)
    || (observation?.childId && hookChildId && observation.childId.toLowerCase() !== hookChildId.toLowerCase())
    || (observation?.parentSessionId && hookParentId && observation.parentSessionId !== hookParentId && !hookParentIsRootSession)) {
    return deny(
      'traffic-one — Codex child blocked: hook, line-zero session metadata, and persisted model observation '
      + 'do not identify the same child/parent pair. Stop this child; the parent must respawn it.',
    );
  }

  if (!runId) {
    return deny('traffic-one — Codex child blocked: currentRunId/model-policy.json is missing. The parent must create the run policy before spawning; this child may not repair or replace it.');
  }
  const childId = observation?.childId || hookChildId;
  if (!childId) {
    return deny('traffic-one — Codex child blocked: the hook exposed no stable child id, so its observed model cannot be bound safely. Stop this child and respawn from the parent.');
  }
  // A SubagentStart task_name can arrive before the child rollout exposes its
  // authoritative line-zero agent_path. If that provisional role made the
  // immutable model look wrong, re-evaluate the *same* observed model once the
  // authoritative role appears. Conflict is terminal inside the observation
  // store, so stale/different-model evidence still cannot heal a rejected child.
  if (runId && observation && metaRole && observation.role !== metaRole.role) {
    observation = correctCodexChildObservationRole(
      cwd,
      runId,
      observation.childId,
      metaRole.role,
    ) || observation;
  }
  const role = metaRole?.role || observation?.role || rawRoleEvidence?.role || transcriptRole?.role || '';
  if (!role) {
    return deny(
      'traffic-one — Codex child blocked: its senior role is not observable from SubagentStart, line-zero session '
      + 'metadata, or the spawn prompt. Stop this child and respawn with the canonical task_name, the exact role '
      + 'model from the immutable run policy, and fork_turns: "none". If this host\'s spawn tool exposes no '
      + 'task_name field, the FIRST line of the spawn message must carry the literal role marker '
      + '`[t1-role: senior-<role>]` instead.',
    );
  }
  const actualModel = asString(raw.model ?? payload.model).trim() || observation?.actualModel || '';
  const updated = observeCodexChildModel(cwd, runId, {
    childId,
    parentSessionId: meta?.parentThreadId || hookParentId,
    actualModel: actualModel || null,
    role,
    source: 'PreToolUse',
  });
  if (!updated || updated.status !== 'verified' || !updated.actualModel) {
    const status = updated?.status || 'unavailable';
    const reason = updated?.reason || 'run model policy missing';
    // conflict/mismatch is terminal for THIS thread: every later call stays
    // denied, so durably disown its role slot in the reuse registry. Without
    // that marker no replacement could ever bind on Codex — the fresh verified
    // child was refused as a duplicate of the dead incumbent (observed
    // 8c-codex: followup turns silently ran on the parent's model, and the
    // stranded role forced the run into Low/main-agent fallback).
    if (status === 'conflict' || status === 'mismatch') {
      const released = role
        ? disownConflictedRoleAgent(cwd, runId, role, [childId, ...candidateIds], reason)
        : false;
      return deny(
        `traffic-one — Codex child blocked: observed model status is ${status} (${reason}). `
        + `This thread is retired — every later call stays blocked${released ? ', and its role slot is now released for ONE replacement' : ''}. `
        + 'ROOT orchestrator: spawn a FRESH child for this role with the canonical task_name, fork_turns "none", and '
        + 'the exact model from .traffic-one/runs/<runId>/model-policy.json. Do NOT follow-up or interrupt-respawn '
        + "this same retired thread — the host can silently reattach it (follow-up turns may run on the parent's "
        + 'model). Do NOT spawn the replacement nested from another senior child either: the host attributes a '
        + "nested child's edits to the SPAWNING child, so it can never own this role's disjoint files (its writes "
        + 'are denied). Only the root parent respawns senior roles.',
      );
    }
    return deny(
      `traffic-one — Codex child blocked: observed model status is ${status} `
      + `(${reason}). Parent: interrupt/replace this child and respawn `
      + 'with the exact model in .traffic-one/runs/<runId>/model-policy.json.',
    );
  }

  // Create the role claim/reuse row only after the actual hook model has passed
  // the immutable policy. Requested spawn input is never authoritative.
  const claimed = claimThreadRole(cwd, state, childId, role, {
    parentSessionId: updated.parentSessionId,
    model: updated.actualModel,
    transcriptPath: transcriptPath || null,
    evidence: evidence || undefined,
    refuseOccupiedRole: true,
  });
  if (!claimed) {
    return deny('traffic-one — Codex child blocked: model verification passed but the verified role claim could not be persisted atomically. Retry this tool once; if it repeats, replace the child from the parent.');
  }
  return noop();
}
