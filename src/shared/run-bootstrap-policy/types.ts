// src/shared/run-bootstrap-types.ts
// Envelope schema, per-role caps, bootstrap paths, and the quick-fix/
// maintenance scope bounds.

import * as path from 'path';
import type { HostModelKey } from '../../config/model-tiers';
import { RUNS_REL_DIR } from '../../config/state';
import {
  type CompiledArchitectureV1,
  type RuntimeAssignmentsV1,
  type WorkUnitContractV1,
} from '../architecture-contract';
import {
  RUN_HOST_CAPABILITY_RELATIVE_FILE,
} from '../host/capabilities';
import {
  type VerificationContractV2,
} from '../verification-contract';
import { sha256 } from '../text';

export const RUN_BOOTSTRAP_SCHEMA_VERSION = 2 as const;
// Hash-only envelopes are ~6-15 KB, so a deep history buys nothing; the v1
// body-carrying caps (32/128) allowed ~25 MB of dead weight per run.
export const RUN_BOOTSTRAP_MAX_PER_ROLE = 8;
export const RUN_BOOTSTRAP_MAX_PER_RUN = 32;

export interface BootstrapMaterialRefV2 {
  id: string;
  /** sha256 of the live plugin file body; the body itself is NOT embedded. */
  contentHash: string;
}

export interface RunBootstrapEnvelopeV2 {
  schemaVersion: typeof RUN_BOOTSTRAP_SCHEMA_VERSION;
  runId: string;
  host: HostModelKey;
  trafficOneRole: string;
  hostAgentType: string | null;
  roleSource: 'host-native' | 'plugin-injected-fallback';
  evidenceSource: string;
  hostCapability: {
    sidecar: typeof RUN_HOST_CAPABILITY_RELATIVE_FILE;
    capabilityHash: string;
    prevention: 'pre-tool' | 'completion-only';
    primaryBlockingPoint: string;
    primaryBlockingPointObserved: boolean;
    requiredBlockingPointsObserved: boolean;
  };
  modelPolicyId: string;
  architectureHash: string;
  role: BootstrapMaterialRefV2;
  rules: BootstrapMaterialRefV2[];
  skills: BootstrapMaterialRefV2[];
  /**
   * Compiled "definition of done" for the role (1.0.37, additive): the
   * integration facts the deterministic gates verify at IMPLEMENTED, stated
   * at spawn instead of discovered by the reviewer. Absent on pre-1.0.37
   * envelopes; the stored hash covers whatever shape was stored.
   */
  integrationRequirements?: string[];
  workUnit: WorkUnitContractV1;
  createdAt: string;
  envelopeHash: string;
}

export interface EnsureRunBootstrapOptions {
  host: HostModelKey;
  hostAgentType?: string | null;
  evidenceSource?: string;
  modelPolicyId: string;
  /**
   * Parent-resolved exact maintenance scope. Quick-fix and bounded
   * frontend/backend maintenance units consume these fields; ordinary planned
   * roles derive outputs from CompiledArchitectureV1.
   */
  boundedOutputs?: string[];
  boundedAllowlist?: string[];
  boundedAllowlistExclude?: string[];
}

export interface BootstrapRuntimeContractsV1 {
  architecture: CompiledArchitectureV1;
  verification: VerificationContractV2;
  assignments: RuntimeAssignmentsV1;
}

export function safePart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

export function quickFixDigestPath(runId: string): string {
  return `.traffic-one/digests/${safePart(runId)}/quick-fix.md`;
}

export function maintenanceDigestPath(runId: string, role: string): string {
  const suffix = role.replace(/^senior-/, '');
  return `.traffic-one/digests/${safePart(runId)}/${safePart(suffix)}.md`;
}

export function boundedMaintenanceSourceScope(
  runId: string,
  role: string,
  values: readonly string[],
): string[] {
  const digest = role === 'quick-fix'
    ? quickFixDigestPath(runId)
    : maintenanceDigestPath(runId, role);
  return values.filter((value) => value !== digest);
}


export function runBootstrapDir(cwd: string, runId: string): string {
  return path.join(cwd, RUNS_REL_DIR, safePart(runId), 'bootstrap');
}

export function roleBootstrapDir(cwd: string, runId: string, role: string): string {
  return path.join(runBootstrapDir(cwd, runId), safePart(role));
}

export function activeRunBootstrapPath(cwd: string, runId: string, role: string): string {
  return path.join(roleBootstrapDir(cwd, runId, role), 'active.json');
}
