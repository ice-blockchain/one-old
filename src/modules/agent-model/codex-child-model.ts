import { asString } from '../../adapters/coerce';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { obj } from '../../shared/obj';
import {
  claimThreadRole,
  correctCodexChildObservationRole,
  hookSessionIdentity,
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
  const evidence = metaRole || rawRoleEvidence;
  const looksLikeChild = Boolean(observation || metaRole || isSubagentThread(raw));
  if (!looksLikeChild) return noop();

  const hookChildId = identity.agentId || identity.threadId || transcriptId || '';
  const hookParentId = identity.parentSessionId
    || (identity.sessionId && identity.sessionId !== hookChildId ? identity.sessionId : null);
  if ((meta?.threadId && hookChildId && meta.threadId.toLowerCase() !== hookChildId.toLowerCase())
    || (meta?.parentThreadId && hookParentId && meta.parentThreadId !== hookParentId)
    || (observation?.childId && hookChildId && observation.childId.toLowerCase() !== hookChildId.toLowerCase())
    || (observation?.parentSessionId && hookParentId && observation.parentSessionId !== hookParentId)) {
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
  const role = metaRole?.role || observation?.role || rawRoleEvidence?.role || '';
  if (!role) {
    return deny('traffic-one — Codex child blocked: its senior role is not yet observable from SubagentStart or line-zero session metadata. Stop this child and respawn with the canonical task_name, the exact role model from the immutable run policy, and fork_turns: "none".');
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
    return deny(
      `traffic-one — Codex child blocked: observed model status is ${updated?.status || 'unavailable'} `
      + `(${updated?.reason || 'run model policy missing'}). Parent: interrupt/replace this child and respawn `
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
