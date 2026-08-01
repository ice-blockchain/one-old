// src/shared/run-bootstrap-policy/index.ts
// Run bootstrap envelopes (schemaVersion 2). Barrel + the write path: the
// heavy lifting lives in the -types/-materials/-work-unit/-envelope-io
// siblings; this file keeps ensureRunBootstrap/repair and re-exports the
// original public surface.

import * as fs from 'fs';
import {
  ensureArchitectureRunSnapshot,
  validateWorkUnitContract,
  type WorkUnitContractV1,
} from '../architecture-contract';
import { readJson, writeJson } from '../fsjson';
import {
  ensureRunHostCapability,
  RUN_HOST_CAPABILITY_RELATIVE_FILE,
} from '../host/capabilities';
import { readRunModelPolicy } from '../run-model-policy';

import {
  RUN_BOOTSTRAP_SCHEMA_VERSION,
  activeRunBootstrapPath,
  boundedMaintenanceSourceScope,
  type EnsureRunBootstrapOptions,
  type RunBootstrapEnvelopeV2,
} from './types';
import {
  hashEnvelope,
  resolvedRoleMaterials,
} from './materials';
import {
  workUnitForRole,
} from './work-unit';
import {
  fallbackContractMatches,
  immutableEnvelopePath,
  pruneBootstrapHistory,
  readActiveRunBootstrap,
} from './envelope-io';
import {
  compileIntegrationRequirements,
} from './integration-requirements';

export function ensureRunBootstrap(
  cwd: string,
  runId: string,
  role: string,
  state: unknown,
  options: EnsureRunBootstrapOptions,
): RunBootstrapEnvelopeV2 | null {
  if (!runId.trim() || !role.trim() || !options.modelPolicyId.trim()) return null;
  let snapshot;
  try {
    snapshot = ensureArchitectureRunSnapshot(cwd, runId, state);
  } catch {
    return null;
  }
  // Bootstrap materials are derived only from the immutable capability profile
  // and host. Mutable project state must not make validation non-reproducible
  // after the parent has published the envelope.
  const resolved = resolvedRoleMaterials(cwd, role, {}, options.host, snapshot.profile);
  if (!resolved) return null;
  const hostCapability = ensureRunHostCapability(cwd, runId, options.host, {
    ...(options.host === 'claude' ? { point: 'native-bootstrap' } : {}),
    event: 'bootstrap-published',
    source: 'runtime-bootstrap',
  });
  if (!hostCapability) return null;
  const hostAgentType = options.hostAgentType || null;
  const workUnit = workUnitForRole(cwd, runId, role, hostAgentType, resolved, snapshot, options);
  if (!workUnit) return null;
  if (!fallbackContractMatches(cwd, runId, role, workUnit)) return null;
  const roleSource = options.hostAgentType
    ? 'host-native' as const
    : 'plugin-injected-fallback' as const;
  const integrationRequirements = compileIntegrationRequirements(
    role,
    snapshot.profile.surfaces,
    workUnit.outputs,
  );
  const canonical = {
    schemaVersion: RUN_BOOTSTRAP_SCHEMA_VERSION,
    runId,
    host: options.host,
    trafficOneRole: role,
    hostAgentType,
    roleSource,
    evidenceSource: options.evidenceSource || 'runtime-resolved',
    ...(integrationRequirements.length ? { integrationRequirements } : {}),
    hostCapability: {
      sidecar: RUN_HOST_CAPABILITY_RELATIVE_FILE as typeof RUN_HOST_CAPABILITY_RELATIVE_FILE,
      capabilityHash: hostCapability.capabilityHash,
      prevention: hostCapability.prevention,
      primaryBlockingPoint: hostCapability.primaryBlockingPoint,
      primaryBlockingPointObserved: hostCapability.primaryBlockingPointObserved,
      requiredBlockingPointsObserved: hostCapability.requiredBlockingPointsObserved,
    },
    modelPolicyId: options.modelPolicyId,
    architectureHash: workUnit.architectureHash,
    ...resolved,
    workUnit,
  };
  const envelopeHash = hashEnvelope(canonical);
  const existing = readActiveRunBootstrap(cwd, runId, role);
  if (existing?.envelopeHash === envelopeHash) return existing;
  const envelope: RunBootstrapEnvelopeV2 = {
    ...canonical,
    createdAt: new Date().toISOString(),
    envelopeHash,
  };
  const immutable = immutableEnvelopePath(cwd, runId, role, envelopeHash);
  if (!fs.existsSync(immutable)) writeJson(immutable, envelope);
  // Publish active last. A child can see either the old complete envelope or
  // the new complete envelope, never a partial bootstrap.
  writeJson(activeRunBootstrapPath(cwd, runId, role), envelope);
  const verified = readActiveRunBootstrap(cwd, runId, role);
  if (!verified || verified.envelopeHash !== envelopeHash) return null;
  // No per-run context-pack snapshot is compiled any more: rule/skill bodies
  // live in the project's materialized `.traffic-one/rules|skills` tree, the
  // envelope's {id, contentHash} refs are the integrity chain, and the child's
  // SessionStart header renders integrationRequirements + the role kernel.
  pruneBootstrapHistory(cwd, runId);
  return verified;
}

// Republish a MISSING envelope for a child that is already bound to this run.
// Every publisher is otherwise a parent-side pre-spawn gate, so a child that
// outlived a run change was permanently write-dead: bound, in-scope, and denied
// on every tool call with nothing able to repair it (observed test-laravel — the
// senior-backend child rebound into a run that had no bootstrap for it).
//
// This grants no authority the parent would not have granted. Every input is a
// run immutable — the architecture snapshot (throws if absent), the frozen
// capability profile, the compiled work unit — and ensureRunBootstrap re-reads
// and re-verifies the result before returning, so it either reproduces a valid
// envelope or returns null and the caller's existing denies stand.
export function repairRunBootstrapForBoundChild(
  cwd: string,
  runId: string,
  role: string,
  state: unknown,
  hostAgentType?: string | null,
): RunBootstrapEnvelopeV2 | null {
  if (!runId.trim() || !role.trim()) return null;
  // Only ever fills a HOLE. An existing envelope is authoritative and is never
  // replaced from the child side.
  if (readActiveRunBootstrap(cwd, runId, role)) return null;
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy) return null;
  // Bounded-maintenance scope recovery: planned roles re-derive their contract
  // from run immutables, but a bounded child's exact scope exists only in the
  // envelope being repaired. Recover it from the stale active file's workUnit —
  // trustworthy regardless of envelope schema because WorkUnitContractV1 is
  // self-hashing — so a live quick-fix/bounded child survives an envelope-schema
  // upgrade instead of wedging. This grants nothing new: the scope comes from a
  // hash-validated contract the parent published.
  const stale = readJson<{ workUnit?: unknown } | null>(activeRunBootstrapPath(cwd, runId, role), null);
  const staleUnit = stale?.workUnit;
  const bounded: Pick<
    EnsureRunBootstrapOptions,
    'boundedOutputs' | 'boundedAllowlist' | 'boundedAllowlistExclude'
  > = {};
  if (
    validateWorkUnitContract(staleUnit)
    && staleUnit.runId === runId
    && staleUnit.trafficOneRole === role
    && (role === 'quick-fix' || staleUnit.unitId === `${role}:bounded-maintenance`)
  ) {
    bounded.boundedOutputs = boundedMaintenanceSourceScope(runId, role, staleUnit.outputs);
    bounded.boundedAllowlist = boundedMaintenanceSourceScope(runId, role, staleUnit.allowlist);
    bounded.boundedAllowlistExclude = staleUnit.allowlistExclude;
  }
  try {
    return ensureRunBootstrap(cwd, runId, role, state, {
      host: policy.host,
      hostAgentType: hostAgentType || null,
      evidenceSource: 'child-side-repair',
      modelPolicyId: policy.policyId,
      ...bounded,
    });
  } catch {
    return null;
  }
}


export {
  RUN_BOOTSTRAP_MAX_PER_ROLE,
  RUN_BOOTSTRAP_MAX_PER_RUN,
  RUN_BOOTSTRAP_SCHEMA_VERSION,
  activeRunBootstrapPath,
  boundedMaintenanceSourceScope,
  quickFixDigestPath,
  type BootstrapMaterialRefV2,
  type BootstrapRuntimeContractsV1,
  type EnsureRunBootstrapOptions,
  type RunBootstrapEnvelopeV2,
} from './types';

export {
  resolvedRoleSkillIds,
} from './materials';

export {
  canResolveRunBootstrapSet,
  readActiveRunBootstrap,
} from './envelope-io';

export {
  compileIntegrationRequirements,
} from './integration-requirements';
