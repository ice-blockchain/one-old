// src/modules/plan-guard/plan-readiness/contracts.ts
// Run contracts: architecture-input validation, role scopes, the full
// structure scan, verification refresh, and architect-phase completeness.

import * as fs from 'fs';
import * as path from 'path';
import {
  buildRuntimeAssignments,
  isRuntimeMaintainedContextPath,
  publishRuntimeAssignments,
  readCompiledArchitecture,
  readRuntimeAssignments,
  validateArchitectureInput,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import {
  BUILD_ARTIFACT_RE,
  FEATURE_SOURCE_RE,
  isTestInfraConfigPath,
  isTestScopePath,
} from '../../../shared/feature-source';
import { obj } from '../../../shared/obj';
import {
  canPublishRunPolicyBootstraps,
  ensureRunPolicyBootstraps,
  readRunModelPolicy,
} from '../../../shared/run-model-policy';
import { matchesScope, type AssignedScope } from '../../../shared/scope';
import {
  activeAgentRole,
  readRunAssignmentsResilient,
  resolveRunAgentContext,
} from '../../../shared/state';
import {
  buildVerificationContract,
  changedPathsFromBaseline,
  publishVerificationContract,
  readVerificationContract,
  type LighthouseThresholdsV1,
  type UiImpact,
} from '../../../shared/verification-contract';
import { readVerificationPlanIntent } from '../../../shared/verification-plan-intent';
import {
  analyzeProjectStructure,
  writeStructureReport,
} from '../react-structure';
// Leaf classifier, not the plan-write dispatcher: `plan-write/targets` imports
// only `shared/**`, so plan-readiness may use it without an import cycle.
import { isCompiledFeatureTarget } from '../plan-write/targets';

import {
  QA_REPORT_ARTIFACT_RE,
  RUN_DIGEST_ARTIFACT_RE,
  RUN_RUNTIME_SIDECAR_RE,
  type Rec,
  exists,
} from './context';
import {
  T1_MEMORY_DIR,
  missingProjectMemoryBaseline,
} from './architect';

export function architectureInputErrors(content: string): string[] {
  try {
    return validateArchitectureInput(JSON.parse(content)).errors;
  } catch {
    return ['architecture input must be valid JSON'];
  }
}

export function assignmentScopesForRole(
  projectRoot: string,
  runId: string,
  role: string,
): AssignedScope[] {
  const runtime = readRuntimeAssignments(projectRoot, runId);
  if (runtime) {
    return runtime.assignments
      .filter((assignment) => assignment.role === role)
      .map((assignment) => assignment.scope);
  }
  // Once a compiled v2 sidecar exists, missing/corrupt runtime assignments are
  // a hard absence. Never borrow a sibling/legacy manifest to widen the scan.
  if (readCompiledArchitecture(projectRoot, runId)) return [];
  const manifest = readRunAssignmentsResilient(projectRoot, runId);
  if (!manifest) return [];
  return manifest.assignments
    .filter((assignment) => assignment.role === role)
    .map((assignment) => assignment.scope);
}

// A repo-relative path reference inside a finding: at least one directory
// segment and a file extension, anchored on a token boundary so `https://host/
// a.txt` and other absolute URLs never match. A trailing `:line` is left
// outside the capture, which is exactly the reviewer's `file:line` shape.
const FINDING_PATH_RE = /(?:^|[\s`'"(\[<])((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g;
// A finding that is explicitly PARKED is not an order: the role is told the
// item is not its to carry out, which is a satisfiable instruction. Anything
// else reads as "do this", and a role cannot do what the write gate denies.
const FINDING_PARKED_RE = /\b(?:DEFERRED|DEFER|REPLAN|BLOCKED|OUT[ -]OF[ -]SCOPE|NOT ACTIONABLE)\b/i;

/**
 * Paths a finding names that NO role in this run may write.
 *
 * On a compiled run the write gate hard-denies two namespaces — feature source
 * and assigned build artifacts — whenever the target sits outside every
 * runtime-owned WorkUnitContract (`run-team-runtime-allowlist-gap`), and the
 * only remedy it offers is a replan, which a fix cycle cannot perform. So a
 * finding naming such a path is an order no role can carry out: the implementer
 * is denied, the reviewer never reaches `APPROVED`, and the run deadlocks on a
 * file nobody owns (observed 12co — finding 5 ordered
 * `apps/web/public/llms.txt`, which was in no allowlist; that specific path now
 * has a compiled home, this stops the next one).
 *
 * Deliberately narrow. Anything the write gate would let through — root docs,
 * `.traffic-one/**`, build output, a path any role owns — is not reported, and
 * an abbreviated reference to a compiled output ("src/pages/Home.tsx" for
 * "apps/web/src/pages/Home.tsx") counts as owned rather than as a defect.
 */
export function unsatisfiableFindingPaths(
  projectRoot: string,
  runId: string,
  content: string,
): string[] {
  if (!runId || !content) return [];
  const architecture = readCompiledArchitecture(projectRoot, runId);
  const assignments = readRuntimeAssignments(projectRoot, runId);
  if (!architecture || !assignments) return [];
  const scopes = assignments.assignments.map((assignment) => assignment.scope);
  const includes = scopes.flatMap((scope) => scope.include);
  const ordered = new Set<string>();
  const parked = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const bucket = FINDING_PARKED_RE.test(line) ? parked : ordered;
    for (const match of line.matchAll(FINDING_PATH_RE)) {
      bucket.add(match[1]!.replace(/^\.\/+/, ''));
    }
  }
  const unsatisfiable = new Set<string>();
  for (const target of ordered) {
    if (parked.has(target)) continue;
    if (!FEATURE_SOURCE_RE.test(target)
      && !BUILD_ARTIFACT_RE.test(target)
      && !isCompiledFeatureTarget(architecture, target)) continue;
    if (scopes.some((scope) => matchesScope(target, scope))) continue;
    if (includes.some((include) => include.endsWith(`/${target}`))) continue;
    unsatisfiable.add(target);
  }
  return [...unsatisfiable].sort();
}

export function roleContract(
  contract: CompiledArchitectureV1,
  role: string,
): CompiledArchitectureV1 {
  const modules = contract.modules.filter((module) => module.ownerRole === role);
  const moduleOutputs = new Set(modules.map((module) => module.output));
  const entrypoints = role === 'senior-frontend' ? contract.entrypoints : [];
  return {
    ...contract,
    entrypoints,
    modules,
    routes: contract.routes.filter((route) => route.redirect || moduleOutputs.has(route.moduleOutput)),
    allowedOutputs: [...new Set([...entrypoints, ...modules.map((module) => module.output)])],
  };
}

export function runFullStructureScan(
  projectRoot: string,
  runId: string,
  contract: CompiledArchitectureV1,
  role?: string,
  greenfield = false,
  existing = false,
): ReturnType<typeof analyzeProjectStructure> {
  const scopedContract = role ? roleContract(contract, role) : contract;
  const scopes = role ? assignmentScopesForRole(projectRoot, runId, role) : [];
  // Multiple same-role work units are allowed. Their union is represented as a
  // pattern list here; exact per-unit coverage was already checked at PLAN_READY.
  const allowlist = scopes.flatMap((scope) => scope.include);
  const report = analyzeProjectStructure(projectRoot, scopedContract, {
    allowlist: role && allowlist.length > 0 ? allowlist : undefined,
    // Integration findings block only where Traffic One owns the structure;
    // on an existing codebase they stay advisory, and existing-* modes also
    // demote the entrypoint-convention, strict-collapse, and route/module-
    // mismatch hard-errors (StructureScanOptions.existing lists the exact ids).
    greenfield,
    existing,
  });
  writeStructureReport(projectRoot, runId, report);
  return report;
}

function verificationImpactRank(value: UiImpact): number {
  return {
    none: 0,
    nonvisual: 1,
    behavioral: 2,
    visual: 3,
    'native-ui': 4,
  }[value];
}

function thresholdsWeakened(
  before: LighthouseThresholdsV1 | undefined,
  after: LighthouseThresholdsV1 | undefined,
): boolean {
  if (!before) return false;
  for (const [key, previous] of Object.entries(before)) {
    const next = after?.[key as keyof LighthouseThresholdsV1];
    if (typeof next !== 'number') return true;
    if (key.endsWith('Min') ? next < previous : next > previous) return true;
  }
  return false;
}

// True when the digest CLAIMS the given verdict token. The machine-readable
// channel is the `verdict:` line — when one exists, only its leading token
// counts. A bare body word-match remains ONLY as the fallback for digests with
// no verdict line at all (fail-closed: prose claiming IMPLEMENTED without the
// contract line still triggers the completion gates). Matching the whole body
// blocked honest failure reports: observed 5co-codex, a `verdict: BLOCKED …`
// digest was denied by the IMPLEMENTED completion gates because its blocker
// section said "…before this role can emit `IMPLEMENTED`" — the agent got
// through only by rewording, so gates were selecting for phrasing, not truth.
export function digestClaimsVerdict(content: string, token: string): boolean {
  const verdictLine = /^[ \t]*verdict:[ \t]*(.+)$/m.exec(content);
  if (verdictLine) return new RegExp(`^${token}\\b`).test(verdictLine[1]!.trim());
  return new RegExp(`\\b${token}\\b`).test(content);
}

export function allImplementationRolesDelivered(
  projectRoot: string,
  runId: string,
  proposedDigestPath: string,
): boolean {
  const assignments = readRuntimeAssignments(projectRoot, runId);
  if (!assignments) return false;
  const roles = assignments.assignments
    .map((assignment) => assignment.role)
    .filter((role) => role === 'senior-frontend' || role === 'senior-backend');
  return roles.every((role) => {
    const suffix = role.replace(/^senior-/, '');
    const rel = `.traffic-one/digests/${runId}/${suffix}.md`;
    if (rel === proposedDigestPath) return true;
    try {
      return digestClaimsVerdict(fs.readFileSync(path.join(projectRoot, rel), 'utf8'), 'IMPLEMENTED');
    } catch {
      return false;
    }
  });
}

export function refreshVerificationAfterImplementation(
  projectRoot: string,
  runId: string,
  state: Rec,
): { error: string | null; changed: boolean } {
  const architecture = readCompiledArchitecture(projectRoot, runId);
  if (!architecture) return { error: 'CompiledArchitectureV1 is missing or invalid', changed: false };
  try {
    const previous = readVerificationContract(projectRoot, runId);
    if (!previous) {
      return { error: 'the current VerificationContractV2 is missing or invalid', changed: false };
    }
    const currentDiff = changedPathsFromBaseline(projectRoot, architecture);
    if (!currentDiff.complete) {
      return {
        error: `STRUCT_SCAN_INCOMPLETE: ${currentDiff.reason || 'baseline diff is incomplete'}`,
        changed: false,
      };
    }
    const authorizedPaths = new Set(previous.changedPaths);
    // The write surface and the verification authority are the SAME set:
    // whatever the runtime assignment already authorizes a role to write is a
    // legitimately-changed path here, never a frozen-authority breach. Three
    // shapes land through this (all observed 13cl/14cl):
    //   - sibling files under a folder-shaped module directory: a feature
    //     assignment includes the module DIRECTORY, so the compiled scope
    //     covers children the exact planned-output list never named (14cl
    //     wrote 26 legitimate sibling files; the old exact-set deny pushed the
    //     role to delete its split and ship a monolith);
    //   - tester-owned test files/config: test-scope paths are tester-owned
    //     regardless of the surrounding directory — the run-team gate's own
    //     ownership rule — so a new test file is authorized whenever this run
    //     compiled a tester assignment (13cl: `tests/i18n-parity.test.ts`);
    //   - runtime-maintained root context (AGENTS.md/CLAUDE.md), which
    //     materialization re-appends every session.
    // `matchesScope` over the hash-valid runtime assignments is the exact
    // matcher and manifest the run-team write gate enforces with — no second
    // matcher. A missing/invalid manifest contributes no scopes, so the check
    // stays fail-closed on the frozen exact set. This widens only what
    // verification RECOGNIZES; no role may claim anything new, and a genuinely
    // unowned path (the 12co `llms.txt` class) still denies below.
    const runtimeAssignments = readRuntimeAssignments(projectRoot, runId);
    const assignmentScopes = runtimeAssignments
      ? runtimeAssignments.assignments.map((assignment) => assignment.scope)
      : [];
    const testerAssigned = Boolean(runtimeAssignments
      ?.assignments.some((assignment) => assignment.role === 'senior-tester'));
    const unauthorized = currentDiff.paths.filter((entry) => (
      !authorizedPaths.has(entry)
      && !assignmentScopes.some((scope) => matchesScope(entry, scope))
      && !(testerAssigned && (isTestScopePath(entry) || isTestInfraConfigPath(entry)))
      && !isRuntimeMaintainedContextPath(entry)
    ));
    if (unauthorized.length > 0) {
      return {
        error: `changed paths outside the frozen verification/WorkUnit authority: ${unauthorized.slice(0, 20).join(', ')}`,
        changed: false,
      };
    }
    const verification = buildVerificationContract(
      projectRoot,
      runId,
      state,
      architecture,
      readVerificationPlanIntent(projectRoot),
    );
    if (!verification.scanComplete) {
      return {
        error: `STRUCT_SCAN_INCOMPLETE: ${verification.scanReason || 'baseline diff is incomplete'}`,
        changed: false,
      };
    }
    if (verificationImpactRank(verification.uiImpact) < verificationImpactRank(previous.uiImpact)
      || (previous.browserRequired && !verification.browserRequired)
      || previous.requiredScreenshotWidths.some((width) => !verification.requiredScreenshotWidths.includes(width))
      || (previous.performance.required && !verification.performance.required)
      || thresholdsWeakened(
        previous.performance.explicitThresholds,
        verification.performance.explicitThresholds,
      )
      || thresholdsWeakened(
        previous.performance.advisoryThresholds,
        verification.performance.advisoryThresholds,
      )) {
      return {
        error: 'the refreshed plan/diff would weaken an already-published verification requirement',
        changed: false,
      };
    }
    if (verification.contractHash === previous.contractHash) {
      return { error: null, changed: false };
    }
    const assignments = buildRuntimeAssignments(architecture, verification.contractHash);
    const modelPolicy = readRunModelPolicy(projectRoot, runId);
    if (obj(state.team)?.mode === 'subagents' && !modelPolicy) {
      return { error: 'immutable model-policy.json is missing or invalid', changed: false };
    }
    if (modelPolicy && !canPublishRunPolicyBootstraps(
      projectRoot,
      modelPolicy,
      state,
      { architecture, verification, assignments },
    )) {
      return {
        error: 'refreshed role/rule/skill materials or WorkUnitContract preflight failed',
        changed: false,
      };
    }
    publishVerificationContract(projectRoot, verification);
    publishRuntimeAssignments(projectRoot, architecture, verification.contractHash);
    if (modelPolicy && !ensureRunPolicyBootstraps(projectRoot, modelPolicy, state)) {
      return {
        error: 'refreshed bootstrap publication failed after a successful preflight',
        changed: true,
      };
    }
    return { error: null, changed: true };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      changed: false,
    };
  }
}

function missingArchitectureContract(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return ['.traffic-one/runs/<runId>/architecture-input-v1.json (currentRunId missing)'];
  const inputRel = `.traffic-one/runs/${runId}/architecture-input-v1.json`;
  if (!exists(projectRoot, inputRel)) return [inputRel];
  const compiledRel = `.traffic-one/runs/${runId}/architecture-v1.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readCompiledArchitecture(projectRoot, runId)) return [compiledRel];
  const verificationRel = `.traffic-one/runs/${runId}/verification-v2.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readVerificationContract(projectRoot, runId)) return [verificationRel];
  const assignmentsRel = `.traffic-one/runs/${runId}/assignments.json`;
  if (architectPlanReadyOnDisk(projectRoot, state) && !readRuntimeAssignments(projectRoot, runId)) {
    return [`${assignmentsRel} (runtime-owned hash-valid manifest required)`];
  }
  return [];
}

function missingAssignmentsManifest(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return ['.traffic-one/runs/<runId>/assignments.json (currentRunId missing)'];
  const relPath = `.traffic-one/runs/${runId}/assignments.json`;
  if (!readRuntimeAssignments(projectRoot, runId)) {
    return [`${relPath} (runtime-owned hash-valid manifest required)`];
  }
  return [];
}

function missingArchitectDigest(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  if (architectPlanReadyOnDisk(projectRoot, state)) return [];
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '<runId>';
  return [`.traffic-one/digests/${runId}/architect.md (must contain PLAN_READY)`];
}

export function architectPhaseIncompleteReasons(projectRoot: string, state: Rec): string[] {
  if (!requiresRunContracts(state)) return [];
  return [
    ...(state.mode === 'new-project' ? missingProjectMemoryBaseline(projectRoot, state) : []),
    ...missingArchitectureContract(projectRoot, state),
    ...missingAssignmentsManifest(projectRoot, state),
    ...missingArchitectDigest(projectRoot, state),
  ];
}

export function isArchitectPhaseComplete(projectRoot: string, state: Rec): boolean {
  return architectPhaseIncompleteReasons(projectRoot, state).length === 0;
}

function architectPlanReadyOnDisk(projectRoot: string, state: Rec): boolean {
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return false;
  try {
    return digestClaimsVerdict(fs.readFileSync(path.join(projectRoot, T1_MEMORY_DIR, 'digests', runId, 'architect.md'), 'utf8'), 'PLAN_READY');
  } catch {
    return false;
  }
}

export function assignmentWriterRole(projectRoot: string, state: Rec, rawData: unknown, host?: string): string | null {
  const ctx = rawData ? resolveRunAgentContext(projectRoot, state, rawData, { claimPending: true, host }) : null;
  return (ctx && typeof ctx.role === 'string' ? ctx.role : null) || activeAgentRole(state);
}

const ARCHITECT_MEMORY_RE =
  /^\.traffic-one\/(?:plan|product|stack|coding|security|known-issues|deployment|environment-setup|agent-log|api|database)\.md$/;

// ADRs live in `.traffic-one/decisions/` under whatever name the record needs —
// `project-memory` prose hands the architect that directory (README + ADR files)
// and `senior-engineer-team` lists `decisions/*` among the memory it owns, while
// this gate used to accept exactly ONE filename nothing documented. Observed
// 1cu-cursor: `decisions/README.md` and `decisions/0001-<slug>.md` were denied
// three times and the architect gave up on recording the ADR at all — for a
// non-default stack, `missingPlanArtifacts` then REQUIRES a file the architect
// was never allowed to write.
//
// The run-exactness this replaces still holds where it matters: `decisions/` is
// APPEND-ONLY across runs (project-memory: "never rewrite prior decisions
// silently"), so an ADR that already exists may be overwritten only under this
// run's own prefix. Markdown, one level deep, no traversal.
const ARCHITECT_DECISION_RE = /^\.traffic-one\/decisions\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

function architectMayWriteDecision(projectRoot: string, filePath: string, runId: string): boolean {
  if (!ARCHITECT_DECISION_RE.test(filePath) || filePath.includes('..')) return false;
  const name = filePath.slice('.traffic-one/decisions/'.length);
  if (name === 'README.md') return true;
  if (runId && (name === `${runId}-architecture.md` || name.startsWith(`${runId}-`))) return true;
  // A brand-new ADR is a new decision; an existing one belongs to whoever
  // recorded it. Unreadable project root → treat as existing (fail closed).
  try {
    return !fs.existsSync(path.join(projectRoot, filePath));
  } catch {
    return false;
  }
}

export function architectMayWrite(projectRoot: string, filePath: string, runId: string): boolean {
  if (ARCHITECT_MEMORY_RE.test(filePath)
    || filePath === '.traffic-one/.agentignore'
    || filePath === '.traffic-one/schema.sql') return true;
  if (architectMayWriteDecision(projectRoot, filePath, runId)) return true;
  if (!runId) return false;
  return filePath === `.traffic-one/runs/${runId}/architecture-input-v1.json`
    || filePath === `.traffic-one/digests/${runId}/architect.md`;
}

function requiresRunContracts(state: Rec): boolean {
  if (state.mode === 'new-project') return true;
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  return Boolean(runId && obj(state.team)?.mode === 'subagents');
}

export function runtimeOwnedRunSidecar(filePath: string): boolean {
  const matched = RUN_RUNTIME_SIDECAR_RE.exec(filePath);
  return Boolean(matched && matched[2] !== 'architecture-input-v1.json');
}

export function artifactContract(filePath: string, currentRunId: string): {
  runId: string;
  role: string;
} | null {
  const digest = RUN_DIGEST_ARTIFACT_RE.exec(filePath);
  if (digest) {
    return {
      runId: digest[1] || '',
      role: `senior-${digest[2] || ''}`,
    };
  }
  const report = QA_REPORT_ARTIFACT_RE.exec(filePath);
  if (report) return { runId: report[1] || '', role: 'senior-tester' };
  if (filePath === '.traffic-one/deployments.jsonl' && currentRunId) {
    return { runId: currentRunId, role: 'senior-shipper' };
  }
  return null;
}

export function usesMainAgentTeam(state: Rec): boolean {
  return obj(state.team)?.mode === 'main-agent';
}
