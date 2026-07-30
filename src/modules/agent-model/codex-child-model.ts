import { asString } from '../../adapters/coerce';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { obj } from '../../shared/obj';
import {
  REPLACE_AGENT_MARKER,
  activeClaimForOtherThread,
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
  readRunAgentRegistry,
  resolveRunAgentContext,
  runLedgerAdmitsClaims,
  runLedgerStatusRecord,
  transcriptThreadId,
} from '../../shared/state';
import { canonicalHost } from '../../shared/model-tiers';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import { readActiveRunBootstrap } from '../../shared/run-bootstrap-policy';
import { ensureRunHostCapability } from '../../shared/host/capabilities';
import { resolveToolScope } from '../../shared/tool-scope';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

// Blocking half of Codex child activation. SubagentStart records the immutable
// model but cannot deny execution; every child tool reaches this guard before
// the normal auth/onboarding/model pipelines.
export function codexChildModelGate(ctx: Ctx): HookResult {
  // Stand down before any project-state/model-policy read. This is what keeps a
  // read-only child inside the Traffic One source repo from becoming inert.
  // resolveToolScope also inspects explicit targets/workdirs/commands, so a call that
  // starts here but targets a real project does not inherit this exemption.
  const scope = resolveToolScope(ctx);
  if (scope.standsDown) return noop();
  const cwd = scope.projectRoot;
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
    let claimedRole = typeof claimed?.role === 'string' ? claimed.role : '';
    if (!claimedRole) {
      // Deadlock break. The role-keyed reuse registry (agents.json) and this
      // gate are both runtime-owned and could contradict each other: the reuse
      // gate refuses a replacement spawn because the registry names this child
      // as the role's LIVE agent, while this gate demands exactly that respawn
      // because the child carries no claim. A child spawned before its
      // bootstrap envelope existed lands in that state permanently — observed
      // live: nine consecutive identical denials across Read and Bash (a bare
      // `pwd` included), unaffected by re-announcement, and the follow-up
      // feature could never start.
      //
      // The registry entry IS parent-issued evidence: only the parent's spawn
      // recorder writes it, and it is parent-session-bound. When it names this
      // exact child for a role whose bootstrap is published and policy-valid,
      // adopt the binding instead of denying. Fail-closed everywhere else —
      // no registry row, or a bootstrap that does not verify below, still
      // denies.
      const childIds = unique([identity.agentId, identity.sessionId, identity.threadId, transcriptThreadId(identity.transcriptPath || '')]);
      const registry = readRunAgentRegistry(cwd, runId);
      const registered = Object.entries(registry).find(([, entry]) => (
        !entry.replaced
        && childIds.some((id) => id === entry.agentId || id === entry.resumeId)
      ));
      const adoptId = registered ? childIds.find((id) => id === registered[1].agentId || id === registered[1].resumeId) : null;
      if (registered && adoptId) {
        claimedRole = registered[0];
        claimThreadRole(cwd, state, adoptId, claimedRole, {
          parentSessionId: registered[1].parentSessionId || identity.parentSessionId,
          recordAgent: false,
          model: registered[1].model,
          transcriptPath: identity.transcriptPath,
          refuseOccupiedRole: false,
        });
      } else {
        return deny(
          'traffic-one — child blocked: no parent-resolved trafficOneRole is bound to this child. '
          + 'Stop it and respawn from the parent after the role bootstrap is published.',
        );
      }
    }
    const bootstrap = readActiveRunBootstrap(cwd, runId, claimedRole);
    if (
      !bootstrap
      || bootstrap.modelPolicyId !== policy.policyId
      || bootstrap.host !== activeHost
      || bootstrap.trafficOneRole !== claimedRole
    ) {
      return deny(
        `traffic-one — child blocked: the parent role/rule/skill bootstrap for ${claimedRole} is missing, `
        + 'corrupt, or does not match model-policy.json. This child has zero tool access; repair and respawn it.',
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
    // Name the resolved root: this deny ALSO fires when path arguments
    // re-anchored resolution outside the real project (observed 5co-codex:
    // `pnpm --filter <pkg> exec tsc ../../packages/...` resolved to an
    // ancestor directory with no run state, and the old wording — "the parent
    // must create the run policy" — read as a fatal orchestration failure and
    // was recorded as fact in the backend digest).
    return deny(
      `traffic-one — Codex child blocked: no currentRunId/model-policy.json under the resolved project root \`${cwd}\`. `
      + 'If that path is NOT the project you are building, this call re-anchored root resolution via its path arguments '
      + '(e.g. `../..` operands or an outside workdir) — re-run it with workdir set to the project root and paths inside it. '
      + 'Otherwise the parent must create the run policy before spawning; this child may not repair or replace it.',
    );
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
        + 'ROOT orchestrator: spawn a FRESH child for this role with fork_turns "none" and the exact model from '
        + '.traffic-one/runs/<runId>/model-policy.json. Do NOT follow-up or interrupt-respawn this same retired '
        + "thread — the host can silently reattach it (follow-up turns may run on the parent's model, which trips "
        + 'this exact conflict). If a plain same-name respawn keeps reattaching the retired runtime, give the '
        + `replacement a DISTINCT task_name that still names the role: \`${role.replace(/-/g, '_')}_fix_<n>\` `
        + `(e.g. \`${role.replace(/-/g, '_')}_fix_1\`) with \`[t1-role: ${role}]\` as the first message line — a `
        + 'distinct name stops the reattach and the suffix still binds to the role. Do NOT spawn the replacement '
        + 'nested from another senior '
        + "child: the host attributes a nested child's edits to the SPAWNING child, so it can never own this "
        + "role's disjoint files. Only the root parent respawns senior roles.",
      );
    }
    return deny(
      `traffic-one — Codex child blocked: observed model status is ${status} `
      + `(${reason}). Parent: interrupt/replace this child and respawn `
      + 'with the exact model in .traffic-one/runs/<runId>/model-policy.json.',
    );
  }

  const policy = readRunModelPolicy(cwd, runId);
  const bootstrap = readActiveRunBootstrap(cwd, runId, role);
  if (
    !policy
    || !bootstrap
    || bootstrap.modelPolicyId !== policy.policyId
    || bootstrap.host !== 'codex'
    || bootstrap.trafficOneRole !== role
  ) {
    return deny(
      `traffic-one — Codex child blocked: parent bootstrap for ${role} is missing, corrupt, or does not match `
      + 'the immutable run policy. This child may not read/search/write; the parent must repair and respawn it.',
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
    // Name WHY the claim failed. `claimThreadRole` collapses a closed ledger, an
    // occupied role and a lock failure into one `null`, and the single generic
    // "retry once / replace the child" message was wrong for the first two:
    // observed 10co, where a blocked run made every replacement child unclaimable
    // and the parent replaced it in a loop, each new thread hitting the same wall.
    // Probe in remedy order — closed ledger first, because it is the only cause
    // no respawn can fix.
    if (!runLedgerAdmitsClaims(cwd, runId)) {
      const ledger = runLedgerStatusRecord(cwd, runId);
      return deny(`traffic-one — Codex child blocked: the run ledger for \`${runId}\` is \`${ledger.status || 'unreadable'}\``
        + `${ledger.outcome ? ` (${ledger.outcome})` : ''}, so NO child can bind a role in it and every tool call from `
        + 'this thread stays denied. Respawning does not fix this — the run itself is closed. ROOT orchestrator: if the '
        + 'user has authorized another cycle, resume the RUN first with '
        + `\`node ~/.traffic-one/bin/run-status.cjs --run-id "${runId}" --status active --reason user-authorized-extra-cycle\`, `
        + `then confirm \`.traffic-one/runs/${runId}/settlement-v2.json\` reads \`"status": "active"\` before respawning `
        + 'this child. If it still reads `"status": "blocked"`, the resume did NOT take effect — do not spawn into this '
        + 'run; settle it and mint a new one.');
    }
    const rival = obj(activeClaimForOtherThread(cwd, state, runId, role, childId));
    if (rival) {
      return deny(`traffic-one — Codex child blocked: role \`${role}\` in run \`${runId}\` is already held by live thread `
        + `\`${String(rival.sessionId || 'unknown')}\` (claim \`${String(rival.claimId || 'unknown')}\`), and a verified `
        + 'child never displaces another live thread. Retrying this tool cannot succeed. ROOT orchestrator: keep the '
        + `incumbent and stop this duplicate, or retire the incumbent with a \`${REPLACE_AGENT_MARKER}\` spawn for `
        + `\`${role}\` and let exactly ONE replacement bind.`);
    }
    return deny(`traffic-one — Codex child blocked: model verification passed but the verified role claim could not be `
      + `persisted atomically. The run ledger for \`${runId}\` still admits claims and role \`${role}\` is free, so this `
      + 'is a claim-lock or filesystem failure, not a closed run. Retry this tool once; if it repeats, replace the '
      + 'child from the parent.');
  }
  if (!ensureRunHostCapability(cwd, runId, 'codex', {
    point: 'first-tool-model-check',
    event: 'PreToolUse',
    source: 'verified-child-model-gate',
    sessionId: childId,
  })) {
    return deny(
      'traffic-one — Codex child blocked: the verified first-tool model check could not be recorded in the '
      + 'runtime-owned HostCapabilityV1 ledger. Stop this child and repair the run from the parent.',
    );
  }
  return noop();
}
