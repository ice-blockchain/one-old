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
  runLedgerClaimAdmission,
  runLedgerStatusRecord,
  tryFallbackClaim,
  type RunAgentContext,
} from '../../shared/state';

type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

export interface RunTeamArgs {
  host?: string;
  projectRoot: string;
  /**
   * The Traffic One WORKSPACE MEMBER this write anchored to, or '' when the
   * project is not a member of a workspace (every project that exists today).
   *
   * Carried rather than re-derived because plan-write already holds it, and
   * recorded in the claim-debug row rather than branched on: `projectRoot`
   * alone cannot say whether a root is a member of a workspace or a standalone
   * project, so without it the one question a multi-member run needs to answer
   * afterwards — which member did this claim resolve in, and was that the
   * member the call named — is unanswerable from the record.
   */
  workspaceMember?: string;
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
  /**
   * "This write is going to be ALLOWED" — false when the dispatcher has already
   * judged a violation the gate will refuse on.
   *
   * It governs the two things this gate MINTS, and nothing else: the per-path
   * first-write claim and, through `attributeForeignWriteBySpawnScope`, the
   * per-ROLE claim a scope-attributed Cursor worker would take. Both lock
   * something to a session for the rest of the run (or SUBAGENT_STALE_MS), and
   * neither may be bought by a write that never lands.
   *
   * IT SUPPRESSES NO CHECK. Every question this gate asks — who holds the path,
   * who owns the scope, whether the role is occupied — is asked identically
   * either way, so a doomed write still earns the exact deny it would have
   * earned. That separation is the fix for a defect this flag itself caused: as
   * a gate over the whole claim call it also withheld the ownership-conflict
   * deny, precisely when another violation coexisted.
   *
   * Named for the first of the two mints, which is the name every caller
   * already passes.
   */
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
//
// MEMBER IDENTITY: this is the ONE path in the gate that MINTS authority rather
// than checking it — it stakes a role claim for a session that proved nothing
// about itself, on the strength of where its targets landed. Inside a workspace
// that is sound only if every root it reads and writes is the MEMBER rather
// than the container, and it is: `projectRoot` here is already the member,
// because shared/tool-scope.ts re-anchored the scope to it and refused outright
// any call that could not name exactly one (the member fence). So the manifest
// consulted, the onboarding thread tested, and the claim staked are all
// member-local with no code here, which is the point of doing the re-anchor in
// the resolver instead of teaching each consumer about workspaces.
//
// An earlier revision took the member as a parameter and required it to equal
// `projectRoot`. That comparison cannot fail: plan-write reads both from one
// `ToolScopeResolution`, whose projectRoot IS `workspace.member` on that arm.
// It is removed rather than kept as reassurance — an unfalsifiable guard reads
// like protection and buys none. The construction it asserted is instead pinned
// where it is real, on the resolver: see 'a write into a registered member
// anchors to that member, not the container' in
// src/shared/__tests__/tool-scope-fence.test.ts.
function attributeForeignWriteBySpawnScope(
  projectRoot: string,
  state: Rec,
  rawData: unknown,
  manifest: RunManifest | null,
  targets: string[],
  writeWillBeAllowed: boolean,
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
  // NEVER OVER A LIVE HOLDER. Minting on the strength of scope alone is already
  // the one authority-creating path here; doing it while another thread demonstrably
  // owns the role turns it into an authority-DESTROYING one, because the fresh
  // claim's own `releaseSupersededRoleClaimsLocked` retires the incumbent — and a
  // retired claim reads `claim-superseded`, which claim-thread-role.ts refuses to
  // re-bind, so the real role agent is locked out for the rest of the run (or 30
  // minutes of SUBAGENT_STALE_MS, whichever is shorter). Measured: a stray
  // same-project session, and a session belonging to a SIBLING workspace member,
  // both displaced a working senior-frontend and left its next in-scope write denied.
  // `isForeignOnboardingThread` is a negative membership test over a default-open
  // population, so it admits exactly those strays.
  //
  // It costs the two populations the rescue EXISTS for nothing.
  // `activeClaimForOtherThread` counts only claims `claimAllowsState` accepts, so
  // a role with no rival at all (the tests/3c Cursor worker) still binds, and a
  // role whose only rival is an identity-REJECTED claim still binds too — the fact
  // the run-team-not-subagent drift clause below already rests on, and the reason a
  // contracted replacement recovers a drifted child.
  //
  // WHAT IT DOES COST, named because it is not nothing. A RESPAWNED Cursor worker
  // for the same role arrives with a NEW session id — carrying no parent,
  // transcript or agent linkage is the entire premise of this path — so at this
  // point the stray and the legitimate replacement are indistinguishable by
  // construction, and the replacement is denied for as long as the incumbent claim
  // stays live. Two things end that, both MEASURED on the same fixture (a bound
  // worker #1, then a second session with a fresh id writing the same in-scope
  // path):
  //   - THE PARENT RETIRES THE INCUMBENT, and the door is real rather than
  //     hypothetical. The bind below also records a reuse-registry row for the role
  //     (claimThreadRole mirrors it whenever `subagentContinuationAvailable`, which
  //     is true on Cursor), and `markRunAgentReplacedIfMatches` stamps that row
  //     `replaced`. `roleRegistryDisownsClaim` reads exactly that, so the incumbent
  //     stops counting as a live rival: measured DENIED with the row live and
  //     ALLOWED immediately after the retirement, with no other change. On Cursor
  //     the caller that reaches it is the JUSTIFIED `[t1-replace-agent]` respawn in
  //     agent-model/gate-reuse.ts, and that one only. The presumed-dead escape
  //     beside it is NOT a second door for this population, however it reads: it
  //     needs `continuationAgentId(live, 'cursor')` to be empty, and the bind mints
  //     the row's `resumeId` FROM THE SESSION ID at the instant the row is created
  //     (registry.ts derives it from `agentId` whenever that is not a Cursor
  //     tool-call id, which a bind's session id never is), so the incumbent cannot
  //     be an agent that "went without a resume id". Measured on the row this path
  //     produces: `resumeId` present, `continuationAgentId` non-empty, escape
  //     condition false. So this bullet is ONE door, not two.
  //     (`disownConflictedRoleAgent` clears the same marker but its only production
  //     caller is Codex model-conflict, so it is not the door on this host.)
  //   - FAILING THAT, THE CLAIM AGES OUT at SUBAGENT_STALE_MS — 30 minutes, and
  //     that is the hard bound on the lockout.
  // Accepted deliberately: the silent displacement this guard replaces cost the
  // LIVE agent the REST OF THE RUN, because its claim reads `claim-superseded` and
  // never re-binds, while the deny costs a genuine replacement at most that
  // 30-minute window.
  //
  // THE PARENT-SIDE EXIT IS NOT UNIVERSAL, and the paragraph above is scoped to
  // the hosts that have it rather than describing every host. It needs a reuse
  // row to stamp, and `claimThreadRole` records one only when
  // `subagentContinuationAvailable()` — measured over five host configurations:
  // present on Cursor, on Codex, and on Claude WITH the agent-teams flag; absent
  // on bare Claude and on opencode, where the bind still succeeds but
  // `agents.json` stays empty, so `markRunAgentReplacedIfMatches` has nothing to
  // stamp and answers false. On those two the 30-minute age-out is the ONLY bound
  // on the lockout, with no parent-side exit inside it — still bounded, and still
  // shorter than the rest-of-run displacement it replaces, but the parent cannot
  // shorten it.
  //
  // AND NOT AT ALL FOR A WRITE THAT IS ALREADY DOOMED. Everything above is an
  // argument about what a MINT costs the role's rightful owner, and the same
  // argument applies with nothing on the other side of the scale when the write
  // is going to be refused anyway. Round 5 closed that for the PATH claim (see
  // `recordFallbackClaims`) and left it open here: measured with the role held
  // by NOBODY, a stray session, and a write whose sole violation is a static
  // rule, the deny was issued AND a live role claim was minted for the stray —
  // which then denies the next legitimate rescue for up to the 30 minutes
  // bounded above, on the strength of a write that never landed. `mint: false`
  // takes the same decision by the same reads and stakes nothing; the returned
  // context is byte-identical, so the deny this write does earn is unchanged.
  return claimThreadRole(projectRoot, state, sessionId, role, {
    parentSessionId: identity.parentSessionId || null,
    refuseOccupiedRole: true,
    mint: writeWillBeAllowed,
  });
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
  // ALWAYS ASK WHO HOLDS THE PATH; record only when the write will be allowed.
  // Gating the whole call on the flag conflated a CHECK with a RECORD, and the
  // check is the half a doomed write still needs: measured, a path held by one
  // child and written by another with an unrelated static violation denied with
  // the static rule alone, where the old ordering named the ownership conflict
  // too. See `tryFallbackClaim`'s own note for the two costs that cost.
  const recordFallbackClaims = args.recordFallbackClaims !== false;
  const fallbackClaim = (ctx: RunAgentContext, target: string): { blocked: boolean; holder?: string } => (
    tryFallbackClaim(projectRoot, ctx, target, { record: recordFallbackClaims })
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
    || attributeForeignWriteBySpawnScope(projectRoot, state, rawData, preManifest, writeTargetPaths, recordFallbackClaims);
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
    // Present ONLY inside a workspace, so every existing project's debug record
    // is byte-identical. Recorded because `projectRoot` alone cannot say whether
    // a root is a member of a workspace or a standalone project, and the whole
    // point of a multi-member run is being able to read afterwards which member
    // a claim was resolved in.
    ...(args.workspaceMember ? { workspaceMember: args.workspaceMember } : {}),
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
      // `writeTargetPaths` is `[]` when neither an explicit target list nor a
      // filePath resolved (see its definition above), and this arm is reachable
      // in that state through `!scope` — so the var is guarded here rather than
      // leaving the prose to render an empty pair of backticks.
      const targets = writeTargetPaths.join(', ') || filePath || '(no write target resolved)';
      return deny(block('run-team-quick-fix-contract',
        `Run-team enforcement gate: the quick-fix worker has no valid parent-published WorkUnitContract covering every requested output. Not covered by one: \`${targets}\`. No maintenance or fallback write is allowed without the exact original contract and allowlist hash, and you cannot publish or widen that contract yourself — only the parent can, so retrying this write draws the same refusal. Write only the outputs your own published contract already names; if it names none of these, stop and write your digest with verdict \`BLOCKED\` listing exactly these paths, so the orchestrator can re-run parent preflight with a bounded runtime-owned contract that covers them.`,
        { TARGETS: targets }));
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
    const uncovered = boundedScope
      ? writeTargetPaths.filter((target) => !matchesScope(target, boundedScope))
      : [];
    if (!boundedScope || uncovered.length > 0) {
      // ONE render for NINE causes, spanning two addressees with two different
      // available actions — measured over this arm's whole branching space
      // (bounded contract present|absent|wrong-unit × one|several|mixed
      // uncovered targets × role × pending-fallback-debt, plus the unresolved
      // parent). A bound child whose contract simply MISSED one task-related
      // file read the same bytes as an unattributed parent write: the cause was
      // stated as "no contract" when the contract existed and was hash-valid,
      // the noun was `quick-fix` while the addressee was a senior implementer,
      // "No unattributed or legacy-scope write was made" was false of it on
      // both counts, and the only prescribed action — publish the parent-owned
      // contract — is one the addressee cannot take. Observed as the incident
      // this arm exists for: a bounded senior-backend denied on a
      // task-related model file its allowlist never listed, with nothing to go
      // on. Same defect class the three preceding lanes fixed on
      // `run-team-not-subagent`, and the same remedy: the CAUSE clause and the
      // REMEDY are built here, per addressee, and every arm ends in an action
      // its own addressee can perform.
      //
      // NOT branched on the pending fallback debt, deliberately. The debt
      // (fallbackContractMatches) refuses every WIDENED envelope for the role,
      // so it changes whether a widening is possible — but the action available
      // to the reader is the same either way, and one sentence true in both
      // cases costs nothing while a fourth arm would multiply this render space
      // for a fact that moves nothing. It is also why no arm below prescribes a
      // widening: measured, `ensureRunBootstrap` returns null for any widened
      // set while the debt is pending, and a senior role's bounded envelope
      // originates from that debt in the first place (agent-model/handler.ts
      // honours `[t1-bounded-scope]` for `quick-fix` only), so a printed
      // "re-spawn with a wider scope" recipe would name a path that does not
      // work.
      const targets = writeTargetPaths.join(', ') || filePath || '(no write target resolved)';
      // The digest is inside every bounded contract by construction
      // (run-bootstrap-policy/work-unit.ts appends it to outputs AND allowlist),
      // and a `.traffic-one/digests/` write is neither feature source nor a
      // build artifact, so this gate stands down on it with or without an
      // envelope. Naming the exact path is what makes the report an action
      // rather than an aspiration.
      const digestPath = maintenanceBootstrap?.workUnit.allowlist
        .find((entry) => entry.startsWith('.traffic-one/digests/'));
      const digestClause = digestPath ? ` (\`${digestPath}\`)` : '';
      const recovery = uncovered.length > 0
        ? `\`${acRole}\`'s bounded maintenance WorkUnit is hash-valid but does not cover: \`${uncovered.join(', ')}\`. No write was applied. The contract is parent-published and pinned, so you cannot widen it, and while this run still owes a delegated OpenCode unit for this role the runtime refuses ANY widened contract for it — retrying this write, and moving it to a path you do own, are both dead ends. Finish every deliverable your CURRENT contract already covers, then write your digest${digestClause} with verdict \`BLOCKED\` naming exactly \`${uncovered.join(', ')}\` as outside your bounded scope. That report is the whole available action here and it is a complete answer: the orchestrator turns it into its own bounded task for those paths once this unit is delivered and settled.`
        : acRole
          ? `No bounded WorkUnitContract is published for \`${acRole}\` in run ${stateRunId || '<unknown>'}, so nothing authorizes this write and none was applied. Do not retry it and do not move it to another path — only the parent can publish that contract, and no maintenance write of yours can be authorized until it does. Write your digest${digestClause} with verdict \`BLOCKED\` naming \`${targets}\` and saying no bounded contract covers it, then stop.`
          : `No per-agent run claim resolved for this write, so it was attributed to nobody and none was applied. Do not edit owned implementation source from here. Spawn the maintenance worker that should own it — a \`quick-fix\` subagent carrying ONE prompt line \`[t1-bounded-scope: {"outputs":[${writeTargetPaths.slice(0, 4).map((target) => `"${target}"`).join(', ') || '"<exact repo-relative paths>"'}]}]\` naming every exact repo-relative file the task may create or modify — and let that child make the edit; the runtime publishes its bounded contract from that line.`;
      return deny(block('run-team-maintenance-contract',
        `Run-team enforcement gate: maintenance writes fail closed without a hash-valid runtime assignment or a bounded WorkUnitContract covering every requested output. ${recovery}`,
        { ROLE: acRole || 'this role', TARGETS: targets, RECOVERY: recovery }));
    }
    return null;
  }
  if (!inSubagent) {
    if (isMaintenancePhase(state, (state as Record<string, unknown>).mode)) {
      return deny(block('run-team-maintenance-contract',
        'Run-team enforcement gate: maintenance writes fail closed when the hook cannot resolve a spawned worker with a valid parent-published WorkUnitContract. No unattributed write was made; bind the bounded quick-fix claim and exact allowlist before retrying.'));
    }
    // An identity-rejected claim is a fact about the CLAIM FILE, not about the
    // spawn, and this clause used to draw the opposite conclusion from it. It
    // asserted "Respawning will NOT fix this" and prescribed two remedies in its
    // place; all three statements are false, measured against the population the
    // `foreign-run-claim` demotion leaves behind (residue is diagnosed as
    // `foreign-run-claim` and never reaches this arm, so what is left is a claim
    // that really is THIS run's):
    //   - A REPLACEMENT BINDS. A claim is stamped from the run's own frozen
    //     identity, never from live state, so a fresh spawn for the same role is
    //     stamped with exactly what the ledger froze. Measured ALLOW in all three
    //     constructible drift shapes — a claim drifted away from an agreeing
    //     ledger, a stray `runId` inside a claim filed in this run's directory,
    //     and the shape the old sentence literally described (claim equal to the
    //     LIVE fingerprint while the ledger froze another) — and
    //     `refuseOccupiedRole` does not see a rejected claim as a live rival, so
    //     the Codex spawn path binds the replacement too.
    //   - `reconcileRunIdentityDrift` CANNOT repair either drift shape. Its
    //     backfill only fills a MISSING ledger fingerprint, and a ledger with no
    //     fingerprint produces no mismatch to diagnose in the first place; its
    //     other half needs TWO runs holding live claims, which a single drifted
    //     run never satisfies. Measured: a no-op that leaves the ledger exactly
    //     as it found it.
    //   - When that other half DOES fire it is destructive rather than idle. It
    //     sorts by `runEvidenceScore` with recency only breaking ties, so an
    //     OLDER run can win outright; `currentRunId` is re-pointed to it and every
    //     loser is released and transitioned to `failed`. Measured: the run the
    //     write came from settled `failed`/`agent-failed` while a stale sibling
    //     became current. Prescribing it as the FIRST remedy for a drifted claim
    //     pointed at that outcome.
    // So the clause is now pure DIAGNOSIS — the fingerprints, which were always
    // its real value, and the two things that are not the remedy — and it carries
    // no remedy of its own. It also LEADS the paragraph instead of trailing it,
    // because the arm below is the only thing that knows whether the reader is
    // the child or the orchestrator and whether the run can be written in at all;
    // putting the diagnosis first is what lets every render still END in an
    // action. A remedy here could not be right on more than one arm: "a fresh
    // spawn binds" is true on the open arm and false on the closed one, which is
    // the same adjacent-contradiction defect the old clause had, reversed.
    const driftReason = unresolvedDiagnosis
      && (unresolvedDiagnosis.reason === 'fingerprint-mismatch' || unresolvedDiagnosis.reason === 'run-id-mismatch')
      ? `DIAGNOSIS: a role claim for \`${unresolvedDiagnosis.role || 'this role'}\` exists under run \`${unresolvedDiagnosis.runId || '<unknown>'}\` but was rejected (${unresolvedDiagnosis.reason}; claim \`${unresolvedDiagnosis.claimFingerprint || 'none'}\` vs run \`${unresolvedDiagnosis.ledgerFingerprint || 'none'}\`, live \`${unresolvedDiagnosis.liveFingerprint || 'none'}\`). That claim was stamped with a different identity than this run froze, so THIS thread can never bind it. Switching to main-agent mode is not the remedy, and neither is waiting for a later SessionStart: that pass cannot repair a drifted claim, and in the one shape where it does act it re-points \`currentRunId\` at whichever run carries more orchestration evidence — not the newest — and settles every other live run as \`failed\`, this one included. Do the following instead. `
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
    //
    // THREE-VALUED, because the boolean it used to ask cannot say the third
    // thing. `runLedgerAdmitsClaims` answers `true` for a ledger it merely could
    // not READ — deliberately, since its other consumer is a gate over a child's
    // life — so an illegible ledger fell past this probe and rendered the OPEN
    // arm. Measured over this deny's whole branching space (child|parent ×
    // open|closed|illegible × drift|no-drift): 12 combinations collapsed to 8
    // distinct renders, and all four illegible cells were byte-identical to their
    // OPEN twins. A run whose ledger is a truncated file was therefore told to
    // retry in two seconds, or to spawn the owning role — while every claim mint,
    // every resume and every settlement against it returns `ledger-corrupt`.
    const ledgerAdmission = stateRunId
      ? runLedgerClaimAdmission(projectRoot, stateRunId)
      : 'admits';
    const closedLedger = stateRunId && ledgerAdmission === 'closed'
      ? runLedgerStatusRecord(projectRoot, stateRunId)
      : null;
    const illegibleLedger = ledgerAdmission === 'unknown';
    // Stated once, consumed by both closed arms: the two used to be able to
    // disagree about a fact neither of them owns.
    const closedRunClause = closedLedger
      ? `the run ledger for \`${stateRunId}\` is \`${closedLedger.status || 'unreadable'}\`${closedLedger.outcome ? ` (${closedLedger.outcome})` : ''}, which admits NO claim from any child`
      : '';
    // The illegible twin, on the same footing. `runLedgerStatusRecord` is not
    // consulted: it reads the same unreadable file and answers `null`, which is
    // what "unreadable" already says.
    const illegibleRunClause = illegibleLedger
      ? `the run ledger for \`${stateRunId}\` (\`.traffic-one/runs/${stateRunId}/run.json\`) cannot be read or parsed, so this run admits no claim, no resume and no settlement`
      : '';
    // `driftReason` is now purely ADDITIVE on every arm, which is what it always
    // was on the closed arm. It used to REPLACE the two respawn tails below, on
    // the ground that appending "Respawning will NOT fix this" to "must stop or
    // replace this child" rendered two contradictory orders in adjacent
    // sentences. The contradiction was real; the half that was wrong was the
    // diagnosis, not the tail. With the false assertion gone (see the measurement
    // on `driftReason` above — a replacement binds in every drift shape) there is
    // nothing left for the tails to contradict, and suppressing them cost the
    // drifted population the ONLY remedy that works: dropping a tail drops its
    // spawn contract with it, and the contract is exactly what makes a
    // replacement bind. So the two tails are unconditional on the OPEN arms.
    //
    // The ledger still selects the ARM, and neither non-admitting arm carries a
    // tail — not because drift silenced it, but because a role spawned into a
    // closed or unreadable run cannot bind a claim either. Each of those arms
    // ends in the remedy its own addressee can take, so no paragraph here names
    // a prohibition and no action.
    // Only the CAUSE clause varies with drift, and it must: an unconditional tail
    // may not tell a drifted child that its claim is "genuinely absent" when the
    // diagnosis two sentences later prints the claim's own fingerprint. The
    // ACTION is identical either way, which is the whole finding.
    const childRespawnTail = ` If the same deny repeats, ${driftReason ? 'this thread cannot bind the claim already on disk' : 'the claim is genuinely absent'} and the PARENT/orchestrator must stop or replace this child and retry the same role. ${CHILD_SPAWN_CONTRACT}`;
    const parentSpawnTail = ' Spawn the owning role, or message its already-live agent. On Codex, use the exact `task_name` contract (`quick_fix`, `senior_architect`, `senior_frontend`, `senior_backend`, `senior_reviewer`, `senior_tester`, or `senior_shipper`), the exact role model from the immutable run policy, and `fork_turns: "none"`; task name and line-zero `session_meta`, not encrypted prompt prose, carry the child identity while live hooks verify the actual model. On other hosts use the canonical Traffic One agent/type and substitute the actual role in the `[t1-role: <role>]` marker anywhere in a recognized task message.';
    // Resume legality, stated once and consumed by both closed arms.
    // `runLedgerTransitionAllowed` permits `blocked -> active` ONLY with the
    // recorded resume authorization and permits NOTHING out of `completed` or
    // `failed`. Measured on all four terminal shapes: `blocked`/test-cycle-cap
    // resumes, while `completed`/verified, `completed`/shipped and
    // `failed`/agent-failed are each refused `illegal-transition-<status>-to-
    // active`. The arms hedged the resume and always offered the mint, so nobody
    // was stranded — but for two of the three statuses the hedge was the whole
    // sentence, and the reader had no way to know which. Deliberately NOT a
    // status discriminator: the arms already PRINT the status one clause earlier,
    // so one sentence that is true for all three costs nothing, while branching
    // on status would multiply this deny's render space by three for a fact the
    // reader can already see.
    // Ordered so the ACTION is last. The "nothing can write until then" clause is
    // a consequence, and trailing it left all four closed cells ending on a
    // prohibition with their remedy a sentence back.
    const CLOSED_RUN_REMEDY = 'can resume the RUN only when the status above is `blocked` AND the user authorized another cycle, and nothing can write in this run until that happens. `completed` and `failed` runs cannot be reopened at all, so for those the only remedy is to mint a FRESH run and re-spawn this role there.';
    // The unreadable arm's remedy is not the closed one with a different noun.
    // Measured on a truncated `run.json`: the claim mint, a resume and a
    // settlement all return `unavailable('ledger-corrupt')`, so every action the
    // closed arm offers is unavailable here — and the file itself is a
    // runtime-owned run sidecar, which `runtime-sidecar-owner-gate` refuses to
    // let any agent create, edit, delete, replace or repair. Naming an agent-side
    // repair would therefore name a remedy this product denies. What IS available
    // is a USER action, and it works: removing the unreadable file restored the
    // run to `admits` and the next claim bound.
    const illegibleRunRemedy = `No agent may repair that file — every agent write to a run sidecar is refused — so the only thing that clears this is a USER restoring it from version control or deleting it, after which a fresh run can be minted. Report it and stop; \`node ~/.traffic-one/bin/doctor.cjs --run "${stateRunId}"\` captures the diagnosis to hand over.`;
    const childRecovery = illegibleLedger
      ? `This appears to be a spawned child, and its per-run role claim did not resolve because ${illegibleRunClause}. No write was made. Do not retry the edit, and do not stop or replace this child — a replacement cannot bind a claim either, and resuming or settling this run fails on the same unreadable file. ${illegibleRunRemedy}`
      : closedLedger
        ? `This appears to be a spawned child, and its per-run role claim did not resolve because ${closedRunClause}. No write was made. Do not retry the edit, and do not stop or replace this child — the replacement cannot bind a claim either, and looping on respawns is what this deny used to cause. The PARENT/orchestrator ${CLOSED_RUN_REMEDY}`
        : `This appears to be a spawned child, but its per-run role claim did not resolve. No write was made. Retry this exact write ONCE before anything else: while another hook holds this run's claims or model-observation lock the claim cannot be minted and this hook resolves NO role at all, and that clears in about two seconds. Do not self-assert a role in assistant prose — prose cannot create a claim.${childRespawnTail}`;
    // Same taxonomy as the closed child arm, re-addressed: here the reader IS the
    // orchestrator, so the remedy is second-person rather than a report of what
    // some third party does.
    const parentRecovery = illegibleLedger
      ? `You are the PARENT/orchestrator: do not edit owned implementation artifacts yourself. Spawning the owning role will not help here, because ${illegibleRunClause}. No write was made, and the role you spawn would land in this same deny. ${illegibleRunRemedy}`
      : closedLedger
        ? `You are the PARENT/orchestrator: do not edit owned implementation artifacts yourself. Spawning the owning role will not help here, because ${closedRunClause}. No write was made, and the role you spawn would land in this same deny — looping on respawns is what this deny used to cause. You ${CLOSED_RUN_REMEDY}`
        : `You are the PARENT/orchestrator: do not edit owned implementation artifacts yourself.${parentSpawnTail}`;
    const recovery = driftReason + (unresolvedChild ? childRecovery : parentRecovery);
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

  // EVERY TARGET IS JUDGED BEFORE ANY TARGET IS STAKED, in both ownership loops
  // below. Staking inside the per-target loop meant a two-target write took the
  // lease on target A and then denied on target B's scope conflict — so A stayed
  // locked to this session for the rest of the run on the strength of a write
  // that never landed, which is the same defect `recordFallbackClaims` closes
  // for the static rules, one loop further in. The check half still runs in the
  // judging pass (`record: false`), so a held path denies exactly where it did;
  // only the WRITE moves to the end, where the verdict is known.
  const stakeAll = (ctx: RunAgentContext, targets: readonly string[]): { target: string; holder?: string } | null => {
    for (const target of targets) {
      const decision = fallbackClaim(ctx, target);
      // A path taken between the judging pass and here — the same race the
      // single pass had, now with an answer instead of a silent overwrite.
      if (decision.blocked) return { target, holder: decision.holder };
    }
    return null;
  };
  const checkClaim = (ctx: RunAgentContext, target: string): { blocked: boolean; holder?: string } => (
    tryFallbackClaim(projectRoot, ctx, target, { record: false })
  );

  if (manifest && agentContext) {
    const mine = assignmentForContext(manifest, agentContext);
    const myKey = (mine && (mine.agentKey || mine.role)) || role;
    const unowned: string[] = [];
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
      const decision = checkClaim(agentContext, target);
      if (decision.blocked) {
        return deny(block('run-team-fallback-taken',
          `Run-team enforcement gate: \`${target}\` is outside every role's legacy scope and is already being written by \`${decision.holder}\` in this run. Coordinate so a single role owns this path. For a compiled run, change ArchitectureInputV1 and let runtime regenerate the exact WorkUnitContract; never add paths to assignments.json manually.`,
          { TARGET: target, HOLDER: String(decision.holder) }));
      }
      unowned.push(target);
    }
    const taken = stakeAll(agentContext, unowned);
    if (taken) {
      return deny(block('run-team-fallback-taken',
        `Run-team enforcement gate: \`${taken.target}\` is outside every role's legacy scope and is already being written by \`${taken.holder}\` in this run. Coordinate so a single role owns this path. For a compiled run, change ArchitectureInputV1 and let runtime regenerate the exact WorkUnitContract; never add paths to assignments.json manually.`,
        { TARGET: taken.target, HOLDER: String(taken.holder) }));
    }
    return null;
  }

  // Legacy fallback: no manifest. Use the regex ownership oracle, but route paths owned
  // by NO role through the dynamic claim instead of the former hard deadlock.
  const ownedByActiveRole = Boolean(agentContext)
    && ownershipTargets.every((target) => roleCanWriteFeatureSource(acRole, target));
  if (ownedByActiveRole) return null;

  const legacyUnowned: string[] = [];
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
      const decision = checkClaim(agentContext, target);
      if (decision.blocked) {
        return deny(block('run-team-fallback-taken',
          `Run-team enforcement gate: \`${target}\` is outside every Traffic One role's owned paths and is already being written by \`${decision.holder}\` in this run. Coordinate so a single role owns this path.`,
          { TARGET: target, HOLDER: String(decision.holder) }));
      }
      legacyUnowned.push(target);
    }
  }
  if (agentContext) {
    const taken = stakeAll(agentContext, legacyUnowned);
    if (taken) {
      return deny(block('run-team-fallback-taken',
        `Run-team enforcement gate: \`${taken.target}\` is outside every Traffic One role's owned paths and is already being written by \`${taken.holder}\` in this run. Coordinate so a single role owns this path.`,
        { TARGET: taken.target, HOLDER: String(taken.holder) }));
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
