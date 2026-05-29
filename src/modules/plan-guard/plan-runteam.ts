// src/modules/plan-guard/plan-runteam.ts
// Run-team enforcement gate: when a project was onboarded with
// team.mode="subagents", feature-source writes must come from the spawned role
// session that owns the path. Returns a single deny reason (or null). Deny PROSE comes
// from skill/SKILL.md via skillBlock with verbatim fallbacks.

import { obj, type Rec } from '../../shared/obj';
import {
  roleCanWriteFeatureSource,
  subagentMayWriteFeatureSource,
} from '../../shared/feature-source';
import {
  activeAgentRole,
  hasRunAgentState,
  isSubagentSession,
  legacyRunAgentContext,
  resolveRunAgentContext,
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

  const agentContext = resolveRunAgentContext(projectRoot, state, rawData, { claimPending: true })
    || (!hasRunAgentState(projectRoot, state) ? legacyRunAgentContext(state) : null);
  const acRole = agentContext && typeof agentContext.role === 'string' ? agentContext.role : null;
  const ownershipTargets = featureTargetPaths.length > 0 ? featureTargetPaths : [filePath];
  const useLegacySubagentFallback = !agentContext && !hasRunAgentState(projectRoot, state);

  const mayWrite = (target: string): boolean => (
    agentContext
      ? subagentMayWriteFeatureSource(state, target, agentContext)
      : useLegacySubagentFallback && subagentMayWriteFeatureSource(state, target, null)
  );
  const agentMayWriteFeatureTargets = featureTargetPaths.length > 0
    ? featureTargetPaths.every(mayWrite)
    : mayWrite(filePath);

  if (agentMayWriteFeatureTargets && !writingFeatureSourceViaCommand) return null;

  const role = acRole || activeAgentRole(state) || 'main agent';
  const inSubagent = Boolean(agentContext) || (!hasRunAgentState(projectRoot, state) && isSubagentSession(state));
  const ownedBySome = ownershipTargets.every((target) => (
    roleCanWriteFeatureSource('senior-frontend', target)
    || roleCanWriteFeatureSource('senior-backend', target)
  ));
  const ownedByActiveRole = Boolean(agentContext)
    && ownershipTargets.every((target) => roleCanWriteFeatureSource(acRole, target));

  let reason: string;
  if (writingFeatureSourceViaCommand) {
    reason = block('run-team-shell',
      'Run-team enforcement gate: feature-source writes via shell command (`>`, `>>`, `tee`, `cat <<`, `python`, `node`, `perl`, `sed -i`) are denied because the hook cannot verify role ownership from a shell line — use the role-scoped Write/Edit tools instead.');
  } else if (!inSubagent) {
    reason = block('run-team-not-subagent',
      `Run-team enforcement gate: this project was onboarded with \`team.mode="subagents"\`, so feature-source writes must come from a spawned Traffic One role session with a per-agent run claim, not ${role}. Spawn the appropriate role first; senior-frontend and senior-backend ownership is enforced by \`roleCanWriteFeatureSource\`.`,
      { ROLE: role });
  } else if (!ownedBySome) {
    reason = block('run-team-not-owned',
      `Run-team enforcement gate: the file \`${filePath}\` is not under any Traffic One role's owned path patterns (senior-frontend: \`apps/*/src|app/\` + \`packages/(ui|i18n|utils)/src/\`; senior-backend: \`packages/(api-client|ws-client|utils)/src/\`, \`services/*/src/\`, \`apps/*/src/(services|store)/\`). If this is a legitimate project layout (e.g. root \`src/\`), the role-pattern definitions in \`roleCanWriteFeatureSource\` need to be extended.`,
      { FILEPATH: filePath });
  } else if (agentContext && !ownedByActiveRole) {
    reason = block('run-team-wrong-role',
      `Run-team enforcement gate: the active Traffic One role \`${role}\` does not own \`${ownershipTargets.join(', ')}\`. Use the role that owns the path, or split the patch by role ownership.`,
      { ROLE: role, TARGETS: ownershipTargets.join(', ') });
  } else {
    reason = block('run-team-unexpected',
      `Run-team enforcement gate: unexpected denial for ${role} writing \`${filePath}\`. This is a gate bug — please report.`,
      { ROLE: role, FILEPATH: filePath });
  }

  const suffix = block('run-team-suffix',
    'If subagents are genuinely unavailable or the user changes their mind, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting local Traffic One preferences; `team.source="unavailable"` does not bypass `team.mode="subagents"`.');
  return `${reason} ${suffix}`;
}
