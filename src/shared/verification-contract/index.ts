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
  skipNameDisclosure,
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
  IMPORTANT_VISUAL_CHANGED_PATH_RE,
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
  // The skip-authority name disclosure is NOT truncation, and this is the site
  // where treating it as one was expensive.
  //
  // `scanComplete`'s own definition is "the walk finished within bounds", and
  // for this class it did: the probe enumerated every path Git makes visible and
  // can NAME the ones the diff excludes. Nothing went unread. Every complete
  // scan in this tree excludes `dist/` — `isScanSkippedPath` runs on all of
  // them, and they all report `complete: true` — so the disclosure does not
  // discover that a scan was partial. It discovers that an always-skipped
  // directory holds something source-shaped, which is a different fact and
  // belongs in a different channel.
  //
  // Both consequences of calling it truncation were wrong here, and MEASURED so:
  //
  //   - The FLOOR compensates for ignorance by asserting the domain maximum.
  //     There is no ignorance to compensate: the paths are named. And the floor
  //     cannot lift again — `truncationPinLifted` needs the diff to come back
  //     complete, and a `dist/` does not delete itself, so a run pays the pin
  //     for the rest of its life for having built.
  //   - IDENTITY is worse. `scanComplete`/`scanReason` are hashed into
  //     `contractHash`, and the trigger is usually the run's OWN build output,
  //     which appears DURING QA. So the reviewer's refresh was the first compile
  //     to see it, published a new hash, and `APPROVED` was then forbidden
  //     because "the current review bootstrap predates that contract" while the
  //     QA report it had just validated became `contract-mismatch`. Measured on
  //     both `test:env --strict` scenarios: `scanComplete: false`, a `scanReason`
  //     naming `dist/assets/app-ca5e0bbf.js`, `uiImpactPinned` ABSENT (both
  //     projects derived `visual` on their own evidence, so the floor moved no
  //     value at all) — the churn was the two fields and nothing else.
  //
  // This is the exclusion `isRuntimeMaintainedContextPath` makes twenty lines
  // above, for the same reason: the runtime's own side effects must not churn the
  // identity a review is pinned to. The disclosure is not dropped — it is
  // RE-DERIVED live at `currentVerificationSourceHash`, on every report
  // validation and every settlement read, and recorded durably in the artifact
  // that actually claims evidence (`QaReportV2.settledWithIncompleteScan`, which
  // the validator refuses a qualified run for omitting). Remembering it here
  // would add nothing a reader cannot see and would cost the chain of custody.
  //
  // `skipNameDisclosure` is the tree's single classifier for this and is
  // fail-closed: an unrecognised reason stays fatal. It is a substring test
  // because the marker is a sentence TAIL (see its own note), which is safe
  // here only because a snapshot carries ONE reason —
  // `changedPathsFromImmutableBaseline` picks the first cause with `||` and
  // never concatenates — so a disclosure cannot arrive wearing a fatal cause.
  const nameDisclosure = baselineDiff.complete
    ? null
    : skipNameDisclosure(baselineDiff.reason);
  const scanComplete = baselineDiff.complete || Boolean(nameDisclosure);
  // THREE truncation notions reach this contract, and until now the floor
  // covered one of them. The baseline diff is the notion `scanComplete`
  // publishes; the structure walk's file cap and COLLAPSE_MAX_FILES are the
  // other two, and they arrive as `boundedScanTruncated` because the caller is
  // the only party that has seen those scans. All three mean the same thing to
  // the floor — some part of this project went unread — so all three raise it.
  // Only the first may touch `scanComplete` (see the option's own note).
  const scanTruncated = !scanComplete || options.boundedScanTruncated === true;
  const unpinnedImpact = uiImpactWithPlannedFloor(
    projectRoot,
    architecture,
    derived.impact,
    true,
  );
  const runtimeImpact = uiImpactWithPlannedFloor(
    projectRoot,
    architecture,
    derived.impact,
    !scanTruncated,
  );
  // The truncation floor's own justification, carried where a reader looks for
  // one. `scanReason` already says the diff is partial; this says what that cost
  // the contract, which is the fact an implementer needs when the run suddenly
  // owes browser evidence for a change that looks nonvisual.
  const truncationPinned = rank(runtimeImpact) > rank(unpinnedImpact);
  const impactReason = [
    ...(derived.reason ? [derived.reason] : []),
    ...(truncationPinned
      ? [`A bounded scan did not finish, so uiImpact is pinned to the truncated-scan floor (${runtimeImpact}) rather than the ${unpinnedImpact} the evidence read.`]
      : []),
  ].join(' ');
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
    // The CHANGED-path anchor, not the planned one: these paths exist, so the
    // name is not the whole evidence and the filename-prefix branch is the
    // measured false-positive source (see impact.ts). The planned side keeps
    // that branch and reaches this same `visualRisk` through
    // plannedImportantVisualChange on the line above.
    || baselineDiff.paths.some((file) => IMPORTANT_VISUAL_CHANGED_PATH_RE.test(file))
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
    ...(impactReason ? { uiImpactReason: impactReason } : {}),
    // Published only when it is true, so a contract that was never pinned reads
    // the same as one written before the field existed — the ratchet treats both
    // as unexempt. `impact === runtimeImpact` is the second half of the
    // provenance: an agent that raised the impact ABOVE the floor published its
    // own number, and there is nothing of the runtime's to withdraw.
    ...(truncationPinned && impact === runtimeImpact
      ? { uiImpactPinned: true, unpinnedUiImpact: unpinnedImpact }
      : {}),
    changedPaths: paths,
    // Honesty split (additive; changedPaths stays the authorization union the
    // refresh path depends on): observedChangedPaths is the REAL baseline
    // diff, plannedOutputs is what the architecture compiled — an entry in
    // changedPaths that never existed on disk is a planned output, not a
    // change (8co listed 11 never-created test files under scanComplete:true).
    observedChangedPaths: baselineDiff.paths,
    plannedOutputs: [...architecture.allowedOutputs],
    changedRoutes: changedRoutes(architecture, paths, impact),
    scanComplete,
    // The reason is withheld with the flag, not in spite of it. A `scanReason`
    // on a `scanComplete: true` contract would read as a truncation that was
    // forgiven, and it is hashed all the same — publishing it would churn the
    // identity this whole branch exists to leave alone.
    ...(baselineDiff.reason && !nameDisclosure ? { scanReason: baselineDiff.reason } : {}),
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

/**
 * The run's live source identity, and — when the scan behind it was partial —
 * whether that partiality is DISCLOSABLE or fatal.
 *
 * `complete: false` used to be the end of every conversation, and one member of
 * that set does not belong there. `types.ts`'s note on `boundedScanTruncated`
 * already wrote the argument down: "`scanComplete: false` is a DEAD END:
 * validateQaReportV2 rejects such a contract outright (`scan-incomplete`), so a
 * run that merely walked past a generated tree too large to judge could never be
 * certified at all." The skip-authority name disclosure is that same shape and
 * was still wired into the dead end — and it is worse than the case that note
 * fixed, because the trigger is usually the run's OWN build output (see
 * `nameSkippedProjectSource`). Measured: two `test:env --strict` scenarios lost
 * every QA check to it, on a contract whose own `scanComplete` was `true`, over a
 * `dist/assets/app-<hash>.js` that `npm run build` had just written.
 *
 * `qualification` is the third answer. `complete` STAYS FALSE — a caller that
 * knows nothing about this field keeps refusing, which is the fail-closed
 * direction and the reason the flag is additive rather than a relaxation of
 * `complete` — but `hash` is populated, so a caller that does know may proceed
 * PROVIDED it carries this text into what it publishes. That proviso is not
 * advice: `validateQaReportV2` refuses a report that proceeded on a qualified
 * scan and does not say so.
 *
 * The LIVE diff is now the only entry point that produces one, because
 * `buildVerificationContract` no longer publishes this class into
 * `scanComplete`/`scanReason` (see its own note: the fields are hashed, and the
 * trigger is usually build output that appears mid-run, so remembering it there
 * broke the chain of custody a review is pinned to). The contract-side branch is
 * kept anyway and is not dead code: contracts published by an earlier runtime —
 * including every run in flight across an upgrade — carry exactly that shape, and
 * refusing them would strand the runs this change exists to unblock.
 */
export function currentVerificationSourceHash(
  projectRoot: string,
  contract: VerificationContractV2,
): { hash: string; complete: boolean; reason?: string; qualification?: string } {
  const qualifications: string[] = [];
  if (!contract.scanComplete) {
    const disclosure = skipNameDisclosure(contract.scanReason);
    if (!disclosure) {
      return { hash: '', complete: false, reason: contract.scanReason || 'verification scan is incomplete' };
    }
    qualifications.push(disclosure);
  }
  const currentDiff = changedPathsFromImmutableBaseline(projectRoot, contract.baseline);
  if (!currentDiff.complete) {
    const disclosure = skipNameDisclosure(currentDiff.reason);
    if (!disclosure) {
      return {
        hash: '',
        complete: false,
        reason: currentDiff.reason || 'baseline diff could not be recomputed',
      };
    }
    if (!qualifications.includes(disclosure)) qualifications.push(disclosure);
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
  // The hash is the contract's OWN changed paths, so it is byte-identical
  // whether or not a skipped directory name hid something else: a qualified run
  // and the same run with the offending directory gitignored produce the same
  // identity, which is what makes the qualification a disclosure rather than a
  // second build identity nobody could reconcile.
  const qualification = qualifications.join('; ');
  return {
    hash: sha256(stableContractJson({
      baseline: contract.baseline.identity,
      architectureHash: contract.architectureHash,
      rows,
    })),
    complete: qualifications.length === 0,
    ...(qualification ? { reason: qualification, qualification } : {}),
  };
}

export {
  DEFAULT_LIGHTHOUSE_THRESHOLDS,
  SKIP_NAME_DISCLOSURE_MARKER,
  VERIFICATION_CONTRACT_SCHEMA_VERSION,
  VERIFICATION_SCAN_MAX_FILES,
  skipNameDisclosure,
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
  truncatedScanUiImpactFloor,
  uiImpactWithPlannedFloor,
} from './impact';
