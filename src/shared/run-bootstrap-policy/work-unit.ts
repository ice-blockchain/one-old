// src/shared/run-bootstrap-work-unit.ts
// Per-role WorkUnit composition: architect planning scope, run artifacts,
// and the bounded scope lists baked into each child bootstrap.

import {
  createWorkUnitContract,
  readCompiledArchitecture,
  readRuntimeAssignments,
  type ArchitectureRunSnapshotV1,
  type WorkUnitContractV1,
} from '../architecture-contract';
import {
  readVerificationContract,
  type VerificationContractV2,
} from '../verification-contract';

import {
  maintenanceDigestPath,
  quickFixDigestPath,
  safePart,
  type BootstrapMaterialRefV2,
  type BootstrapRuntimeContractsV1,
  type EnsureRunBootstrapOptions,
} from './types';
import {
  stringList,
} from './materials';

function boundedScopeList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const rel = item.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
    if (!rel
      || rel.startsWith('/')
      || rel.split('/').includes('..')
      || rel.includes('\0')
      || /[*?[\]{}]/.test(rel)
      || rel === '.traffic-one'
      || rel.startsWith('.traffic-one/')) return null;
    normalized.push(rel);
  }
  return [...new Set(normalized)].sort();
}

const ARCHITECT_MEMORY_OUTPUTS = [
  '.traffic-one/plan.md',
  '.traffic-one/product.md',
  '.traffic-one/stack.md',
  '.traffic-one/coding.md',
  '.traffic-one/security.md',
  '.traffic-one/known-issues.md',
  '.traffic-one/deployment.md',
  '.traffic-one/environment-setup.md',
  '.traffic-one/agent-log.md',
  '.traffic-one/.agentignore',
  '.traffic-one/api.md',
  '.traffic-one/database.md',
  '.traffic-one/schema.sql',
] as const;

function architectPlanningScope(runId: string): { outputs: string[]; allowlist: string[] } {
  const decision = `.traffic-one/decisions/${safePart(runId)}-architecture.md`;
  const outputs = [
    ...ARCHITECT_MEMORY_OUTPUTS,
    decision,
    `.traffic-one/runs/${safePart(runId)}/architecture-input-v1.json`,
    `.traffic-one/digests/${safePart(runId)}/architect.md`,
  ];
  return {
    outputs,
    allowlist: outputs,
  };
}

function roleRunArtifacts(
  runId: string,
  role: string,
  verification: VerificationContractV2 | null,
): string[] {
  const suffix = role.replace(/^senior-/, '');
  const outputs = [`.traffic-one/digests/${safePart(runId)}/${safePart(suffix)}.md`];
  if (role === 'senior-tester' && verification) {
    outputs.push(`.traffic-one/reports/qa/${safePart(runId)}/report-v2.json`);
  }
  if (role === 'senior-shipper') outputs.push('.traffic-one/deployments.jsonl');
  // The committed schema snapshot must track the migrations the backend
  // authors; it lived in nobody's scope, so the 4cu backend digested BLOCKED
  // on it and forced a replan. Same artifact class as the digests above.
  if (role === 'senior-backend') outputs.push('.traffic-one/schema.sql');
  return outputs;
}

// NOTE: workUnit bytes and contractHash are byte-identical to schemaVersion-1
// envelopes for identical inputs — rules/skills were always hashed here as
// {id, contentHash} pairs. That stability is why maintenance.json fallback
// markers (fallbackContractMatches) survive the v1→v2 envelope migration.
// Implementer/tester roles have no meaning without a compiled assignment: their
// whole scope IS the assignment.
export function roleRequiresCompiledAssignment(role: string): boolean {
  return ['senior-frontend', 'senior-backend', 'senior-tester'].includes(role);
}

// The subset of assignment-requiring roles the bootstrap-set preflight may
// SKIP when the compiled contract assigns them nothing — a capability profile
// may list a role (e.g. senior-backend on a project with a detected backend)
// that a frontend-only maintenance plan never assigns, and demanding an
// envelope for it denied PLAN_READY forever (observed run 1785623723274 on an
// existing-codebase project). senior-tester is deliberately NOT skippable:
// `verified` settlement requires tester evidence regardless of assignment, so
// a tester-less contract must stay a loud PLAN_READY failure instead of a
// silent post-accept deadlock where the tester can never spawn.
export function roleSkippableWithoutAssignment(role: string): boolean {
  return role === 'senior-frontend' || role === 'senior-backend';
}

export function workUnitForRole(
  cwd: string,
  runId: string,
  role: string,
  hostAgentType: string | null,
  resolved: { rules: BootstrapMaterialRefV2[]; skills: BootstrapMaterialRefV2[] },
  snapshot: ArchitectureRunSnapshotV1,
  options: Pick<
    EnsureRunBootstrapOptions,
    'boundedOutputs' | 'boundedAllowlist' | 'boundedAllowlistExclude'
  >,
  runtimeContracts?: BootstrapRuntimeContractsV1,
): WorkUnitContractV1 | null {
  const boundedMaintenance = options.boundedOutputs !== undefined
    && ['quick-fix', 'senior-frontend', 'senior-backend'].includes(role);
  if (boundedMaintenance) {
    const sourceOutputs = boundedScopeList(options.boundedOutputs);
    const sourceAllowlist = boundedScopeList(options.boundedAllowlist || options.boundedOutputs);
    const allowlistExclude = options.boundedAllowlistExclude === undefined
      || options.boundedAllowlistExclude.length === 0
      ? []
      : boundedScopeList(options.boundedAllowlistExclude);
    if (!sourceOutputs || !sourceAllowlist || allowlistExclude === null) return null;
    const digest = role === 'quick-fix'
      ? quickFixDigestPath(runId)
      : maintenanceDigestPath(runId, role);
    const outputs = [...sourceOutputs, digest];
    const allowlist = [...sourceAllowlist, digest];
    try {
      return createWorkUnitContract({
        runId,
        unitId: role === 'quick-fix'
          ? `${role}:bootstrap`
          : `${role}:bounded-maintenance`,
        trafficOneRole: role,
        hostAgentType,
        rules: resolved.rules.map(({ id, contentHash }) => ({ id, contentHash })),
        skills: resolved.skills.map(({ id, contentHash }) => ({ id, contentHash })),
        outputs,
        allowlist,
        allowlistExclude,
        architectureHash: snapshot.snapshotHash,
        verificationHash: snapshot.baselineHash,
      });
    } catch {
      return null;
    }
  }
  if (role === 'senior-architect') {
    // The architect's planning contract is hashed to the immutable
    // capability+baseline snapshot ONLY — never to compiled artifacts. Its
    // scope does not depend on them, and deriving its hash from
    // architecture-v1.json made the contract flip the instant a compile
    // persisted mid-completion: the still-live architect's envelope stopped
    // matching and every subsequent tool call was denied (observed 2cl — the
    // digest deny itself revoked the tools needed to fix the digest).
    const planning = architectPlanningScope(runId);
    try {
      return createWorkUnitContract({
        runId,
        unitId: `${role}:bootstrap`,
        trafficOneRole: role,
        hostAgentType,
        rules: resolved.rules.map(({ id, contentHash }) => ({ id, contentHash })),
        skills: resolved.skills.map(({ id, contentHash }) => ({ id, contentHash })),
        outputs: planning.outputs,
        allowlist: planning.allowlist,
        allowlistExclude: [],
        architectureHash: snapshot.snapshotHash,
        verificationHash: snapshot.baselineHash,
      });
    } catch {
      return null;
    }
  }
  const architecture = runtimeContracts?.architecture || readCompiledArchitecture(cwd, runId);
  const verification = runtimeContracts?.verification || readVerificationContract(cwd, runId);
  const runtimeAssignments = runtimeContracts?.assignments
    || (architecture && verification ? readRuntimeAssignments(cwd, runId) : null);
  const assignment = runtimeAssignments?.assignments.find((entry) => entry.role === role);
  const artifacts = roleRunArtifacts(runId, role, verification);
  const allowlist = [...new Set([...stringList(assignment?.scope.include), ...artifacts])].sort();
  const allowlistExclude = stringList(assignment?.scope.exclude);
  const outputs = [...new Set([...stringList(assignment?.scope.include), ...artifacts])].sort();
  const requiresAssignment = roleRequiresCompiledAssignment(role);
  if (
    !architecture
    || !verification
    || !runtimeAssignments
    || runtimeAssignments.architectureHash !== architecture.contractHash
    || runtimeAssignments.verificationHash !== verification.contractHash
  ) return null;
  if (requiresAssignment && !assignment) return null;
  const architectureHash = architecture.contractHash;
  const verificationHash = verification.contractHash;
  try {
    return createWorkUnitContract({
      runId,
      unitId: `${role}:bootstrap`,
      trafficOneRole: role,
      hostAgentType,
      rules: resolved.rules.map(({ id, contentHash }) => ({ id, contentHash })),
      skills: resolved.skills.map(({ id, contentHash }) => ({ id, contentHash })),
      outputs,
      allowlist,
      allowlistExclude,
      architectureHash,
      verificationHash,
    });
  } catch {
    return null;
  }
}
