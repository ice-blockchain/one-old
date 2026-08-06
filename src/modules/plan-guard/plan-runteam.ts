// src/modules/plan-guard/plan-runteam.ts
// Run-team enforcement gate: when a project was onboarded with
// team.mode="subagents", feature-source writes must come from the spawned role
// session that owns the path. Returns a single deny reason (or null). Deny PROSE comes
// from skill/SKILL.md via skillBlock with verbatim fallbacks.

import { hostFlags } from '../../shared/host/capability-flags';
import { obj, type Rec } from '../../shared/obj';
import {
  isMaintenanceSourceWritePath,
  isTestInfraConfigPath,
  isTestScopePath,
  roleCanWriteFeatureSource,
} from '../../shared/feature-source';
import { matchesScope } from '../../shared/scope';
import {
  readCompiledArchitecture,
  readRuntimeAssignments,
} from '../../shared/architecture-contract';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import { reservedOpenCodeFiles } from '../../shared/opencode-roles';
import { readActiveRunBootstrap, repairRunBootstrapForBoundChild } from '../../shared/run-bootstrap-policy';
import {
  activeAgentRole,
  assignmentForContext,
  captureClaimDebug,
  claimThreadRole,
  explainUnresolvedRunAgent,
  hasRunAgentState,
  hookSessionIdentity,
  isMaintenancePhase,
  isSubagentSession,
  legacyRunAgentContext,
  type RunManifest,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
  runLedgerAdmitsClaims,
  runLedgerStatusRecord,
  tryFallbackClaim,
  type RunAgentContext,
} from '../../shared/state';

type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

export interface RunTeamArgs {
  host?: string;
  projectRoot: string;
  filePath: string;          // project-relative target path
  state: Rec;
  rawData: unknown;          // raw hook input, for run-claim session identity
  content?: string;
  writeTargetPaths?: string[];
  // apply_patch can carry different reconstructed contents per target. This
  // map prevents a multi-file patch from being treated as one empty barrel.
  targetContents?: Readonly<Record<string, string | undefined>>;
  featureTargetPaths: string[];
  writingFeatureSource: boolean;
  writingFeatureSourceViaCommand: boolean;
  writingBuildArtifact?: boolean;
  writingBuildArtifactViaCommand?: boolean;
  recordFallbackClaims?: boolean;
  block: Block;
}

// Cursor scope-attribution fallback. A spawned worker's write can carry NO role/parent/
// transcript linkage (`transcript_path: null`, no parent_session_id, no subagent_type) — so
// resolveRunAgentContext can't attribute it and it would be hard-denied (the tests/3c
// deadlock: frontend BLOCKED → respawn spin → dead build). When the write comes from a
// FOREIGN session (not the recorded orchestrator) and ALL its targets fall under a SINGLE
// role's assigned scope, attribute it to that role and stake the claim. Disjoint assignment
// scopes make this deterministic and disambiguate parallel frontend+backend spawns. Strictly
// guarded so it never grants a write the gate should deny:
//   - needs an authored assignment manifest (no manifest → null);
//   - needs a session id that is a known FOREIGN thread — the orchestrator's own session is a
//     recorded MAIN session, so a parent feature-source write is NOT attributed (deny stands);
//   - every target must resolve to exactly ONE owning role; an unowned or scope-spanning write
//     is ambiguous → null (deny stands).
// Host parity: this only runs after transcript/agentId resolution fails, so Codex/Claude (which
// always have a worker transcript or agent_id) resolve earlier and never reach it.
function attributeForeignWriteBySpawnScope(
  projectRoot: string,
  state: Rec,
  rawData: unknown,
  manifest: RunManifest | null,
  targets: string[],
): RunAgentContext | null {
  if (!manifest || targets.length === 0) return null;
  const identity = hookSessionIdentity(rawData);
  const sessionId = identity.sessionId;
  if (!sessionId || !isForeignOnboardingThread(projectRoot, sessionId)) return null;
  const roles = new Set<string>();
  for (const target of targets) {
    const owners = manifest.assignments.filter((a) => matchesScope(target, a.scope));
    if (owners.length === 0) return null;            // a target nobody owns → don't attribute
    for (const a of owners) roles.add(a.role);
    if (roles.size > 1) return null;                 // targets span multiple roles → ambiguous
  }
  const role = [...roles][0];
  if (!role) return null;
  return claimThreadRole(projectRoot, state, sessionId, role, { parentSessionId: identity.parentSessionId || null });
}

// How a parent re-spawns a role so the child's identity actually binds. Shared by
// the unresolved-child remedies that DO end in a respawn; the closed-run remedy
// deliberately omits it, because there a respawn is the wrong action and naming
// its contract reads as an instruction to take it.
const CHILD_SPAWN_CONTRACT = 'On Codex, use the exact `task_name` contract (`quick_fix`, `senior_architect`, `senior_frontend`, `senior_backend`, `senior_reviewer`, `senior_tester`, or `senior_shipper`), the exact role model from the immutable run policy, and `fork_turns: "none"`. Current Codex encrypts the child spawn message, so prompt prose cannot repair identity; task name and line-zero `session_meta` must carry identity while live hooks verify the actual model. On other hosts use the canonical Traffic One agent/type and substitute the actual role in the `[t1-role: <role>]` marker anywhere in a recognized task message.';

// Returns the run-team deny reason, or null when the write is allowed.
export function runTeamEnforcementViolation(args: RunTeamArgs): string | null {
  const {
    projectRoot,
    filePath,
    state,
    rawData,
    featureTargetPaths,
    writingFeatureSource,
    writingFeatureSourceViaCommand,
    writingBuildArtifact,
    writingBuildArtifactViaCommand,
    block,
  } = args;
  const team = obj(state.team);
  if (!team || team.mode !== 'subagents') return null;

  const writeTargetPaths = (args.writeTargetPaths && args.writeTargetPaths.length > 0)
    ? args.writeTargetPaths.filter(Boolean)
    : (filePath ? [filePath] : []);
  const stateRunId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
  const runtimeAssignments = stateRunId
    ? readRuntimeAssignments(projectRoot, stateRunId)
    : null;
  const compiledArchitecture = stateRunId
    ? readCompiledArchitecture(projectRoot, stateRunId)
    : null;
  const runtimeManifest: RunManifest | null = runtimeAssignments
    ? {
        version: runtimeAssignments.version,
        runId: runtimeAssignments.runId,
        createdBy: runtimeAssignments.createdBy,
        assignments: runtimeAssignments.assignments,
        schemaVersion: runtimeAssignments.schemaVersion,
        architectureHash: runtimeAssignments.architectureHash,
        verificationHash: runtimeAssignments.verificationHash,
        assignmentsHash: runtimeAssignments.assignmentsHash,
      }
    : null;
  const preManifest = runtimeManifest
    || (!compiledArchitecture ? readRunAssignmentsResilient(projectRoot, stateRunId) : null);
  const assignedTargets = preManifest
    ? writeTargetPaths.filter((target) => preManifest.assignments.some((assignment) => matchesScope(target, assignment.scope)))
    : [];
  // In maintenance, ANY source-code write is run-team territory — not only the
  // prescribed web layouts FEATURE_SOURCE_RE models. See
  // isMaintenanceSourceWritePath for why (the Go `internal/` hole).
  const writingMaintenanceSource = isMaintenancePhase(state, state.mode)
    && writeTargetPaths.some((target) => isMaintenanceSourceWritePath(target));
  const writingRunTeamTarget = writingFeatureSource
    || Boolean(writingBuildArtifact)
    || assignedTargets.length > 0
    || writingMaintenanceSource;
  if (!writingRunTeamTarget) return null;

  const suffix = block('run-team-suffix',
    'If subagents are genuinely unavailable or the user changes their mind, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting local Traffic One preferences; `team.source="unavailable"` does not bypass `team.mode="subagents"`.');
  const deny = (reason: string): string => `${reason} ${suffix}`;
  const recordFallbackClaims = args.recordFallbackClaims !== false;
  const fallbackClaim = (ctx: RunAgentContext, target: string): { blocked: boolean; holder?: string } => (
    recordFallbackClaims ? tryFallbackClaim(projectRoot, ctx, target) : { blocked: false }
  );

  // Shell writes can't be ownership-verified from a command line.
  if (writingFeatureSourceViaCommand || writingBuildArtifactViaCommand) {
    return deny(block('run-team-shell',
      'Run-team enforcement gate: implementation writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python -c`/`node -e` eval writes, `sed -i`, `rm`, `mv`, `cp`, `find -delete`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead. Run-state bookkeeping (heredocs targeting `.traffic-one/digests/`, `fix-cycles/`, or `runs/`) is exempt. Two shell shapes ARE verifiable and stay allowed: a single `cp`/`mv` importing one file from outside the project, and a single `rm <path>` (at most `-f`, never `-r`, no globs, one operand) removing a stray file that is present on disk, untracked, absent from the immutable baseline, and owned by nobody in the compiled contract — that is cleanup of your own by-product, not an implementation write.'));
  }

  const nativeAnonymousDevinWrite = hostFlags(args.host).nativeWritesCarryNoAgentIdentity
    && obj(rawData)?.hook_event_name === 'PreToolUse'
    && !obj(rawData)?.agent_action_name;
  const agentContext = resolveRunAgentContext(projectRoot, state, rawData, {
    claimPending: true,
    allowSoleAnonymousPending: nativeAnonymousDevinWrite,
    host: args.host,
  })
    || (!hasRunAgentState(projectRoot, state) ? legacyRunAgentContext(state) : null)
    // Last resort for a Cursor worker whose write carries no role/parent/transcript linkage:
    // attribute by assigned scope (see attributeForeignWriteBySpawnScope). Uses the same
    // writeTargetPaths the scope checks below enforce on, so an attributed write is, by
    // construction, inside its role's scope.
    || attributeForeignWriteBySpawnScope(projectRoot, state, rawData, preManifest, writeTargetPaths);
  const acRole = agentContext && typeof agentContext.role === 'string' ? agentContext.role : null;
  const inSubagent = Boolean(agentContext) || (!hasRunAgentState(projectRoot, state) && isSubagentSession(state));
  const role = acRole || activeAgentRole(state) || 'main agent';
  const unresolvedIdentity = hookSessionIdentity(rawData);
  const unresolvedChild = unresolvedIdentity.isSubagent || Boolean(
    unresolvedIdentity.threadId
    && unresolvedIdentity.sessionId
    && unresolvedIdentity.threadId !== unresolvedIdentity.sessionId,
  );

  // DIAGNOSTIC (best-effort): record the raw payload of every feature-source write
  // attempt in subagents mode so we can see how Claude agent-teams role agents
  // identify when their claim fails to bind (see project_agent_teams_claim_deadlock).
  // Does NOT affect the decision below.
  // When nothing bound, record WHY. `resolved:false, role:null` alone cannot
  // distinguish a genuine parent write from a child whose claim was rejected.
  const unresolvedDiagnosis = agentContext
    ? null
    : explainUnresolvedRunAgent(projectRoot, state, rawData);
  captureClaimDebug(projectRoot, typeof state.currentRunId === 'string' ? state.currentRunId : null, 'runteam-write', rawData, {
    filePath,
    filePaths: writeTargetPaths,
    resolved: Boolean(agentContext),
    role,
    runId: agentContext && agentContext.runId != null ? String(agentContext.runId) : null,
    ...(unresolvedDiagnosis ? { unresolved: unresolvedDiagnosis } : {}),
  });
  // A child bound to this run whose envelope is MISSING is wedged: in-scope,
  // correctly claimed, and denied on every call with no publisher reachable from
  // the child side. Fill the hole deterministically from the run's immutables
  // before the contract checks below read it. A failed repair changes nothing —
  // every deny still stands.
  if (acRole && stateRunId && !readActiveRunBootstrap(projectRoot, stateRunId, acRole)) {
    repairRunBootstrapForBoundChild(projectRoot, stateRunId, acRole, state);
  }
  if (acRole === 'quick-fix') {
    const bootstrap = stateRunId
      ? readActiveRunBootstrap(projectRoot, stateRunId, 'quick-fix')
      : null;
    const scope = bootstrap
      ? { include: bootstrap.workUnit.allowlist, exclude: bootstrap.workUnit.allowlistExclude }
      : null;
    if (!scope || !writeTargetPaths.every((target) => matchesScope(target, scope))) {
      return deny(block('run-team-quick-fix-contract',
        'Run-team enforcement gate: the quick-fix worker has no valid parent-published WorkUnitContract covering every requested output. No maintenance or fallback write is allowed without the exact original contract and allowlist hash; re-run parent preflight with a bounded runtime-owned contract.',
        { TARGETS: writeTargetPaths.join(', ') }));
    }
    return null;
  }
  if (compiledArchitecture && !runtimeAssignments) {
    return deny(block('run-team-runtime-contract-invalid',
      'Run-team enforcement gate: this run has CompiledArchitectureV1 but its current-run runtime assignments or VerificationContractV2 are missing, stale, or tampered. The write fails closed; repair/recompile this run and never borrow an assignments manifest from a sibling run.'));
  }
  if (isMaintenancePhase(state, (state as Record<string, unknown>).mode) && !runtimeAssignments) {
    // A senior implementer can hold a bounded-maintenance contract, and until now
    // this gate could not see it. `runtimeAssignments` is strictly per-current-run
    // and a maintenance request rotates a FRESH run with no compiled architecture,
    // so it is always null here — which meant the deny below was unconditional for
    // `senior-frontend`/`senior-backend`. `quick-fix` escapes above by consulting
    // its bootstrap contract; these roles never got the same door, even though the
    // runtime mints them `${role}:bounded-maintenance` envelopes
    // (run-bootstrap-policy/work-unit.ts) and the spawn gate already recognizes
    // them (agent-model/handler.ts). The whole paid fallback path the task-triage
    // skill documents — "if OpenCode declines, spawn that paid role subagent" —
    // was therefore dead on its first write, on every host.
    //
    // The bar is identical to quick-fix's: a parent-published, readback-verified
    // envelope whose allowlist covers EVERY requested output. A role with neither
    // that nor runtime assignments still fails closed.
    const maintenanceBootstrap = acRole && stateRunId
      ? readActiveRunBootstrap(projectRoot, stateRunId, acRole)
      : null;
    const boundedScope = maintenanceBootstrap
      && maintenanceBootstrap.workUnit.unitId === `${acRole}:bounded-maintenance`
      ? {
        include: maintenanceBootstrap.workUnit.allowlist,
        exclude: maintenanceBootstrap.workUnit.allowlistExclude,
      }
      : null;
    if (!boundedScope || !writeTargetPaths.every((target) => matchesScope(target, boundedScope))) {
      return deny(block('run-team-maintenance-contract',
        'Run-team enforcement gate: maintenance writes fail closed without a hash-valid runtime assignment or a bounded quick-fix WorkUnitContract. No unattributed or legacy-scope write was made; publish the parent-owned contract before retrying.'));
    }
    return null;
  }
  if (!inSubagent) {
    if (isMaintenancePhase(state, (state as Record<string, unknown>).mode)) {
      return deny(block('run-team-maintenance-contract',
        'Run-team enforcement gate: maintenance writes fail closed when the hook cannot resolve a spawned worker with a valid parent-published WorkUnitContract. No unattributed write was made; bind the bounded quick-fix claim and exact allowlist before retrying.'));
    }
    // An identity-rejected claim is NOT a spawn problem: the child is genuine and
    // respawning lands the replacement in the same wedge. Say so, and name the
    // drift, instead of sending the parent around the loop again.
    const driftReason = unresolvedDiagnosis
      && (unresolvedDiagnosis.reason === 'fingerprint-mismatch' || unresolvedDiagnosis.reason === 'run-id-mismatch')
      ? ` DIAGNOSIS: a role claim for \`${unresolvedDiagnosis.role || 'this role'}\` exists under run \`${unresolvedDiagnosis.runId || '<unknown>'}\` but was rejected (${unresolvedDiagnosis.reason}; claim \`${unresolvedDiagnosis.claimFingerprint || 'none'}\` vs run \`${unresolvedDiagnosis.ledgerFingerprint || 'none'}\`, live \`${unresolvedDiagnosis.liveFingerprint || 'none'}\`). Respawning will NOT fix this and switching to main-agent mode is not the remedy: the run's identity drifted away from its claims. Let the next SessionStart reconcile it, or settle this run so a fresh one mints with the current identity.`
      : '';
    // The child branch used to prescribe ONE remedy — destroy the child — for
    // every cause that lands here, and resolution collapses at least three into
    // the same `null`: a CLOSED run (no child of any generation can bind in it),
    // a claims or model-observation lock another hook holds for up to ~2s (the
    // claim was about to be minted and nothing was decided), and a claim that is
    // genuinely absent. Probed in remedy order, closed ledger first because it is
    // the only one no respawn can fix — the same order and the same reasoning as
    // codex-child-model.ts's claim-failure probe.
    //
    // A closed run is not a fact about the CHILD, it is a fact about the RUN, so
    // it disqualifies the parent arm's spawn order for exactly the reason it
    // disqualifies the child arm's respawn order: the role the parent is being
    // told to spawn cannot bind a claim either. This was consulted only by
    // `childRecovery`, so a PARENT write into a closed run rendered byte-for-byte
    // as an open one and ordered a spawn into the same wedge — the 10co respawn
    // loop, surviving on the parent side. Both arms consult it now, so the probe
    // below is never computed and dropped.
    const closedLedger = stateRunId && !runLedgerAdmitsClaims(projectRoot, stateRunId)
      ? runLedgerStatusRecord(projectRoot, stateRunId)
      : null;
    // Stated once, consumed by both closed arms: the two used to be able to
    // disagree about a fact neither of them owns.
    const closedRunClause = closedLedger
      ? `the run ledger for \`${stateRunId}\` is \`${closedLedger.status || 'unreadable'}\`${closedLedger.outcome ? ` (${closedLedger.outcome})` : ''}, which admits NO claim from any child`
      : '';
    // `driftReason` is not a footnote. Its "respawning will NOT fix this" ANSWERS
    // the same question the recovery paragraph answers, so appending it to an arm
    // that ENDS in a respawn rendered both orders in adjacent sentences: "must
    // stop or replace this child" immediately followed by "Respawning will NOT fix
    // this", and on the parent arm "Spawn the owning role" followed by the same
    // refusal. So the two COMPOSE instead of concatenating. Where an arm ends in a
    // respawn, drift REPLACES that ending — these two tails are selected only when
    // there is no drift — and where the arm already counsels against a respawn (the
    // closed-ledger arm, whose settle-and-remint the diagnosis merely adds
    // fingerprints to) drift stays purely additive and the arm is untouched.
    // Dropping a tail drops its spawn contract with it, for the reason
    // CHILD_SPAWN_CONTRACT already records: naming the contract reads as an
    // instruction to take it. Nothing is left dangling either — the diagnosis
    // carries the two remedies that DO terminate here (let the next SessionStart
    // reconcile the identity, or settle this run and mint a fresh one), so a
    // suppressed arm still names an action the addressee can take.
    //
    // `closedLedger` is the SECOND thing that can silence a respawn order, and it
    // composes with drift rather than duplicating it: it selects the ARM, while
    // drift selects whether the arm it selected carries its tail. So the two
    // tails keep exactly the meaning they have above — they belong to the OPEN
    // arms only — and neither closed arm reaches for one, because each already
    // ends in the remedy its addressee can take. That ordering is also why a
    // closed arm is not simply a third tail suppressor: suppressing the parent
    // tail on a closed ledger would leave the paragraph naming no action at all.
    const childRespawnTail = driftReason
      ? ''
      : ` If the same deny repeats, the claim is genuinely absent and the PARENT/orchestrator must stop or replace this child and retry the same role. ${CHILD_SPAWN_CONTRACT}`;
    const parentSpawnTail = driftReason
      ? ''
      : ' Spawn the owning role, or message its already-live agent. On Codex, use the exact `task_name` contract (`quick_fix`, `senior_architect`, `senior_frontend`, `senior_backend`, `senior_reviewer`, `senior_tester`, or `senior_shipper`), the exact role model from the immutable run policy, and `fork_turns: "none"`; task name and line-zero `session_meta`, not encrypted prompt prose, carry the child identity while live hooks verify the actual model. On other hosts use the canonical Traffic One agent/type and substitute the actual role in the `[t1-role: <role>]` marker anywhere in a recognized task message.';
    const childRecovery = closedLedger
      ? `This appears to be a spawned child, and its per-run role claim did not resolve because ${closedRunClause}. No write was made. Do not retry the edit, and do not stop or replace this child — the replacement cannot bind a claim either, and looping on respawns is what this deny used to cause. The PARENT/orchestrator resumes the RUN first (only if the user authorized another cycle), or settles it and mints a fresh one; nothing can write in this run until then.`
      : `This appears to be a spawned child, but its per-run role claim did not resolve. No write was made. Retry this exact write ONCE before anything else: while another hook holds this run's claims or model-observation lock the claim cannot be minted and this hook resolves NO role at all, and that clears in about two seconds. Do not self-assert a role in assistant prose — prose cannot create a claim.${childRespawnTail}`;
    // Same taxonomy as the closed child arm, re-addressed: here the reader IS the
    // orchestrator, so the remedy is second-person rather than a report of what
    // some third party does.
    const parentRecovery = closedLedger
      ? `You are the PARENT/orchestrator: do not edit owned implementation artifacts yourself. Spawning the owning role will not help here, because ${closedRunClause}. No write was made, and the role you spawn would land in this same deny — looping on respawns is what this deny used to cause. Resume the RUN first (only if the user authorized another cycle), or settle it and mint a fresh one; nothing can write in this run until then.`
      : `You are the PARENT/orchestrator: do not edit owned implementation artifacts yourself.${parentSpawnTail}`;
    const recovery = (unresolvedChild ? childRecovery : parentRecovery) + driftReason;
    return deny(block('run-team-not-subagent',
      `Run-team enforcement gate: this project was onboarded with \`team.mode="subagents"\`, so feature-source and assigned build-artifact writes must come from a spawned Traffic One role session with a per-agent run claim, not ${role}. ${recovery} Do NOT fall back to delegating from inside a worker or rewriting team preferences.`,
      { ROLE: role, RECOVERY: recovery }));
  }

  // Preferred path: the exact current-run runtime-owned assignment manifest.
  // Ownership is by assigned SCOPE, not by guessed path-kind — stack-agnostic.
  const runId = agentContext && agentContext.runId != null ? String(agentContext.runId) : null;
  // Legacy runs may use resilient lookup. Once currentRunId has a compiled v2
  // contract, a child claim carrying a stray run id cannot redirect scope.
  const manifest = compiledArchitecture
    ? preManifest
    : ((runId === stateRunId ? preManifest : readRunAssignmentsResilient(projectRoot, runId)) || preManifest);
  const ownershipTargets = featureTargetPaths.length > 0
    ? featureTargetPaths
    : (assignedTargets.length > 0 ? assignedTargets : writeTargetPaths);

  // Tester test-path overlay: tests are interleaved inside implementer scopes
  // (the assignments manifest only carries frontend/backend), so a tester write
  // whose EVERY target is a test-scope path — a test file/dir OR a canonical
  // test-runner config/setup file (vitest/playwright/jest/cypress; observed
  // 8c/11c/12c: the tester was denied on jest.config.js, playwright.config.ts,
  // vitest.setup.ts as frontend-owned) — is owned by the tester regardless of
  // which assignment covers the surrounding directory. App bundler configs
  // (next.config, vite.config) are NOT test infra and stay implementer-owned.
  // Deliberately all-or-nothing: a patch mixing a test target with real
  // feature source falls through and still denies on the source target.
  if (!runtimeAssignments && acRole === 'senior-tester' && ownershipTargets.length > 0
    && ownershipTargets.every((target) => isTestScopePath(target) || isTestInfraConfigPath(target))) return null;

  if (manifest && agentContext) {
    const mine = assignmentForContext(manifest, agentContext);
    const myKey = (mine && (mine.agentKey || mine.role)) || role;
    for (const target of ownershipTargets) {
      if (mine && matchesScope(target, mine.scope)) continue; // inside my scope -> allowed
      const conflict = manifest.assignments.find((a) => a !== mine
        && matchesScope(target, a.scope));
      if (conflict) {
        return deny(block('run-team-scope-conflict',
          `Run-team enforcement gate: \`${target}\` is in \`${conflict.agentKey || conflict.role}\`'s assigned scope in the runtime-owned WorkUnitContract for this run, not \`${myKey}\`'s. Each subagent writes only within the exact allowlist compiled from ArchitectureInputV1. Let the owning role write this file, or replan the semantic architecture before execution; never patch assignments.json directly.`,
          { TARGET: target, OWNER: String(conflict.agentKey || conflict.role), ROLE: String(myKey) }));
      }
      if (runtimeAssignments) {
        // The remedy used to name only the replan. Inside a fix cycle there is
        // no replan available, so an order to write an unowned path became an
        // unescapable deny: the implementer could not comply, the reviewer
        // could not approve, and the run deadlocked (observed 12co,
        // `apps/web/public/llms.txt`). Name the action that EXISTS in both
        // situations first — report BLOCKED in the role digest — and keep the
        // replan as the between-runs remedy it actually is.
        return deny(block('run-team-runtime-allowlist-gap',
          `Run-team enforcement gate: STRUCT_ASSIGNMENT_ALLOWLIST_GAP — \`${target}\` is outside \`${myKey}\`'s immutable runtime-owned WorkUnitContract. No dynamic claim is allowed for a compiled run. Do NOT keep retrying this write, and do not move it to a path you do own. Report it in your digest instead: name \`${target}\`, say it is in no role's allowlist, and set your verdict to \`BLOCKED\` (in a fix cycle, list it under \`FIXES_FAILING\` with this reason — that is the whole available action there, and it is a complete answer). Replanning ArchitectureInputV1 to compile a home for the path happens between runs, by the architect, never from inside this session.`,
          { TARGET: target, ROLE: String(myKey) }));
      }
      // Outside every assignment -> dynamic first-write claim (no hard deadlock).
      const decision = fallbackClaim(agentContext, target);
      if (decision.blocked) {
        return deny(block('run-team-fallback-taken',
          `Run-team enforcement gate: \`${target}\` is outside every role's legacy scope and is already being written by \`${decision.holder}\` in this run. Coordinate so a single role owns this path. For a compiled run, change ArchitectureInputV1 and let runtime regenerate the exact WorkUnitContract; never add paths to assignments.json manually.`,
          { TARGET: target, HOLDER: String(decision.holder) }));
      }
    }
    return null;
  }

  // Legacy fallback: no manifest. Use the regex ownership oracle, but route paths owned
  // by NO role through the dynamic claim instead of the former hard deadlock.
  const ownedByActiveRole = Boolean(agentContext)
    && ownershipTargets.every((target) => roleCanWriteFeatureSource(acRole, target));
  if (ownedByActiveRole) return null;

  for (const target of ownershipTargets) {
    const ownedBySomeRole = roleCanWriteFeatureSource('senior-frontend', target)
      || roleCanWriteFeatureSource('senior-backend', target);
    if (ownedBySomeRole) {
      if (agentContext && !roleCanWriteFeatureSource(acRole, target)) {
        return deny(block('run-team-wrong-role',
          `Run-team enforcement gate: the active Traffic One role \`${role}\` does not own \`${target}\`. Use the role that owns the path, or split the patch by role ownership.`,
          { ROLE: role, TARGETS: target }));
      }
      continue; // owned by the active role (or legacy either-role fallback) -> allowed
    }
    // Owned by no role -> dynamic first-write claim (was the run-team-not-owned deadlock).
    if (agentContext) {
      const decision = fallbackClaim(agentContext, target);
      if (decision.blocked) {
        return deny(block('run-team-fallback-taken',
          `Run-team enforcement gate: \`${target}\` is outside every Traffic One role's owned paths and is already being written by \`${decision.holder}\` in this run. Coordinate so a single role owns this path.`,
          { TARGET: target, HOLDER: String(decision.holder) }));
      }
    }
  }
  return null;
}

// Verbatim mirror of the SKILL.md `opencode-reserved-files` block. The denied
// actor is a CHILD implementer with no MCP tools — every remedy must be
// child-executable (the pre-12co runteam prose that named an unavailable
// remedy is the bug class to avoid).
const OPENCODE_RESERVED_FILES_FALLBACK = 'traffic-one — OpenCode reservation: `{{TARGET}}` is reserved by the RUNNING delegated unit `{{UNIT_ID}}` ({{UNIT_ROLE}}) in run `{{RUN_ID}}` — a paid write here would collide with the diff that unit is about to apply. Reserved for it: {{FILES}}. Work on your NON-reserved files now and come back to this path last; if it stays reserved when everything else is done, record the path and unit id under Open questions in your digest — the ORCHESTRATOR (not you) waits for or cancels the delegation. Bounded: the reservation clears the moment unit `{{UNIT_ID}}` ends (or its executor dies).';

/** Write-time reservation deny: while a delegated unit is verifiably RUNNING,
 *  its allowedFiles are off-limits to every paid writer — in serial mode too
 *  (a paid backend vs a running maintenance frontend unit is the same
 *  collision). The OpenCode runner itself never passes through hooks (its
 *  apply is an in-process git apply), so the only writer that must pass is
 *  already invisible here. Bounded by unit terminality + the liveness window;
 *  a stale ledger never denies. */
export function openCodeReservedFilesViolation(args: {
  projectRoot: string;
  state: Rec;
  targets: readonly string[];
  block: Block;
}): string | null {
  if (args.targets.length === 0) return null;
  const runId = typeof args.state.currentRunId === 'string' ? args.state.currentRunId.trim() : '';
  if (!runId) return null;
  const reservations = reservedOpenCodeFiles(args.projectRoot, runId);
  if (reservations.length === 0) return null;
  for (const target of args.targets) {
    for (const unit of reservations) {
      if (matchesScope(target, { include: unit.patterns, exclude: [] })) {
        return args.block('opencode-reserved-files', OPENCODE_RESERVED_FILES_FALLBACK, {
          TARGET: target,
          UNIT_ID: unit.unitId,
          UNIT_ROLE: unit.role,
          RUN_ID: runId,
          FILES: unit.patterns.join(', '),
        });
      }
    }
  }
  return null;
}
