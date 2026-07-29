// src/shared/run-settlement-types.ts
// Settlement schema, canonical statuses, paths, stable hash, and the semver
// gate. Logic lives in the -projection/-io/-reconcile siblings.

import * as path from 'path';
import { sha256 } from '../text';

export const RUN_SETTLEMENT_SCHEMA_VERSION = 2 as const;
export const RUN_SETTLEMENT_MIN_RUNTIME_VERSION = '1.0.20';

export type CanonicalRunStatus =
  | 'planned'
  | 'active'
  | 'code-delivered'
  | 'validating'
  | 'verified'
  | 'failed'
  | 'blocked';

export interface RunSettlementV2 {
  schemaVersion: typeof RUN_SETTLEMENT_SCHEMA_VERSION;
  runId: string;
  runtimeVersion: string;
  minimumRuntimeVersion: string;
  status: CanonicalRunStatus;
  reason?: string;
  workUnitContractHash?: string;
  allowlistHash?: string;
  fallback?: {
    state: 'pending' | 'completed' | 'not-allowed';
    workUnitContractHash: string;
    allowlistHash: string;
  };
  activeClaims: number;
  incompleteChecks: string[];
  revision: number;
  updatedAt: string;
  settlementHash: string;
}

export interface SettlementUpdate {
  status: CanonicalRunStatus;
  reason?: string;
  workUnitContractHash?: string;
  allowlistHash?: string;
  fallback?: RunSettlementV2['fallback'];
  incompleteChecks?: string[];
}

export interface RunV2RollbackBarrierProjection {
  version: number;
  runId: string;
  status: 'failed';
  outcome: 'agent-failed';
  qaContractVersion: 2;
  canonicalStatus: 'active' | 'code-delivered' | 'validating';
  runtimeV2RollbackGuard: {
    minimumRuntimeVersion: string;
    canonicalStatus: 'active' | 'code-delivered' | 'validating';
  };
  [key: string]: unknown;
}

export type Rec = Record<string, unknown>;

export function safeRunId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

export function runDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', safeRunId(runId));
}

export function runSettlementPath(projectRoot: string, runId: string): string {
  return path.join(runDir(projectRoot, runId), 'settlement-v2.json');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Rec)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

export function settlementHash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function semverTuple(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function runtimeVersionSatisfies(
  observed: string,
  minimum: string,
): boolean {
  const left = semverTuple(observed);
  const right = semverTuple(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}
