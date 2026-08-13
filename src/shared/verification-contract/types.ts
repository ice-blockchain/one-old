// src/shared/verification-contract-types.ts
// VerificationContractV2 schema: version, impact union, thresholds, and the
// compile options. Logic lives in the -git/-impact siblings; the public
// surface is re-exported by verification-contract.ts.

import {
  isScanSkippedPath,
  type ArchitectureBaselineV1,
} from '../architecture-contract';

export const VERIFICATION_CONTRACT_SCHEMA_VERSION = 2 as const;
export const VERIFICATION_SCAN_MAX_FILES = 10_000;

export type UiImpact = 'none' | 'nonvisual' | 'behavioral' | 'visual' | 'native-ui';

/**
 * The default budget a Lighthouse audit is judged against when nobody declared
 * one. It is the SINGLE authority: the QA report and the standalone runner both
 * read it, so the tester and the final gate cannot disagree.
 *
 * Observed 10co: `explicitThresholds` was absent, so the canonical QA path
 * enforced NOTHING while the standalone runner applied its own hardcoded
 * `fcpMax: 1500`. The run went reviewer-APPROVED + tester-TESTS_GREEN and was
 * then failed by a threshold that existed in only one of the two paths and that
 * no one had declared.
 *
 * Deliberately limited to metrics the canonical QA evidence ALWAYS carries.
 * `fcpMaxMs`/`tbtMaxMs` are judgeable (the evidence records them) but are not
 * defaulted: a synthetic first-paint budget nobody declared is exactly what
 * ended the 10co run at FCP 1.65s against a Performance score of 99.
 */
export const DEFAULT_LIGHTHOUSE_THRESHOLDS = {
  performanceMin: 90,
  lcpMaxMs: 2500,
  clsMax: 0.1,
} as const;

export interface LighthouseThresholdsV1 {
  performanceMin?: number;
  accessibilityMin?: number;
  bestPracticesMin?: number;
  seoMin?: number;
  fcpMaxMs?: number;
  lcpMaxMs?: number;
  tbtMaxMs?: number;
  clsMax?: number;
  inpMaxMs?: number;
}

export interface PerformanceContractV1 {
  /** A failed threshold BLOCKS the run. Only a declared budget earns this. */
  required: boolean;
  /**
   * Audit and report, but never block. `visual-risk` lands here: a UI change is
   * a reason to MEASURE page speed, not a reason to fail a run against a
   * synthetic budget the user never asked for.
   */
  advisory: boolean;
  reason: 'not-required' | 'redesign' | 'visual-risk' | 'performance-risk' | 'explicit';
  /** Effective budget for this run — declared thresholds, else the defaults. */
  thresholds: LighthouseThresholdsV1;
  explicitThresholds?: LighthouseThresholdsV1;
  advisoryThresholds?: LighthouseThresholdsV1;
  advisoryTolerancePercent: 3;
}

export interface VerificationContractV2 {
  schemaVersion: typeof VERIFICATION_CONTRACT_SCHEMA_VERSION;
  runId: string;
  architectureHash: string;
  baseline: ArchitectureBaselineV1;
  uiImpact: UiImpact;
  uiImpactSource: 'runtime' | 'agent-raised';
  uiImpactReason?: string;
  /**
   * PROVENANCE, not value: true when `uiImpact` is the truncated-scan floor
   * ASSERTED FROM IGNORANCE rather than a number any evidence produced.
   *
   * The ratchet exemption in plan-readiness/contracts.ts is keyed on this and
   * cannot be keyed on anything cheaper. Its predecessor test was
   * `previous.uiImpact === truncatedScanUiImpactFloor(profile)`, which for a web
   * profile compares `visual` against `visual` — the floor's value and the
   * commonest EARNED value are the same string, so an honest run that read
   * `visual` off a stylesheet was granted the withdrawal a truncated run is
   * owed, and shed real evidence with it.
   *
   * Absent on contracts published before this field existed, which reads as
   * `false` and gives them the unconditional ratchet: the fail-closed direction.
   */
  uiImpactPinned?: boolean;
  /**
   * What the same evidence would have produced with no truncation floor, and so
   * exactly how far the exemption may forgive. Published only when
   * `uiImpactPinned` is true.
   *
   * Without it the exemption forgave the WHOLE `impactWeakened` disjunction,
   * including the part the agent's own edits caused between the two contracts:
   * a predecessor pinned to `visual` over `behavioral` evidence could be
   * succeeded by `nonvisual` and nothing refused, because a pin was in the
   * neighbourhood. The pin is entitled to withdraw the distance it invented and
   * no further.
   */
  unpinnedUiImpact?: UiImpact;
  changedPaths: string[];
  // Additive honesty split (1.0.37): changedPaths is the AUTHORIZATION union
  // (observed diff + every compiled output) and stays load-bearing for the
  // post-implementation refresh. observedChangedPaths is the real baseline
  // diff alone; plannedOutputs is the compiled-output list. Optional so
  // pre-1.0.37 contracts keep parsing.
  observedChangedPaths?: string[];
  plannedOutputs?: string[];
  changedRoutes: string[];
  // Diff-SCAN completion only: the walk finished within bounds. It does NOT
  // assert that every changedPaths entry exists on disk — planned outputs are
  // legal members before implementation.
  scanComplete: boolean;
  scanReason?: string;
  requiredChecks: string[];
  browserRequired: boolean;
  nativeAdapter: string | null;
  requiredScreenshotWidths: number[];
  tabletRisk: boolean;
  buildIdentityRequired: boolean;
  performance: PerformanceContractV1;
  generatedAt: string;
  contractHash: string;
}

export interface VerificationCompileOptions {
  agentRaisedImpact?: UiImpact;
  explicitLighthouse?: LighthouseThresholdsV1;
  advisoryLighthouse?: LighthouseThresholdsV1;
  redesign?: boolean;
  performanceRisk?: boolean;
  changedPaths?: string[];
  scanComplete?: boolean;
  scanReason?: string;
  /**
   * A BOUNDED scan other than the baseline diff hit its hard bound during this
   * run: the structure walk's file cap, or COLLAPSE_MAX_FILES. It raises the
   * `uiImpact` floor exactly as an incomplete diff does, and it is a separate
   * input on purpose.
   *
   * Folding it into `scanComplete` would have been one line shorter and wrong.
   * `scanComplete: false` is a DEAD END: validateQaReportV2 rejects such a
   * contract outright (`scan-incomplete`), so a run that merely walked past a
   * generated tree too large to judge could never be certified at all. That
   * converts a legible early deny into an unexplained QA rejection paid for
   * after the whole implementation. `scanComplete` stays tied to the baseline
   * diff; the floor gets its own input.
   */
  boundedScanTruncated?: boolean;
}

export interface ChangedPathSnapshot {
  paths: string[];
  complete: boolean;
  reason?: string;
}

/**
 * The one incompleteness reason on this surface that names a gap the run cannot
 * close and does not have to: authored source Git declines to ignore, sitting
 * under a directory whose NAME the compile-time skip sets read as derived
 * (`nameSkippedProjectSource`).
 *
 * Every other reason a diff comes back incomplete describes a scan that could
 * not be trusted to have LOOKED — a symlink it refused to follow, a file cap it
 * hit, an ignore authority that moved under it. This one describes a scan that
 * looked, finished, and can name exactly what it stepped over, which is why it
 * is the one a consumer can honestly proceed on if it repeats the name.
 *
 * A MARKER inside the prose rather than a field beside it, for the same reason
 * `CHECK_INCONCLUSIVE_PREFIX` is one: the reason travels through
 * `VerificationContractV2.scanReason`, a persisted string, so a classification
 * carried alongside would be lost on the round trip through disk and the two
 * would then be free to disagree. It is the TAIL of the sentence, not the head,
 * so a contract compiled by a runtime that worded the subject differently is
 * still classified correctly on re-read.
 */
export const SKIP_NAME_DISCLOSURE_MARKER = 'hidden from the diff by a skipped directory name:';

/**
 * The incompleteness reason, when it is the disclosable one — otherwise null.
 *
 * Fail-closed by construction: anything this does not recognise stays fatal, so
 * a reason added later is refused until somebody decides it is disclosable.
 */
export function skipNameDisclosure(reason: string | undefined): string | null {
  return reason && reason.includes(SKIP_NAME_DISCLOSURE_MARKER) ? reason : null;
}

// Path-skip authority lives in architecture-contract (`isScanSkippedPath`) so
// baseline capture and every baseline-derived diff agree byte-for-byte about
