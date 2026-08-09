import { asString } from '../../adapters/coerce';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { obj } from '../../shared/obj';
import {
  EXPLORATION_CAPPED_ROLES,
  REPLACE_AGENT_MARKER,
  activeClaimForOtherThread,
  agentActivityCapDenied,
  bumpRunAgentActivity,
  claimThreadRole,
  correctCodexChildObservationRole,
  disownConflictedRoleAgent,
  explorationCapForRole,
  hookSessionIdentity,
  inferRoleEvidenceFromTranscript,
  isSubagentThread,
  markAgentActivityCapDenied,
  observeCodexChildModel,
  readCodexModelObservation,
  readCodexSessionMetaIdentity,
  readEffectiveState,
  readRunAgentActivity,
  readRunAgentRegistry,
  resolveRunAgentContext,
  runLedgerClaimAdmission,
  runLedgerStatusRecord,
  transcriptThreadId,
} from '../../shared/state';
import { canonicalHost } from '../../shared/model-tiers';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import { readActiveRunBootstrap } from '../../shared/run-bootstrap-policy';
import { ensureRunHostCapability } from '../../shared/host/capabilities';
import { resolveToolScope, workspaceMemberRefusal } from '../../shared/tool-scope';
import { block } from './handler-prose';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

// Verbatim mirror of the SKILL.md `agent-activity-exploration-cap` block so a
// missing block never softens the one consolidation deny into silence.
const EXPLORATION_CAP_FALLBACK = 'traffic-one — exploration cap: `{{ROLE}}` has made {{COUNT}} tool calls in run `{{RUN_ID}}` and this search/read call is refused ONCE as a consolidation checkpoint (editing, shell verification, and digest writes are never blocked, and every later call — including search/read — goes through). Write down what you already know, then act on it: batch the remaining related reads, group coherent edits, run ONE combined verification command per surface, do not re-read rules or files already loaded, and finish the assignment before exploring further. Cap: {{CAP}} calls per child (config `agentActivity.explorationCap`, env `T1_EXPLORATION_CAP`; 0 disables).';

// The at-most-once exploration cap. Decision is pure and fail-open on every
// uncertainty: wrong class, exempt role, unresolved child id, disabled cap,
// under cap, marker already present, or marker unverifiable → null (allow).
export function explorationCapDecision(args: {
  toolClass: unknown;
  role: string;
  childKey: string;
  count: number;
  cap: number;
  alreadyDenied: boolean;
}): 'deny' | null {
  if (args.toolClass !== 'search' && args.toolClass !== 'file-read') return null;
  if (!EXPLORATION_CAPPED_ROLES.has(args.role)) return null;
  if (!args.childKey || args.childKey === 'unknown') return null;
  if (args.cap <= 0) return null;
  if (args.count < args.cap) return null;
  if (args.alreadyDenied) return null;
  return 'deny';
}

function explorationCapDeny(
  ctx: Ctx,
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  childKey: string,
): HookResult | null {
  try {
    const cap = explorationCapForRole(state, role);
    const count = readRunAgentActivity(cwd, runId, role).bySession[childKey] || 0;
    const decision = explorationCapDecision({
      toolClass: ctx.input.tool?.class,
      role,
      childKey,
      count,
      cap,
      alreadyDenied: agentActivityCapDenied(cwd, runId, role),
    });
    if (!decision) return null;
    // Deny only when the once-marker DURABLY landed: this check rides every
    // search/read call, so an unwritable marker must fail open, never re-deny.
    if (!markAgentActivityCapDenied(cwd, runId, role)) return null;
    return deny(block('agent-activity-exploration-cap', {
      ROLE: role,
      RUN_ID: runId,
      COUNT: count,
      CAP: cap,
    }, EXPLORATION_CAP_FALLBACK), { denyId: 'agent-activity-exploration-cap', denyTarget: role });
  } catch {
    return null; // telemetry-derived enforcement must never break a tool call
  }
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
  const unresolvedMember = workspaceMemberRefusal(scope);
  if (unresolvedMember) {
    return deny(unresolvedMember.reason,
      { denyId: unresolvedMember.denyId, denyTarget: unresolvedMember.denyTarget });
  }
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
        { denyId: 'codex-child-model-policy-missing', denyTarget: runId || undefined },
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
          { denyId: 'codex-child-model-role-unbound' },
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
        { denyId: 'codex-child-model-bootstrap-mismatch', denyTarget: claimedRole },
      );
    }
    // Per-CHILD tally key: on Claude the hook session_id is the PARENT's, so a
    // session-keyed bucket would lump every child and respawn of a role into
    // one and the cap would misfire late-run. agentId/threadId identify the
    // actual child; sessionId is the last resort.
    const childKey = identity.agentId || identity.threadId || identity.sessionId || '';
    const capDenyResult = explorationCapDeny(ctx, cwd, state, runId, claimedRole, childKey);
    if (capDenyResult) return capDenyResult;
    // One tally line per ALLOWED tool call (denies never count).
    bumpRunAgentActivity(cwd, runId, claimedRole, childKey);
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
      { denyId: 'codex-child-model-identity-conflict', denyTarget: hookChildId || undefined },
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
      { denyId: 'codex-child-model-run-missing', denyTarget: cwd },
    );
  }
  const childId = observation?.childId || hookChildId;
  if (!childId) {
    return deny('traffic-one — Codex child blocked: the hook exposed no stable child id, so its observed model cannot be bound safely. Stop this child and respawn from the parent.',
      { denyId: 'codex-child-model-no-child-id' });
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
      { denyId: 'codex-child-model-role-not-observable' },
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
    // NOTHING was recorded, which is not the same answer as "the model is wrong"
    // and used to render as one: the fallback reason GUESSED "run model policy
    // missing" and prescribed replacing the child. The observation store returns
    // null for a missing/foreign-host policy AND for its own contended lock or
    // refused write, so read the policy — the only one of the two a respawn
    // cannot fix — and let the other prescribe the retry it deserves, exactly as
    // the claim-persist deny below does.
    //
    // The two answers carry two ids, chosen here (config/deny-ids.ts's naming
    // rule) because one id could not tell them apart anywhere downstream: this
    // gate writes no per-branch diagnostic, and `denyTarget` was the same `role`
    // on both, so the decision log's `denyId` said one word for a two-second
    // lock and for a run whose policy is gone.
    if (!updated) {
      const observationPolicy = readRunModelPolicy(cwd, runId);
      if (!observationPolicy || observationPolicy.host !== 'codex') {
        // Not a new cause: this is the same missing/corrupt/foreign-host run
        // policy the non-Codex branch above refuses, with the same remedy, so it
        // is the same id — and `denyTarget` is the RUN there, so it is the run
        // here too. Sharing keeps one broken run in one bucket instead of one
        // per role, and the log's `host` still separates the two call sites.
        return deny(
          `traffic-one — Codex child blocked: the immutable model policy for run \`${runId}\` is missing, corrupt, `
          + 'or belongs to another host, so this child\'s observed model cannot be verified against anything. '
          + 'Only the parent may create the run and freeze the policy: stop this child and repair/respawn it from '
          + 'the parent.',
          { denyId: 'codex-child-model-policy-missing', denyTarget: runId },
        );
      }
      return deny(
        `traffic-one — Codex child blocked: role \`${role}\` and policy \`${observationPolicy.policyId}\` are both `
        + `intact for run \`${runId}\`, but the observed-model record could not be written — this is the observation `
        + 'store\'s lock or filesystem, not a model breach, and nothing about this child was rejected. Retry this '
        + 'tool once; if it repeats, replace the child from the parent.',
        { denyId: 'codex-child-model-observation-persist-failed', denyTarget: role || undefined },
      );
    }
    const status = updated.status;
    const reason = updated.reason || 'unknown';
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
        { denyId: 'codex-child-model-status-conflict', denyTarget: role },
      );
    }
    // All that is left is `pending-role`, which here can only mean no model was
    // observed for this child on ANY event (the role is already resolved above and
    // passed in). Nothing has been checked, so the call fails closed — and unlike
    // the two answers above, a respawn IS the fix, because it can carry the model.
    // The sole carrier of `codex-child-model-status-unverified`, and the only
    // branch the name fits: a record exists here and its status is not verified.
    return deny(
      `traffic-one — Codex child blocked: observed model status is ${status} `
      + `(${reason}) — no model has been observed for this child on any event, so there is nothing to check against `
      + 'the immutable policy. Parent: interrupt/replace this child and respawn '
      + 'with the exact model in .traffic-one/runs/<runId>/model-policy.json.',
      { denyId: 'codex-child-model-status-unverified', denyTarget: role || undefined },
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
      { denyId: 'codex-child-model-bootstrap-mismatch', denyTarget: role },
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
    //
    // THREE-VALUED. `runLedgerAdmitsClaims` answers `true` for a ledger it merely
    // could not READ (deliberately — its other consumer is a gate that would
    // otherwise destroy a healthy child over an unreadable file), so a truncated
    // `run.json` fell past this probe, past the rival probe, and landed on
    // `codex-child-model-claim-persist-failed` — whose prose asserts "The run
    // ledger for X still admits claims", which is measurably false here, and
    // prescribes a retry for a condition no retry clears.
    const admission = runLedgerClaimAdmission(cwd, runId);
    if (admission === 'unknown') {
      // Measured on a truncated ledger: the claim mint, a resume and a settlement
      // all return `unavailable('ledger-corrupt')`, so every remedy the closed arm
      // offers is unavailable here too. The file is a runtime-owned run sidecar
      // and `runtime-sidecar-owner-gate` refuses every agent write to it, so the
      // only remedy that exists is a USER one — and it works: with the file gone
      // the run reads as `planned` again and the next claim binds.
      return deny(`traffic-one — Codex child blocked: the run ledger for \`${runId}\` `
        + `(\`.traffic-one/runs/${runId}/run.json\`) cannot be read or parsed, so NO child can bind a role in it and `
        + 'every tool call from this thread stays denied. This is NOT a lock and NOT a transient failure: the claim '
        + 'mint, a resume and a settlement all refuse this run with `ledger-corrupt`, so retrying, respawning and '
        + 'settling fail identically. No agent may repair that file — every agent write to a run sidecar is refused. '
        + `ROOT orchestrator: capture the diagnosis with \`node ~/.traffic-one/bin/doctor.cjs --run "${runId}"\`, then `
        + 'ask the USER to restore that one file from version control or delete it; a fresh run can be minted once it '
        + 'is legible or gone. Do not spawn another child into this run in the meantime.',
        { denyId: 'codex-child-model-ledger-illegible', denyTarget: runId });
    }
    if (admission === 'closed') {
      const ledger = runLedgerStatusRecord(cwd, runId);
      return deny(`traffic-one — Codex child blocked: the run ledger for \`${runId}\` is \`${ledger.status || 'unreadable'}\``
        + `${ledger.outcome ? ` (${ledger.outcome})` : ''}, so NO child can bind a role in it and every tool call from `
        + 'this thread stays denied. Respawning does not fix this — the run itself is closed. ROOT orchestrator: a '
        + 'resume is legal ONLY out of `blocked`; `completed` and `failed` runs cannot be reopened at all, and the '
        + 'command below is refused for them. If the status above is `blocked` and the user has authorized another '
        + 'cycle, resume the RUN first with '
        + `\`node ~/.traffic-one/bin/run-status.cjs --run-id "${runId}" --status active --reason user-authorized-extra-cycle\`, `
        + `then confirm \`.traffic-one/runs/${runId}/settlement-v2.json\` reads \`"status": "active"\` before respawning `
        + 'this child. If it still reads `"status": "blocked"`, the resume did NOT take effect — do not spawn into this '
        + 'run; settle it and mint a new one. For any other status, minting a new run is the only remedy.',
        { denyId: 'codex-child-model-ledger-closed', denyTarget: runId });
    }
    const rival = obj(activeClaimForOtherThread(cwd, state, runId, role, childId));
    if (rival) {
      return deny(`traffic-one — Codex child blocked: role \`${role}\` in run \`${runId}\` is already held by live thread `
        + `\`${String(rival.sessionId || 'unknown')}\` (claim \`${String(rival.claimId || 'unknown')}\`), and a verified `
        + 'child never displaces another live thread. Retrying this tool cannot succeed. ROOT orchestrator: keep the '
        + `incumbent and stop this duplicate, or retire the incumbent with a \`${REPLACE_AGENT_MARKER}\` spawn for `
        + `\`${role}\` and let exactly ONE replacement bind.`, { denyId: 'codex-child-model-role-held', denyTarget: role });
    }
    return deny(`traffic-one — Codex child blocked: model verification passed but the verified role claim could not be `
      + `persisted atomically. The run ledger for \`${runId}\` still admits claims and role \`${role}\` is free, so this `
      + 'is a claim-lock or filesystem failure, not a closed run. Retry this tool once; if it repeats, replace the '
      + 'child from the parent.', { denyId: 'codex-child-model-claim-persist-failed', denyTarget: role });
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
      { denyId: 'codex-child-model-capability-record-failed' },
    );
  }
  const capDenyResult = explorationCapDeny(ctx, cwd, state, runId, role, childId);
  if (capDenyResult) return capDenyResult;
  // One tally line per ALLOWED tool call (denies never count).
  bumpRunAgentActivity(cwd, runId, role, childId);
  return noop();
}
