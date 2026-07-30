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

export interface LighthouseThresholdsV1 {
  performanceMin?: number;
  accessibilityMin?: number;
  bestPracticesMin?: number;
  seoMin?: number;
  lcpMaxMs?: number;
  clsMax?: number;
  inpMaxMs?: number;
}

export interface PerformanceContractV1 {
  required: boolean;
  reason: 'not-required' | 'redesign' | 'visual-risk' | 'performance-risk' | 'explicit';
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
}

export interface ChangedPathSnapshot {
  paths: string[];
  complete: boolean;
  reason?: string;
}

// Path-skip authority lives in architecture-contract (`isScanSkippedPath`) so
// baseline capture and every baseline-derived diff agree byte-for-byte about
