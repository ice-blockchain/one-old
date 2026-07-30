// src/shared/architecture-contract/types.ts
// Schema versions and every V1 interface of the architecture contract.

import * as path from 'path';
import {
  type CapabilityProfileV1,
} from '../capabilities';

export const ARCHITECTURE_INPUT_SCHEMA_VERSION = 1 as const;
export const COMPILED_ARCHITECTURE_SCHEMA_VERSION = 1 as const;
export const WORK_UNIT_CONTRACT_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_SCAN_MAX_FILES = 10_000;

export type ArchitectureModuleKind =
  | 'app-shell'
  | 'page'
  | 'component'
  | 'feature'
  | 'service'
  | 'store'
  | 'test';

export interface ArchitectureRouteInputV1 {
  id: string;
  path: string;
  moduleId: string;
  redirect?: boolean;
}

export interface ArchitectureModuleInputV1 {
  id: string;
  name: string;
  kind: ArchitectureModuleKind;
  placement?: 'app' | 'shared-ui';
}

export interface ArchitectureExceptionRequestV1 {
  ruleId: string;
  glob: string;
  reason: string;
}

export interface ArchitectureI18nInputV1 {
  sourceLocale: string;
  locales: string[];
  literalBrands?: string[];
}

export interface ArchitectureInputV1 {
  schemaVersion: typeof ARCHITECTURE_INPUT_SCHEMA_VERSION;
  routes: ArchitectureRouteInputV1[];
  modules: ArchitectureModuleInputV1[];
  i18n?: ArchitectureI18nInputV1;
  uiPrimitives?: string[];
  exceptions?: ArchitectureExceptionRequestV1[];
}

export interface ArchitectureBaselineV1 {
  kind: 'git-head' | 'file-manifest';
  identity: string;
  capturedAt: string;
  filesHash?: string;
  fileCount?: number;
  files?: Array<{ path: string; hash: string }>;
  /** Immutable non-Git directory evidence, including empty framework roots. */
  directories?: string[];
}

export interface ArchitectureRunSnapshotV1 {
  schemaVersion: typeof ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION;
  runId: string;
  profile: CapabilityProfileV1;
  baselineIdentity: string;
  baselineHash: string;
  capturedAt: string;
  snapshotHash: string;
}

export interface ArchitectureRunBaselineV1 {
  schemaVersion: typeof ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION;
  runId: string;
  baseline: ArchitectureBaselineV1;
  baselineHash: string;
}

export interface CompiledArchitectureModuleV1 extends ArchitectureModuleInputV1 {
  ownerRole: string;
  output: string;
}

interface CompiledArchitectureRouteV1 extends ArchitectureRouteInputV1 {
  moduleOutput: string;
}

export type CompiledOutputKindV1 =
  | 'module'
  | 'entrypoint'
  | 'scaffold'
  | 'test'
  | 'test-infra';

export interface CompiledArchitectureOutputV1 {
  path: string;
  ownerRole: string;
  kind: CompiledOutputKindV1;
}

export type CompiledI18nCatalogFormatV1 =
  | 'json'
  | 'xlf'
  | 'php'
  | 'xcstrings'
  | 'android-xml'
  | 'arb';

export interface CompiledI18nCatalogV1 {
  path: string;
  format: CompiledI18nCatalogFormatV1;
  locales: string[];
  namespaces: string[];
}

export interface CompiledI18nContractV1 {
  sourceLocale: string;
  locales: string[];
  literalBrands: string[];
  namespaces: string[];
  reactCatalogLayout: boolean;
  catalogs: CompiledI18nCatalogV1[];
  runtimeOutputs: string[];
}

export interface CompiledArchitectureV1 {
  schemaVersion: typeof COMPILED_ARCHITECTURE_SCHEMA_VERSION;
  runId: string;
  profile: CapabilityProfileV1;
  baseline: ArchitectureBaselineV1;
  sourceRoots: string[];
  entrypoints: string[];
  layers: CapabilityProfileV1['layerRoots'];
  routes: CompiledArchitectureRouteV1[];
  modules: CompiledArchitectureModuleV1[];
  /** Exact adapter component identifiers selected by catalog-first planning. */
  uiPrimitives?: string[];
  /** Resolved only for UI projects whose run owns or explicitly declares i18n. */
  i18n?: CompiledI18nContractV1;
  /**
   * Runtime-derived scaffold/test outputs. Optional on read so v1.0.19
   * sidecars remain ignorable/parseable; every newly compiled contract emits
   * the field and covers it with contractHash.
   */
  scaffoldOutputs?: CompiledArchitectureOutputV1[];
  allowedOutputs: string[];
  exceptions: ArchitectureExceptionRequestV1[];
  inputHash: string;
  contractHash: string;
}

interface ResolvedPolicyMaterialV1 {
  id: string;
  contentHash: string;
}

export interface WorkUnitContractV1 {
  schemaVersion: typeof WORK_UNIT_CONTRACT_SCHEMA_VERSION;
  runId: string;
  unitId: string;
  trafficOneRole: string;
  hostAgentType: string | null;
  rules: ResolvedPolicyMaterialV1[];
  skills: ResolvedPolicyMaterialV1[];
  outputs: string[];
  allowlist: string[];
  allowlistExclude: string[];
  architectureHash: string;
  verificationHash: string;
  contractHash: string;
}

export interface ArchitectureValidationResult {
  ok: boolean;
  errors: string[];
}

export interface RuntimeAssignmentEntryV1 {
  role: string;
  summary: string;
  scope: {
    include: string[];
    exclude: string[];
  };
}

export interface RuntimeAssignmentsV1 {
  version: 1;
  schemaVersion: 1;
  runId: string;
  createdBy: 'traffic-one-runtime';
  architectureHash: string;
  verificationHash: string;
  assignments: RuntimeAssignmentEntryV1[];
  assignmentsHash: string;
}
