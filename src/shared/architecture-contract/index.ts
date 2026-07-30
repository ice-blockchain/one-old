// src/shared/architecture-contract/index.ts
// Runtime assignments + WorkUnit contracts, plus the re-export barrel that
// keeps every original './architecture-contract' import specifier working.

import * as fs from 'fs';
import * as path from 'path';
import {
  detectFrontendFramework,
} from '../capabilities';
import { readJson, writeJson } from '../fsjson';
import { obj, type Rec } from '../obj';
import { effectiveLegacyRunStatus } from '../run-settlement';
import { matchesPattern } from '../scope';
import { withProjectStateLock } from '../state/project-state-lock';

import {
  WORK_UNIT_CONTRACT_SCHEMA_VERSION,
  type ArchitectureInputV1,
  type CompiledArchitectureV1,
  type RuntimeAssignmentEntryV1,
  type RuntimeAssignmentsV1,
  type WorkUnitContractV1,
} from './types';
import {
  MEMORY_DIR,
  contractHash,
  normalizeRelative,
  stableContractJson,
} from './core';
import {
  validateArchitectureInput,
} from './validate';
import {
  readCompiledArchitecture,
} from './compile';

export function runtimeAssignmentsPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'assignments.json');
}

function assignmentOutputs(
  architecture: CompiledArchitectureV1,
  role: string,
): string[] {
  const outputs = [
    ...architecture.modules
      .filter((module) => module.ownerRole === role)
      .map((module) => module.output),
    ...(role === 'senior-frontend' ? architecture.entrypoints : []),
    ...(architecture.scaffoldOutputs || [])
      .filter((output) => output.ownerRole === role)
      .map((output) => output.path),
  ];
  return [...new Set(outputs)].sort();
}

function runtimeAssignmentForRole(
  architecture: CompiledArchitectureV1,
  role: string,
): RuntimeAssignmentEntryV1 | null {
  // Runtime assignments are a closed set. Broad source/test roots would let a
  // child create outputs absent from the compiled plan and silently bypass
  // re-planning. Every writable path therefore comes from a compiled module,
  // entrypoint, scaffold, test, or test-infrastructure output.
  const include = assignmentOutputs(architecture, role);
  if (include.length === 0) return null;
  return {
    role,
    summary: role === 'senior-tester'
      ? 'Runtime-owned test and test-infrastructure outputs'
      : 'Runtime-owned compiled architecture and scaffold outputs',
    scope: {
      include,
      exclude: [],
    },
  };
}

export function buildRuntimeAssignments(
  architecture: CompiledArchitectureV1,
  verificationHash: string,
): RuntimeAssignmentsV1 {
  if (!verificationHash.trim()) throw new Error('verificationHash is required');
  const roleOrder = ['senior-frontend', 'senior-backend', 'senior-tester'];
  const assignments = roleOrder
    .filter((role) => architecture.profile.roles.includes(role))
    .map((role) => runtimeAssignmentForRole(architecture, role))
    .filter((entry): entry is RuntimeAssignmentEntryV1 => Boolean(entry));
  const canonical = {
    version: 1 as const,
    schemaVersion: 1 as const,
    runId: architecture.runId,
    createdBy: 'traffic-one-runtime' as const,
    architectureHash: architecture.contractHash,
    verificationHash,
    assignments,
  };
  return { ...canonical, assignmentsHash: contractHash(canonical) };
}

export function readRuntimeAssignments(
  projectRoot: string,
  runId: string,
): RuntimeAssignmentsV1 | null {
  const raw = readJson<RuntimeAssignmentsV1 | null>(runtimeAssignmentsPath(projectRoot, runId), null);
  if (!raw
    || raw.version !== 1
    || raw.schemaVersion !== 1
    || raw.runId !== runId
    || raw.createdBy !== 'traffic-one-runtime'
    || !Array.isArray(raw.assignments)
    || typeof raw.assignmentsHash !== 'string') return null;
  const { assignmentsHash: observed, ...canonical } = raw;
  if (contractHash(canonical) !== observed) return null;
  const architecture = readCompiledArchitecture(projectRoot, runId);
  if (!architecture
    || architecture.contractHash !== raw.architectureHash
    || !raw.verificationHash) return null;
  const verification = readJson<Record<string, unknown> | null>(
    path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'verification-v2.json'),
    null,
  );
  if (!verification
    || verification.schemaVersion !== 2
    || verification.runId !== runId
    || verification.architectureHash !== architecture.contractHash
    || typeof verification.contractHash !== 'string') return null;
  const { contractHash: observedVerificationHash, ...verificationCanonical } = verification;
  if (contractHash(verificationCanonical) !== observedVerificationHash
    || raw.verificationHash !== observedVerificationHash) return null;
  const expected = buildRuntimeAssignments(architecture, observedVerificationHash);
  if (stableContractJson(raw) !== stableContractJson(expected)) return null;
  for (const assignment of raw.assignments) {
    if (!assignment
      || !architecture.profile.roles.includes(assignment.role)
      || !assignment.scope
      || !Array.isArray(assignment.scope.include)
      || assignment.scope.include.length === 0
      || !assignment.scope.include.every((entry) => typeof entry === 'string' && Boolean(normalizeRelative(entry)))
      || !Array.isArray(assignment.scope.exclude)
      || !assignment.scope.exclude.every((entry) => typeof entry === 'string' && Boolean(normalizeRelative(entry)))) {
      return null;
    }
  }
  return raw;
}

export function publishRuntimeAssignments(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
  verificationHash: string,
): RuntimeAssignmentsV1 {
  const candidate = buildRuntimeAssignments(architecture, verificationHash);
  return withProjectStateLock(projectRoot, () => {
    writeJson(runtimeAssignmentsPath(projectRoot, architecture.runId), candidate);
    const persisted = readRuntimeAssignments(projectRoot, architecture.runId);
    if (!persisted || persisted.assignmentsHash !== candidate.assignmentsHash) {
      throw new Error('runtime assignments could not be persisted atomically');
    }
    return persisted;
  });
}


export function createWorkUnitContract(input: Omit<WorkUnitContractV1, 'schemaVersion' | 'contractHash'>): WorkUnitContractV1 {
  if (!input.trafficOneRole.trim()) throw new Error('trafficOneRole must be non-null');
  if (!input.runId.trim() || !input.unitId.trim()) throw new Error('runId and unitId are required');
  const canonical = {
    schemaVersion: WORK_UNIT_CONTRACT_SCHEMA_VERSION,
    ...input,
    rules: [...input.rules].sort((a, b) => a.id.localeCompare(b.id)),
    skills: [...input.skills].sort((a, b) => a.id.localeCompare(b.id)),
    outputs: [...new Set(input.outputs)].sort(),
    allowlist: [...new Set(input.allowlist)].sort(),
    allowlistExclude: [...new Set(input.allowlistExclude)].sort(),
  };
  const missing = canonical.outputs.filter((output) => (
    !canonical.allowlist.some((pattern) => matchesPattern(output, pattern))
    || canonical.allowlistExclude.some((pattern) => matchesPattern(output, pattern))
  ));
  if (missing.length) throw new Error(`allowlist does not cover: ${missing.join(', ')}`);
  return { ...canonical, contractHash: contractHash(canonical) };
}

export function validateWorkUnitContract(value: unknown): value is WorkUnitContractV1 {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<WorkUnitContractV1>;
  if (raw.schemaVersion !== WORK_UNIT_CONTRACT_SCHEMA_VERSION
    || typeof raw.runId !== 'string'
    || typeof raw.unitId !== 'string'
    || typeof raw.trafficOneRole !== 'string'
    || (raw.hostAgentType !== null && typeof raw.hostAgentType !== 'string')
    || !Array.isArray(raw.rules)
    || !Array.isArray(raw.skills)
    || !Array.isArray(raw.outputs)
    || !Array.isArray(raw.allowlist)
    || !Array.isArray(raw.allowlistExclude)
    || typeof raw.architectureHash !== 'string'
    || typeof raw.verificationHash !== 'string'
    || typeof raw.contractHash !== 'string'
    || !raw.rules.every((entry) => (
      entry && typeof entry.id === 'string' && typeof entry.contentHash === 'string'
    ))
    || !raw.skills.every((entry) => (
      entry && typeof entry.id === 'string' && typeof entry.contentHash === 'string'
    ))
    || !raw.outputs.every((entry) => typeof entry === 'string')
    || !raw.allowlist.every((entry) => typeof entry === 'string')
    || !raw.allowlistExclude.every((entry) => typeof entry === 'string')) return false;
  try {
    const rebuilt = createWorkUnitContract({
      runId: raw.runId,
      unitId: raw.unitId,
      trafficOneRole: raw.trafficOneRole,
      hostAgentType: raw.hostAgentType,
      rules: raw.rules,
      skills: raw.skills,
      outputs: raw.outputs,
      allowlist: raw.allowlist,
      allowlistExclude: raw.allowlistExclude,
      architectureHash: raw.architectureHash,
      verificationHash: raw.verificationHash,
    });
    return stableContractJson(rebuilt) === stableContractJson(raw);
  } catch {
    return false;
  }
}


export function legacyCustomBackendMigration(
  projectRoot: string,
  state: unknown,
): { state: Rec; changed: boolean; ambiguous: boolean; message?: string } {
  const current = obj(state) || {};
  if (current.stack !== 'custom-backend' || current.frontend !== 'react-vite') {
    return { state: current, changed: false, ambiguous: false };
  }

  const currentRunId = typeof current.currentRunId === 'string'
    ? current.currentRunId.trim()
    : typeof current.currentRunId === 'number' && Number.isFinite(current.currentRunId)
      ? String(Math.trunc(current.currentRunId))
      : '';
  if (currentRunId) {
    const runRoot = path.join(projectRoot, MEMORY_DIR, 'runs', currentRunId);
    const settlementFile = path.join(runRoot, 'settlement-v2.json');
    const ledgerFile = path.join(runRoot, 'run.json');
    let lifecycleStatus = '';
    let lifecycleValid = false;
    if (fs.existsSync(settlementFile)) {
      const raw = readJson<Rec | null>(settlementFile, null);
      if (raw
        && raw.schemaVersion === 2
        && raw.runId === currentRunId
        && typeof raw.status === 'string'
        && typeof raw.runtimeVersion === 'string'
        && typeof raw.minimumRuntimeVersion === 'string'
        && Number.isInteger(raw.activeClaims)
        && Number(raw.activeClaims) >= 0
        && Array.isArray(raw.incompleteChecks)
        && raw.incompleteChecks.every((item) => typeof item === 'string')
        && Number.isInteger(raw.revision)
        && Number(raw.revision) >= 1
        && typeof raw.updatedAt === 'string'
        && typeof raw.settlementHash === 'string') {
        const { settlementHash: observed, ...canonical } = raw;
        if (contractHash(canonical) === observed) {
          lifecycleStatus = raw.status;
          lifecycleValid = [
            'planned', 'active', 'code-delivered', 'validating',
            'verified', 'failed', 'blocked',
          ].includes(lifecycleStatus);
          const fallback = obj(raw.fallback);
          if (fallback && !['pending', 'completed', 'not-allowed'].includes(String(fallback.state))) {
            lifecycleValid = false;
          }
          if (lifecycleStatus === 'verified' && (
            Number(raw.activeClaims) > 0
            || raw.incompleteChecks.length > 0
            || fallback?.state === 'pending'
          )) lifecycleValid = false;
        }
      }
    } else if (fs.existsSync(ledgerFile)) {
      const raw = readJson<Rec | null>(ledgerFile, null);
      const rawRunId = typeof raw?.runId === 'string'
        ? raw.runId
        : typeof raw?.runId === 'number' && Number.isFinite(raw.runId)
          ? String(Math.trunc(raw.runId))
          : '';
      if (raw
        && rawRunId === currentRunId
        && typeof raw.status === 'string'
        && ['planned', 'active', 'completed', 'failed', 'blocked'].includes(raw.status)) {
        lifecycleStatus = effectiveLegacyRunStatus(raw);
        lifecycleValid = [
          'planned', 'active', 'completed', 'failed', 'blocked',
        ].includes(lifecycleStatus);
      }
    }
    if (!lifecycleValid) {
      return {
        state: current,
        changed: false,
        ambiguous: true,
        message: 'current run lifecycle evidence is missing or corrupt; migration is fail-closed',
      };
    }
    if (!['verified', 'completed', 'failed', 'blocked'].includes(lifecycleStatus)) {
      return {
        state: current,
        changed: false,
        ambiguous: true,
        message: `current run is ${lifecycleStatus}; migration is forbidden mid-run`,
      };
    }
  }

  const frontend = detectFrontendFramework(projectRoot, current);
  if (frontend.hasWebUi) {
    return {
      state: current,
      changed: false,
      ambiguous: true,
      message: `frontend evidence exists (${frontend.evidence.join(', ') || frontend.frontend}); doctor confirmation is required`,
    };
  }
  return { state: { ...current, frontend: 'none' }, changed: true, ambiguous: false };
}

export {
  ARCHITECTURE_INPUT_SCHEMA_VERSION,
  ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION,
  ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION,
  ARCHITECTURE_SCAN_MAX_FILES,
  COMPILED_ARCHITECTURE_SCHEMA_VERSION,
  WORK_UNIT_CONTRACT_SCHEMA_VERSION,
  type ArchitectureBaselineV1,
  type ArchitectureExceptionRequestV1,
  type ArchitectureI18nInputV1,
  type ArchitectureInputV1,
  type ArchitectureModuleInputV1,
  type ArchitectureModuleKind,
  type ArchitectureRouteInputV1,
  type ArchitectureRunBaselineV1,
  type ArchitectureRunSnapshotV1,
  type ArchitectureValidationResult,
  type CompiledArchitectureModuleV1,
  type CompiledArchitectureOutputV1,
  type CompiledArchitectureV1,
  type CompiledI18nCatalogFormatV1,
  type CompiledI18nCatalogV1,
  type CompiledI18nContractV1,
  type CompiledOutputKindV1,
  type RuntimeAssignmentEntryV1,
  type RuntimeAssignmentsV1,
  type WorkUnitContractV1,
} from './types';
export {
  architectureI18nNamespaces,
  i18nScaffoldOutputs,
  profileHasUi,
  profileUsesReactI18n,
  resolveArchitectureI18n,
} from './i18n';
export {
  canonicalRoutePath,
  stableContractJson,
} from './core';
export {
  webPackageRoot,
} from './scaffold';
export {
  ensureScaffoldContent,
  scaffoldFileContent,
} from './scaffold-content';
export {
  validateArchitectureInput,
} from './validate';
export {
  architectureRunBaselinePath,
  architectureRunSnapshotPath,
  canonicalTrafficOneContextLink,
  captureArchitectureBaseline,
  contextAliasHash,
  isDeletableStrayArtifact,
  isScanSkippedPath,
  readArchitectureRunBaseline,
  readArchitectureRunSnapshot,
  scanSkipPredicate,
} from './baseline';
export {
  architectureInputPath,
  capabilityProfileForRun,
  capabilityStateForRun,
  compileArchitecture,
  compileArchitectureForRun,
  compiledArchitecturePath,
  ensureArchitectureRunSnapshot,
  persistCompiledArchitecture,
  readCompiledArchitecture,
} from './compile';
