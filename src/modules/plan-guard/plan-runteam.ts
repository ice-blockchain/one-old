// src/modules/plan-guard/plan-runteam.ts
// Run-team enforcement gate: when a project was onboarded with
// team.mode="subagents", feature-source writes must come from the spawned role
// session that owns the path. Returns a single deny reason (or null). Deny PROSE comes
// from skill/SKILL.md via skillBlock with verbatim fallbacks.

import { obj, type Rec } from '../../shared/obj';
import { roleCanWriteFeatureSource } from '../../shared/feature-source';
import { matchesScope } from '../../shared/scope';
import {
  activeAgentRole,
  assignmentForContext,
  hasRunAgentState,
  isMaintenancePhase,
  isSubagentSession,
  legacyRunAgentContext,
  readRunAssignments,
  resolveRunAgentContext,
  tryFallbackClaim,
  type RunAgentContext,
} from '../../shared/state';

type Vars = Record<string, string | number | null | undefined>;
type Block = (name: string, fallback: string, vars?: Vars) => string;

export interface RunTeamArgs {
  projectRoot: string;
  filePath: string;          // project-relative target path
  state: Rec;
  rawData: unknown;          // raw hook input, for run-claim session identity
  featureTargetPaths: string[];
  writingFeatureSource: boolean;
  writingFeatureSourceViaCommand: boolean;
  block: Block;
}

// Returns the run-team deny reason, or null when the write is allowed.
export function runTeamEnforcementViolation(args: RunTeamArgs): string | null {
  const { projectRoot, filePath, state, rawData, featureTargetPaths, writingFeatureSource, writingFeatureSourceViaCommand, block } = args;
  const team = obj(state.team);
  if (!writingFeatureSource || !team || team.mode !== 'subagents') return null;

  const suffix = block('run-team-suffix',
    'If subagents are genuinely unavailable or the user changes their mind, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting local Traffic One preferences; `team.source="unavailable"` does not bypass `team.mode="subagents"`.');
  const deny = (reason: string): string => `${reason} ${suffix}`;

  // Shell writes can't be ownership-verified from a command line.
  if (writingFeatureSourceViaCommand) {
    return deny(block('run-team-shell',
      'Run-team enforcement gate: feature-source writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python`, `node`, `perl`, `sed -i`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead.'));
  }

  const agentContext = resolveRunAgentContext(projectRoot, state, rawData, { claimPending: true })
    || (!hasRunAgentState(projectRoot, state) ? legacyRunAgentContext(state) : null);
  const acRole = agentContext && typeof agentContext.role === 'string' ? agentContext.role : null;
  const inSubagent = Boolean(agentContext) || (!hasRunAgentState(projectRoot, state) && isSubagentSession(state));
  const role = acRole || activeAgentRole(state) || 'main agent';
  const ownershipTargets = featureTargetPaths.length > 0 ? featureTargetPaths : [filePath];

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
      `Run-team enforcement gate: this project was onboarded with \`team.mode="subagents"\`, so feature-source writes must come from a spawned Traffic One role session with a per-agent run claim, not ${role}. Spawn the appropriate role first; senior-frontend and senior-backend ownership is enforced by \`roleCanWriteFeatureSource\`.`,
      { ROLE: role }));
  }

  // Preferred path: explicit per-run assignment manifest authored by the architect.
  // Ownership is by assigned SCOPE, not by guessed path-kind — stack-agnostic.
  const runId = agentContext && agentContext.runId != null ? String(agentContext.runId) : null;
  const manifest = runId ? readRunAssignments(projectRoot, runId) : null;

  if (manifest && agentContext) {
    const mine = assignmentForContext(manifest, agentContext);
    const myKey = (mine && (mine.agentKey || mine.role)) || role;
    for (const target of ownershipTargets) {
      if (mine && matchesScope(target, mine.scope)) continue; // inside my scope -> allowed
      const conflict = manifest.assignments.find((a) => a !== mine && matchesScope(target, a.scope));
      if (conflict) {
        return deny(block('run-team-scope-conflict',
          `Run-team enforcement gate: \`${target}\` is in \`${conflict.agentKey || conflict.role}\`'s assigned scope for this run, not \`${myKey}\`'s. Each subagent writes only within its own assignment in \`.traffic-one/runs/<runId>/assignments.json\`. Let the owning role write this file, or split the patch by assignment.`,
          { TARGET: target, OWNER: String(conflict.agentKey || conflict.role), ROLE: String(myKey) }));
      }
      // Outside every assignment -> dynamic first-write claim (no hard deadlock).
      const decision = tryFallbackClaim(projectRoot, agentContext, target);
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
      const decision = tryFallbackClaim(projectRoot, agentContext, target);
      if (decision.blocked) {
        return deny(block('run-team-fallback-taken',
          `Run-team enforcement gate: \`${target}\` is outside every Traffic One role's owned paths and is already being written by \`${decision.holder}\` in this run. Coordinate so a single role owns this path.`,
          { TARGET: target, HOLDER: String(decision.holder) }));
      }
    }
  }
  return null;
}
