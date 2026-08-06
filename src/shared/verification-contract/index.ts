// VerificationContractV2 compile/publish/read. The heavy lifting lives in
// the -types/-git/-impact siblings; this file keeps the builders and
// re-exports the original public surface.

import * as path from 'path';
import {
  isRuntimeMaintainedContextPath,
  stableContractJson,
  type CompiledArchitectureV1,
} from '../architecture-contract';
import {
  profileHasWebUi,
} from '../capabilities';
import { readJson, writeJson } from '../fsjson';
import { sha256 } from '../text';

import {
  DEFAULT_LIGHTHOUSE_THRESHOLDS,
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
  browserRequired,
  changedRoutes,
  deriveUiImpact,
  plannedImportantVisualChange,
  rank,
  requiredChecks,
  thresholdsValid,
  uiImpactWithPlannedFloor,
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
  const rawBaselineDiff = options.changedPaths
    ? {
        paths: options.changedPaths.map(normalizeRel).filter((value): value is string => Boolean(value)),
        complete: options.scanComplete !== false,
        ...(options.scanReason ? { reason: options.scanReason } : {}),
      }
    : changedPathsFromBaseline(projectRoot, architecture);
  // Runtime-maintained root context (AGENTS.md/CLAUDE.md) is rewritten by
  // materialization on every session. Keeping it OUT of the contract identity
  // means the runtime's own re-append can never churn the verification hash,
  // invalidate QA evidence, or surface as an unauthorized changed path
  // (observed 13cl: a verdict gate made the frontend fight the runtime's own
  // hook). The raw scans still see the files; only the judgment ignores them.
  const baselineDiff = {
    ...rawBaselineDiff,
    paths: rawBaselineDiff.paths.filter((entry) => !isRuntimeMaintainedContextPath(entry)),
  };
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
  const runtimeImpact = uiImpactWithPlannedFloor(projectRoot, architecture, derived.impact);
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
  // A page-speed budget BLOCKS only when someone declared one: an explicit
  // threshold from the user/plan, an architect `performanceRisk`, or a redesign.
  // `visual-risk` used to be in this list, which meant any meaningful UI change
  // silently opted the run into a synthetic budget nobody asked for — observed
  // 10co, where FCP 1.65s vs a 1.5s default ended a run whose Performance score
  // was 99. It now yields an ADVISORY contract: still measured, still reported,
  // never blocking.
  const performanceRequired = webUi
    && Boolean(explicit || options.redesign || options.performanceRisk);
  const performanceAdvisory = webUi && !performanceRequired && visualRisk;
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
    browserRequired: browserRequired(impact),
    nativeAdapter: impact === 'native-ui' ? (architecture.profile.qaAdapters[0] || null) : null,
    requiredScreenshotWidths: impact === 'visual' ? [390, ...(tabletRisk ? [768] : []), 1440] : [],
    tabletRisk,
    buildIdentityRequired: impact === 'behavioral' || impact === 'visual',
    performance: {
      required: performanceRequired,
      advisory: performanceAdvisory,
      reason: performanceRequired || performanceAdvisory ? performanceReason : 'not-required' as const,
      // The effective budget is published on the contract so the QA report and
      // the standalone runner judge the SAME numbers. Without this the runner's
      // own defaults were a second, invisible authority.
      thresholds: { ...DEFAULT_LIGHTHOUSE_THRESHOLDS, ...(explicit || {}) },
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

/**
 * Persist `contract` and hand back the contract that is now ON DISK, or `null`
 * when the write chokepoint refused it (fsjson.ts: an unanswered consent
 * question, a planted symlink, a path that escapes the state dir).
 *
 * The `| null` is the whole point, and it is deliberately in the RETURN VALUE
 * the caller already consumes rather than in a second boolean beside it. This
 * function used to drop writeJson's refusal and `return contract` on the next
 * line, so a caller received a contract object that claimed to be published
 * whether or not anything had been written — and every caller believed it. A
 * separate boolean would have been just as droppable; a nullable contract is
 * one the type checker will not let a caller use without deciding.
 *
 * Not a `MutationResult`: that type exists to keep "the world said no" apart
 * from "I could not find out", and it carries a retry contract for the second.
 * Every refusal reachable here is the FIRST kind — durable, deliberate and
 * default-closed — so there is no second answer to distinguish and nothing a
 * retry could change.
 */
export function publishVerificationContract(
  projectRoot: string,
  contract: VerificationContractV2,
): VerificationContractV2 | null {
  return writeJson(verificationContractPath(projectRoot, contract.runId), contract) ? contract : null;
}

/**
 * Compile and publish in one call. Used only by tests and test fixtures
 * (production compiles with buildVerificationContract and publishes through
 * publishVerificationContract, so it can route a refusal into its own gate's
 * deny) — which is why a refused publish THROWS here instead of widening the
 * return type to `| null` across ~40 assertion sites. It joins the three
 * conditions this module already throws for: like an invalid runId or an
 * impossible Lighthouse budget, a contract that could not be persisted is not a
 * contract, and a test that continues against one is measuring nothing.
 */
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
  const published = publishVerificationContract(projectRoot, contract);
  if (!published) throw new Error(`verification contract for run ${runId} could not be persisted`);
  return published;
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
  // Runtime-maintained root context is excluded from the contract identity
  // (see buildVerificationContract), so its re-append must not read as an
  // out-of-contract change here either — the two sides share one predicate.
  const extraPaths = currentDiff.paths.filter((file) => (
    !contracted.has(file) && !isRuntimeMaintainedContextPath(file)
  ));
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
  DEFAULT_LIGHTHOUSE_THRESHOLDS,
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
  browserRequired,
  deriveUiImpact,
  plannedUiImpactFloor,
  requiredChecks,
  uiImpactWithPlannedFloor,
} from './impact';
