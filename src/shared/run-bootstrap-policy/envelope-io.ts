// src/shared/run-bootstrap-envelope-io.ts
// Envelope parse/validate/read, resolvability preflight, and immutable
// history pruning.

import * as fs from 'fs';
import * as path from 'path';
import type { HostModelKey } from '../../config/model-tiers';
import { RUNS_REL_DIR } from '../../config/state';
import {
  createWorkUnitContract,
  ensureArchitectureRunSnapshot,
  readArchitectureRunSnapshot,
  readCompiledArchitecture,
  readRuntimeAssignments,
  validateWorkUnitContract,
  type ArchitectureRunSnapshotV1,
  type CompiledArchitectureV1,
  type RuntimeAssignmentsV1,
  type WorkUnitContractV1,
} from '../architecture-contract';
import {
  activeSkillsForProfile,
  activeSkillsForProject,
  roleAgentBody,
  roleDeclaredSkills,
} from '../skill-filters';
import { readJson, writeJson } from '../fsjson';
import {
  ensureRunHostCapability,
  readRunHostCapability,
  RUN_HOST_CAPABILITY_RELATIVE_FILE,
} from '../host/capabilities';
import { sha256 } from '../text';

import {
  RUN_BOOTSTRAP_MAX_PER_ROLE,
  RUN_BOOTSTRAP_MAX_PER_RUN,
  RUN_BOOTSTRAP_SCHEMA_VERSION,
  activeRunBootstrapPath,
  boundedMaintenanceSourceScope,
  roleBootstrapDir,
  runBootstrapDir,
  safePart,
  type BootstrapRuntimeContractsV1,
  type RunBootstrapEnvelopeV2,
} from './types';
import {
  hashEnvelope,
  resolvedRoleMaterials,
  ruleContent,
  skillContent,
  stableEqual,
} from './materials';
import {
  workUnitForRole,
} from './work-unit';

export function canResolveRunBootstrapSet(
  cwd: string,
  runId: string,
  roles: readonly string[],
  host: HostModelKey,
  typedSubagents: boolean,
  contracts: BootstrapRuntimeContractsV1,
): boolean {
  const snapshot = readArchitectureRunSnapshot(cwd, runId);
  const capability = readRunHostCapability(cwd, runId, host);
  if (!snapshot
    || !capability
    || contracts.architecture.runId !== runId
    || contracts.verification.runId !== runId
    || contracts.assignments.runId !== runId
    || contracts.assignments.architectureHash !== contracts.architecture.contractHash
    || contracts.assignments.verificationHash !== contracts.verification.contractHash) return false;
  return roles.every((role) => {
    const resolved = resolvedRoleMaterials(cwd, role, {}, host, snapshot.profile);
    return Boolean(resolved && workUnitForRole(
      cwd,
      runId,
      role,
      typedSubagents ? role : null,
      resolved,
      snapshot,
      {},
      contracts,
    ));
  });
}

function maintenanceRole(value: unknown): string {
  const role = typeof value === 'string' ? value.trim() : '';
  if (role.startsWith('senior-') || role === 'quick-fix') return role;
  if (role === 'frontend') return 'senior-frontend';
  if (role === 'backend') return 'senior-backend';
  if (role === 'tester') return 'senior-tester';
  if (role === 'docs') return 'senior-architect';
  return role;
}

export function fallbackContractMatches(
  cwd: string,
  runId: string,
  role: string,
  workUnit: WorkUnitContractV1,
): boolean {
  const marker = readJson<Record<string, unknown> | null>(
    path.join(cwd, RUNS_REL_DIR, safePart(runId), 'maintenance.json'),
    null,
  );
  if (!marker || marker.overallOutcome !== 'fallback-pending' || maintenanceRole(marker.role) !== role) return true;
  const expectedContract = typeof marker.workUnitContractHash === 'string'
    ? marker.workUnitContractHash
    : '';
  const expectedAllowlist = typeof marker.allowlistHash === 'string' ? marker.allowlistHash : '';
  if (!expectedContract || !expectedAllowlist) return false;
  const observedAllowlist = sha256(JSON.stringify({
    include: workUnit.allowlist,
    exclude: workUnit.allowlistExclude,
  }));
  return workUnit.contractHash === expectedContract && observedAllowlist === expectedAllowlist;
}

function parseEnvelope(value: unknown, runId: string, role: string): RunBootstrapEnvelopeV2 | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RunBootstrapEnvelopeV2>;
  if (
    raw.schemaVersion !== RUN_BOOTSTRAP_SCHEMA_VERSION
    || raw.runId !== runId
    || raw.trafficOneRole !== role
    || typeof raw.envelopeHash !== 'string'
    || typeof raw.modelPolicyId !== 'string'
    || typeof raw.architectureHash !== 'string'
    || !raw.hostCapability
    || raw.hostCapability.sidecar !== RUN_HOST_CAPABILITY_RELATIVE_FILE
    || typeof raw.hostCapability.capabilityHash !== 'string'
    || (raw.hostCapability.prevention !== 'pre-tool'
      && raw.hostCapability.prevention !== 'completion-only')
    || typeof raw.hostCapability.primaryBlockingPoint !== 'string'
    || typeof raw.hostCapability.primaryBlockingPointObserved !== 'boolean'
    || typeof raw.hostCapability.requiredBlockingPointsObserved !== 'boolean'
    || !raw.role
    || !Array.isArray(raw.rules)
    || !Array.isArray(raw.skills)
    || !raw.workUnit
  ) return null;
  const { envelopeHash, createdAt: _createdAt, ...canonical } = raw;
  if (hashEnvelope(canonical) !== envelopeHash) return null;
  const all = [raw.role, ...raw.rules, ...raw.skills];
  if (all.some((entry) => (
    !entry
    || typeof entry.id !== 'string'
    || typeof entry.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.contentHash)
  ))) return null;
  if (!validateWorkUnitContract(raw.workUnit)) return null;
  return raw as RunBootstrapEnvelopeV2;
}

export function readActiveRunBootstrap(
  cwd: string,
  runId: string,
  role: string,
): RunBootstrapEnvelopeV2 | null {
  const raw = readJson<unknown>(activeRunBootstrapPath(cwd, runId, role), null);
  const envelope = parseEnvelope(raw, runId, role);
  if (!envelope) return null;
  const immutable = parseEnvelope(
    readJson<unknown>(immutableEnvelopePath(cwd, runId, role, envelope.envelopeHash), null),
    runId,
    role,
  );
  if (!immutable || immutable.envelopeHash !== envelope.envelopeHash) return null;
  // Bodies are validated against the live plugin files by hash — the disk read
  // still happens on every validation, so a missing or edited plugin file
  // invalidates the envelope exactly as the v1 byte-for-byte comparison did.
  const roleBody = roleAgentBody(role);
  if (!roleBody || sha256(roleBody) !== envelope.role.contentHash) return null;
  if (new Set(envelope.rules.map((entry) => entry.id)).size !== envelope.rules.length
    || new Set(envelope.skills.map((entry) => entry.id)).size !== envelope.skills.length
    || envelope.rules.some((entry) => {
      const content = ruleContent(entry.id);
      return !content || sha256(content) !== entry.contentHash;
    })
    || envelope.skills.some((entry) => {
      const content = skillContent(entry.id);
      return !content || sha256(content) !== entry.contentHash;
    })) return null;
  const snapshot = readArchitectureRunSnapshot(cwd, runId);
  if (!snapshot) return null;
  const resolved = resolvedRoleMaterials(cwd, role, {}, envelope.host, snapshot.profile);
  if (!resolved
    || !stableEqual(resolved.role, envelope.role)
    || !stableEqual(resolved.rules, envelope.rules)
    || !stableEqual(resolved.skills, envelope.skills)) return null;
  const expectedWorkUnit = workUnitForRole(
    cwd,
    runId,
    role,
    envelope.hostAgentType,
    resolved,
    snapshot,
    role === 'quick-fix' || envelope.workUnit.unitId === `${role}:bounded-maintenance`
      ? {
          boundedOutputs: boundedMaintenanceSourceScope(runId, role, envelope.workUnit.outputs),
          boundedAllowlist: boundedMaintenanceSourceScope(runId, role, envelope.workUnit.allowlist),
          boundedAllowlistExclude: envelope.workUnit.allowlistExclude,
        }
      : {},
  );
  if (!expectedWorkUnit
    || expectedWorkUnit.contractHash !== envelope.workUnit.contractHash
    || envelope.architectureHash !== envelope.workUnit.architectureHash
    || !fallbackContractMatches(cwd, runId, role, envelope.workUnit)) return null;
  const capability = readRunHostCapability(cwd, runId, envelope.host);
  if (!capability
    || capability.capabilityHash !== envelope.hostCapability.capabilityHash
    || capability.primaryBlockingPoint !== envelope.hostCapability.primaryBlockingPoint
    // Observations are monotonic. A completion-only bootstrap remains valid
    // when a later child invocation proves the real pre-tool point, while a
    // bootstrap that already pinned pre-tool prevention can never be satisfied
    // by downgraded evidence.
    || (envelope.hostCapability.prevention === 'pre-tool'
      && capability.prevention !== 'pre-tool')
    || (envelope.hostCapability.primaryBlockingPointObserved
      && !capability.primaryBlockingPointObserved)
    || (envelope.hostCapability.requiredBlockingPointsObserved
      && !capability.requiredBlockingPointsObserved)) return null;
  return envelope;
}

export function immutableEnvelopePath(cwd: string, runId: string, role: string, hash: string): string {
  return path.join(roleBootstrapDir(cwd, runId, role), `${hash}.json`);
}

function activeHashes(cwd: string, runId: string): Set<string> {
  const active = new Set<string>();
  const root = runBootstrapDir(cwd, runId);
  let roles: fs.Dirent[];
  try { roles = fs.readdirSync(root, { withFileTypes: true }); } catch { return active; }
  for (const role of roles) {
    if (!role.isDirectory()) continue;
    const envelope = readJson<Partial<RunBootstrapEnvelopeV2> | null>(
      path.join(root, role.name, 'active.json'),
      null,
    );
    if (typeof envelope?.envelopeHash === 'string') active.add(envelope.envelopeHash);
  }
  return active;
}

export function pruneBootstrapHistory(cwd: string, runId: string): void {
  const root = runBootstrapDir(cwd, runId);
  const protectedHashes = activeHashes(cwd, runId);
  const candidates: Array<{ file: string; hash: string; mtimeMs: number; role: string }> = [];
  let roles: fs.Dirent[];
  try { roles = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const role of roles) {
    if (!role.isDirectory()) continue;
    const roleDir = path.join(root, role.name);
    let files: fs.Dirent[];
    try { files = fs.readdirSync(roleDir, { withFileTypes: true }); } catch { continue; }
    const roleFiles: Array<{ file: string; hash: string; mtimeMs: number; role: string }> = [];
    for (const file of files) {
      if (!file.isFile() || file.name === 'active.json' || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const absolute = path.join(roleDir, file.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(absolute).mtimeMs; } catch { continue; }
      roleFiles.push({ file: absolute, hash: file.name.slice(0, -5), mtimeMs, role: role.name });
    }
    roleFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of roleFiles.slice(RUN_BOOTSTRAP_MAX_PER_ROLE)) {
      if (!protectedHashes.has(item.hash)) {
        try { fs.rmSync(item.file, { force: true }); } catch { /* best effort */ }
      }
    }
    candidates.push(...roleFiles.slice(0, RUN_BOOTSTRAP_MAX_PER_ROLE));
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of candidates.slice(RUN_BOOTSTRAP_MAX_PER_RUN)) {
    if (!protectedHashes.has(item.hash)) {
      try { fs.rmSync(item.file, { force: true }); } catch { /* best effort */ }
    }
  }
}
