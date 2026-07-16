// src/modules/plan-guard/plan-runteam.ts
// Run-team enforcement gate: when a project was onboarded with
// team.mode="subagents", feature-source writes must come from the spawned role
// session that owns the path. Returns a single deny reason (or null). Deny PROSE comes
// from skill/SKILL.md via skillBlock with verbatim fallbacks.

import { obj, type Rec } from '../../shared/obj';
import { isTestScopePath, roleCanWriteFeatureSource } from '../../shared/feature-source';
import { matchesScope } from '../../shared/scope';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import {
  activeAgentRole,
  assignmentForContext,
  captureClaimDebug,
  claimThreadRole,
  hasRunAgentState,
  hookSessionIdentity,
  isMaintenancePhase,
  isSubagentSession,
  legacyRunAgentContext,
  type RunManifest,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
  tryFallbackClaim,
  type RunAgentContext,
} from '../../shared/state';

type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;
const CANONICAL_TAILWIND_GLOBALS_PATH = 'packages/tailwind-config/src/globals.css';

export interface RunTeamArgs {
  host?: string;
  projectRoot: string;
  filePath: string;          // project-relative target path
  state: Rec;
  rawData: unknown;          // raw hook input, for run-claim session identity
  content?: string;
  writeTargetPaths?: string[];
  featureTargetPaths: string[];
  writingFeatureSource: boolean;
  writingFeatureSourceViaCommand: boolean;
  writingBuildArtifact?: boolean;
  writingBuildArtifactViaCommand?: boolean;
  recordFallbackClaims?: boolean;
  block: Block;
}

function isArchitectEmptyPackageBarrelTarget(filePath: string): boolean {
  return /^packages\/[^/]+\/src\/index\.ts$/.test(filePath);
}

function isEmptyBarrelContent(content: string): boolean {
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '')
    .trim();
  return stripped === '' || stripped === 'export {}' || stripped === 'export {};';
}

function isArchitectScaffoldBarrelWrite(role: string | null, targets: string[], content: string | undefined): boolean {
  return role === 'senior-architect'
    && targets.length > 0
    && targets.every(isArchitectEmptyPackageBarrelTarget)
    && isEmptyBarrelContent(content || '');
}

function isArchitectTailwindGlobalsTarget(filePath: string): boolean {
  return filePath === CANONICAL_TAILWIND_GLOBALS_PATH || filePath === 'packages/tailwind-config/globals.css';
}

function isArchitectScaffoldBaselineWrite(role: string | null, targets: string[], content: string | undefined): boolean {
  if (isArchitectScaffoldBarrelWrite(role, targets, content)) return true;
  return role === 'senior-architect'
    && targets.length > 0
    && targets.every(isArchitectTailwindGlobalsTarget);
}

function isArchitectScaffoldReservation(role: string | null | undefined, target: string): boolean {
  return role === 'senior-architect'
    && (isArchitectEmptyPackageBarrelTarget(target) || isArchitectTailwindGlobalsTarget(target));
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

// Returns the run-team deny reason, or null when the write is allowed.
export function runTeamEnforcementViolation(args: RunTeamArgs): string | null {
  const {
    projectRoot,
    filePath,
    state,
    rawData,
    content,
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
  const preManifest = readRunAssignmentsResilient(projectRoot, stateRunId);
  const assignedTargets = preManifest
    ? writeTargetPaths.filter((target) => preManifest.assignments.some((assignment) => matchesScope(target, assignment.scope)))
    : [];
  const writingRunTeamTarget = writingFeatureSource || Boolean(writingBuildArtifact) || assignedTargets.length > 0;
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
      'Run-team enforcement gate: implementation writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python -c`/`node -e` eval writes, `sed -i`, `rm`, `mv`, `cp`, `find -delete`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead. Run-state bookkeeping (heredocs targeting `.traffic-one/digests/`, `fix-cycles/`, or `runs/`) is exempt.'));
  }

  const nativeAnonymousDevinWrite = args.host === 'windsurf'
    && obj(rawData)?.hook_event_name === 'PreToolUse'
    && !obj(rawData)?.agent_action_name;
  const agentContext = resolveRunAgentContext(projectRoot, state, rawData, {
    claimPending: true,
    allowSoleAnonymousPending: nativeAnonymousDevinWrite,
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

  // DIAGNOSTIC (best-effort): record the raw payload of every feature-source write
  // attempt in subagents mode so we can see how Claude agent-teams role agents
  // identify when their claim fails to bind (see project_agent_teams_claim_deadlock).
  // Does NOT affect the decision below.
  captureClaimDebug(projectRoot, typeof state.currentRunId === 'string' ? state.currentRunId : null, 'runteam-write', rawData, {
    filePath,
    filePaths: writeTargetPaths,
    resolved: Boolean(agentContext),
    role,
    runId: agentContext && agentContext.runId != null ? String(agentContext.runId) : null,
  });
  if (!inSubagent) {
    // Maintenance fail-open. Run-team coordinates PARALLEL BUILD implementers via
    // the architect's per-run assignments manifest; in maintenance the build is
    // done and edits come from a single bounded quick-fix worker. On hosts where
    // run-claim activation is unreliable (claims stay `pending`, so the worker's
    // write resolves to no context and lands here), failing closed would deadlock
    // every legitimate maintenance edit. So in maintenance, allow an unattributed
    // write rather than block it — delegation is guided by the post-build triage
    // directive, not this build-time gate. (When a claim DOES resolve, the scope
    // checks below still run, so a real feature run stays coordinated.)
    if (isMaintenancePhase(state, (state as Record<string, unknown>).mode)) return null;
    return deny(block('run-team-not-subagent',
      `Run-team enforcement gate: this project was onboarded with \`team.mode="subagents"\`, so feature-source and assigned build-artifact writes must come from a spawned Traffic One role session with a per-agent run claim, not ${role}. If you are the PARENT/orchestrator: do not edit owned implementation artifacts yourself — spawn (or message) the owning role. If you ARE a spawned role session whose claim did not resolve: state your role explicitly (reply or note "Traffic One senior-<role> role, run <runId>") and retry this same edit — the gate re-reads your transcript and stakes the claim on the next attempt. Do NOT fall back to delegating from inside a worker or rewriting team preferences.`,
      { ROLE: role }));
  }

  const scaffoldTargets = featureTargetPaths.length > 0 ? featureTargetPaths : writeTargetPaths;
  if (isArchitectScaffoldBaselineWrite(acRole, scaffoldTargets, content)) return null;

  // Preferred path: explicit per-run assignment manifest authored by the architect.
  // Ownership is by assigned SCOPE, not by guessed path-kind — stack-agnostic.
  const runId = agentContext && agentContext.runId != null ? String(agentContext.runId) : null;
  // Resilient: tolerates a run-id split (assignments written under a stray id) so the
  // gate doesn't block every implementer write when the orchestrator's run-id diverges
  // from currentRunId. See readRunAssignmentsResilient.
  const manifest = (runId === stateRunId ? preManifest : readRunAssignmentsResilient(projectRoot, runId)) || preManifest;
  const ownershipTargets = featureTargetPaths.length > 0
    ? featureTargetPaths
    : (assignedTargets.length > 0 ? assignedTargets : writeTargetPaths);

  // Tester test-path overlay: tests are interleaved inside implementer scopes
  // (the assignments manifest only carries frontend/backend), so a tester write
  // whose EVERY target is a test-scope path is owned by the tester regardless
  // of which assignment covers the surrounding directory. Deliberately
  // all-or-nothing: a patch mixing a test file with real feature source falls
  // through and still denies on the source target.
  if (acRole === 'senior-tester' && ownershipTargets.length > 0
    && ownershipTargets.every(isTestScopePath)) return null;

  if (manifest && agentContext) {
    const mine = assignmentForContext(manifest, agentContext);
    const myKey = (mine && (mine.agentKey || mine.role)) || role;
    for (const target of ownershipTargets) {
      if (mine && matchesScope(target, mine.scope)) continue; // inside my scope -> allowed
      const conflict = manifest.assignments.find((a) => a !== mine
        && matchesScope(target, a.scope)
        && !isArchitectScaffoldReservation(a.role, target));
      if (conflict) {
        return deny(block('run-team-scope-conflict',
          `Run-team enforcement gate: \`${target}\` is in \`${conflict.agentKey || conflict.role}\`'s assigned scope for this run, not \`${myKey}\`'s. Each subagent writes only within its own assignment in \`.traffic-one/runs/<runId>/assignments.json\`. Let the owning role write this file, or split the patch by assignment.`,
          { TARGET: target, OWNER: String(conflict.agentKey || conflict.role), ROLE: String(myKey) }));
      }
      // Outside every assignment -> dynamic first-write claim (no hard deadlock).
      const decision = fallbackClaim(agentContext, target);
      if (decision.blocked) {
        return deny(block('run-team-fallback-taken',
          `Run-team enforcement gate: \`${target}\` is outside every role's assigned scope and is already being written by \`${decision.holder}\` in this run. Coordinate so a single role owns this path, or add it to an assignment in \`.traffic-one/runs/<runId>/assignments.json\`.`,
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
