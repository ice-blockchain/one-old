// src/shared/verification-contract-types.ts
// VerificationContractV2 schema: version, impact union, thresholds, and the
// compile options. Logic lives in the -git/-impact siblings; the public
// surface is re-exported by verification-contract.ts.

import {
  canonicalTrafficOneContextLink,
  contextAliasHash,
  isScanSkippedPath,
  stableContractJson,
  type ArchitectureBaselineV1,
  type CompiledArchitectureV1,
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
  changedRoutes: string[];
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
