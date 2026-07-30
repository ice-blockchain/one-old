// VerificationContractV2 compile/publish/read. The heavy lifting lives in
// the -types/-git/-impact siblings; this file keeps the builders and
// re-exports the original public surface.

import * as path from 'path';
import {
  stableContractJson,
  type CompiledArchitectureV1,
} from '../architecture-contract';
import {
  profileHasWebUi,
} from '../capabilities';
import { readJson, writeJson } from '../fsjson';
import { sha256 } from '../text';

import {
  VERIFICATION_CONTRACT_SCHEMA_VERSION,
  type PerformanceContractV1,
  type VerificationCompileOptions,
  type VerificationContractV2,
} from './types';
import {
  changedPathsFromBaseline,
  changedPathsFromImmutableBaseline,
  fileHash,
  normalizeRel,
  projectPathInspectionIssue,
  unique,
} from './git';
import {
  IMPORTANT_VISUAL_PATH_RE,
  changedRoutes,
  deriveUiImpact,
  plannedImportantVisualChange,
  plannedUiImpactFloor,
  raiseImpact,
  rank,
  requiredChecks,
  thresholdsValid,
  validateAgentRaisedImpact,
  verificationHash,
} from './impact';

export function verificationContractPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', runId, 'verification-v2.json');
}

export function buildVerificationContract(
  projectRoot: string,
  runId: string,
  state: unknown,
  architecture: CompiledArchitectureV1,
  options: VerificationCompileOptions = {},
): VerificationContractV2 {
  if (!runId || /[\\/]/.test(runId)) throw new Error('runId is invalid');
  if (!thresholdsValid(options.explicitLighthouse) || !thresholdsValid(options.advisoryLighthouse)) {
    throw new Error('Lighthouse thresholds are invalid');
  }
  validateAgentRaisedImpact(architecture.profile, options.agentRaisedImpact);
  const webUi = profileHasWebUi(architecture.profile);
  if (!webUi && (
    (options.explicitLighthouse && Object.keys(options.explicitLighthouse).length > 0)
    || (options.advisoryLighthouse && Object.keys(options.advisoryLighthouse).length > 0)
  )) {
    throw new Error('Lighthouse options require a web-ui capability profile');
  }
  const baselineDiff = options.changedPaths
    ? {
        paths: options.changedPaths.map(normalizeRel).filter((value): value is string => Boolean(value)),
        complete: options.scanComplete !== false,
        ...(options.scanReason ? { reason: options.scanReason } : {}),
      }
    : changedPathsFromBaseline(projectRoot, architecture);
  // Every runtime-compiled output is part of the verification identity before
  // implementation: sources, entrypoints, scaffold/config, tests and test
  // infrastructure. Using modules alone would make the final whole-project
  // diff reject the very scaffold/tests the work-unit contract authorized.
  const paths = unique([...baselineDiff.paths, ...architecture.allowedOutputs]);
  // QA impact comes from the immutable-baseline diff. Planned production
  // modules/scaffold are handled separately by plannedUiImpactFloor; test
  // infrastructure must be part of the source identity without inflating a
  // mapper-only change into behavioral or visual UI work.
  const derived = deriveUiImpact(
    projectRoot,
    architecture.profile,
    baselineDiff.paths,
    architecture.baseline,
  );
  const runtimeImpact = raiseImpact(
    derived.impact,
    plannedUiImpactFloor(projectRoot, architecture),
  );
  const raised = options.agentRaisedImpact && rank(options.agentRaisedImpact) > rank(runtimeImpact)
    ? options.agentRaisedImpact
    : runtimeImpact;
  const impact = runtimeImpact === 'native-ui' ? 'native-ui' : raised;
  const tabletRisk = impact === 'visual' && derived.tabletRisk;
  const explicit = options.explicitLighthouse && Object.keys(options.explicitLighthouse).length
    ? options.explicitLighthouse
    : undefined;
  const visualRisk = impact === 'visual' && (
    Boolean(options.advisoryLighthouse && Object.keys(options.advisoryLighthouse).length > 0)
    || plannedImportantVisualChange(projectRoot, architecture)
    || baselineDiff.paths.some((file) => IMPORTANT_VISUAL_PATH_RE.test(file))
  );
  const performanceRequired = webUi
    && Boolean(explicit || options.redesign || options.performanceRisk || visualRisk);
  const performanceReason: PerformanceContractV1['reason'] = explicit
    ? 'explicit'
    : options.redesign
      ? 'redesign'
      : options.performanceRisk
        ? 'performance-risk'
        : visualRisk
          ? 'visual-risk'
          : 'not-required';
  const semanticContract = {
    schemaVersion: VERIFICATION_CONTRACT_SCHEMA_VERSION,
    runId,
    architectureHash: architecture.contractHash,
    baseline: architecture.baseline,
    uiImpact: impact,
    uiImpactSource: impact !== runtimeImpact ? 'agent-raised' as const : 'runtime' as const,
    ...(derived.reason ? { uiImpactReason: derived.reason } : {}),
    changedPaths: paths,
    // Honesty split (additive; changedPaths stays the authorization union the
    // refresh path depends on): observedChangedPaths is the REAL baseline
    // diff, plannedOutputs is what the architecture compiled — an entry in
    // changedPaths that never existed on disk is a planned output, not a
    // change (8co listed 11 never-created test files under scanComplete:true).
    observedChangedPaths: baselineDiff.paths,
    plannedOutputs: [...architecture.allowedOutputs],
    changedRoutes: changedRoutes(architecture, paths, impact),
    scanComplete: baselineDiff.complete,
    ...(baselineDiff.reason ? { scanReason: baselineDiff.reason } : {}),
    requiredChecks: requiredChecks(impact, !webUi && Boolean(options.performanceRisk)),
    browserRequired: impact === 'behavioral' || impact === 'visual',
    nativeAdapter: impact === 'native-ui' ? (architecture.profile.qaAdapters[0] || null) : null,
    requiredScreenshotWidths: impact === 'visual' ? [390, ...(tabletRisk ? [768] : []), 1440] : [],
    tabletRisk,
    buildIdentityRequired: impact === 'behavioral' || impact === 'visual',
    performance: {
      required: performanceRequired,
      reason: performanceRequired ? performanceReason : 'not-required' as const,
      ...(explicit ? { explicitThresholds: explicit } : {}),
      ...(options.advisoryLighthouse ? { advisoryThresholds: options.advisoryLighthouse } : {}),
      advisoryTolerancePercent: 3 as const,
    },
  };
  // PLAN_READY publishes the first contract, then IMPLEMENTED refreshes it
  // against the real immutable-baseline diff. Repeated pre-tool retries with no
  // semantic change must not churn the contract hash and invalidate every
  // already-published WorkUnit/bootstrap merely because wall-clock time moved.
  const existing = readVerificationContract(projectRoot, runId);
  if (existing) {
    const {
      contractHash: _existingHash,
      generatedAt: _existingGeneratedAt,
      ...existingSemantic
    } = existing;
    if (stableContractJson(existingSemantic) === stableContractJson(semanticContract)) {
      return existing;
    }
  }
  const withoutHash = {
    ...semanticContract,
    generatedAt: new Date().toISOString(),
  };
  const contract: VerificationContractV2 = {
    ...withoutHash,
    contractHash: verificationHash(withoutHash),
  };
  return contract;
}

export function publishVerificationContract(
  projectRoot: string,
  contract: VerificationContractV2,
): VerificationContractV2 {
  writeJson(verificationContractPath(projectRoot, contract.runId), contract);
  return contract;
}

export function compileVerificationContract(
  projectRoot: string,
  runId: string,
  state: unknown,
  architecture: CompiledArchitectureV1,
  options: VerificationCompileOptions = {},
): VerificationContractV2 {
  const contract = buildVerificationContract(projectRoot, runId, state, architecture, options);
  const existing = readVerificationContract(projectRoot, runId);
  if (existing?.contractHash === contract.contractHash) return existing;
  return publishVerificationContract(projectRoot, contract);
}

export function readVerificationContract(
  projectRoot: string,
  runId: string,
): VerificationContractV2 | null {
  const raw = readJson<VerificationContractV2 | null>(verificationContractPath(projectRoot, runId), null);
  if (!raw || raw.schemaVersion !== VERIFICATION_CONTRACT_SCHEMA_VERSION || raw.runId !== runId) return null;
  const { contractHash, ...withoutHash } = raw;
  if (!contractHash || verificationHash(withoutHash) !== contractHash) return null;
  return raw;
}

export function currentVerificationSourceHash(
  projectRoot: string,
  contract: VerificationContractV2,
): { hash: string; complete: boolean; reason?: string } {
  if (!contract.scanComplete) {
    return { hash: '', complete: false, reason: contract.scanReason || 'verification scan is incomplete' };
  }
  const currentDiff = changedPathsFromImmutableBaseline(projectRoot, contract.baseline);
  if (!currentDiff.complete) {
    return {
      hash: '',
      complete: false,
      reason: currentDiff.reason || 'baseline diff could not be recomputed',
    };
  }
  const contracted = new Set(contract.changedPaths);
  const extraPaths = currentDiff.paths.filter((file) => !contracted.has(file));
  if (extraPaths.length > 0) {
    return {
      hash: '',
      complete: false,
      reason: `changed paths outside verification contract: ${extraPaths.slice(0, 20).join(', ')}${extraPaths.length > 20 ? ` (+${extraPaths.length - 20} more)` : ''}`,
    };
  }
  for (const file of contract.changedPaths) {
    const issue = projectPathInspectionIssue(projectRoot, file);
    if (issue) return { hash: '', complete: false, reason: issue };
  }
  const rows = contract.changedPaths.map((file) => [
    file,
    fileHash(projectRoot, file),
  ]);
  return {
    hash: sha256(stableContractJson({
      baseline: contract.baseline.identity,
      architectureHash: contract.architectureHash,
      rows,
    })),
    complete: true,
  };
}

export {
  VERIFICATION_CONTRACT_SCHEMA_VERSION,
  VERIFICATION_SCAN_MAX_FILES,
  type ChangedPathSnapshot,
  type LighthouseThresholdsV1,
  type PerformanceContractV1,
  type UiImpact,
  type VerificationCompileOptions,
  type VerificationContractV2,
} from './types';

export {
  changedPathsFromBaseline,
} from './git';

export {
  deriveUiImpact,
} from './impact';
