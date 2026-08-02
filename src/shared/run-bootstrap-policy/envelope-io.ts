// src/shared/run-bootstrap-envelope-io.ts
// Envelope parse/validate/read, resolvability preflight, and immutable
// history pruning.

import * as fs from 'fs';
import * as path from 'path';
import type { HostModelKey } from '../../config/model-tiers';
import { RUNS_REL_DIR } from '../../config/state';
import {
  readArchitectureRunSnapshot,
  validateWorkUnitContract,
  type WorkUnitContractV1,
} from '../architecture-contract';
import {
  roleAgentBody,
} from '../skill-filters';
import { readJson } from '../fsjson';
import {
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
  roleSkippableWithoutAssignment,
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
    // A skippable scope-requiring role the compiled contract assigns nothing
    // is not part of this run: it can never spawn, so it must not veto
    // publication. See roleSkippableWithoutAssignment for the observed
    // PLAN_READY deadlock and why senior-tester stays load-bearing.
    if (roleSkippableWithoutAssignment(role)
      && !contracts.assignments.assignments.some((entry) => entry.role === role)) {
      return true;
    }
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
  const observedAllowlist = sha256(JSON.stringify({
    include: workUnit.allowlist,
    exclude: workUnit.allowlistExclude,
  }));
  interface DebtPin { contract: string; allowlist: string; sources: string[] | null; paid: boolean }
  const pins: DebtPin[] = [];
  const pinOf = (record: Record<string, unknown> | null | undefined): void => {
    if (!record) return;
    const paid = record.overallOutcome === 'fallback-paid';
    if (record.overallOutcome !== 'fallback-pending' && !paid) return;
    const contract = typeof record.workUnitContractHash === 'string' ? record.workUnitContractHash : '';
    const allowlist = typeof record.allowlistHash === 'string' ? record.allowlistHash : '';
    const baseline = record.fallbackSourceBaseline as { files?: Array<{ path?: unknown }> } | undefined;
    const sources = Array.isArray(baseline?.files)
      ? baseline.files
        .map((entry) => (typeof entry?.path === 'string' ? entry.path : ''))
        .filter(Boolean)
      : null;
    if (contract && allowlist) pins.push({ contract, allowlist, sources, paid });
  };
  const units = marker.units && typeof marker.units === 'object'
    ? Object.values(marker.units as Record<string, Record<string, unknown>>)
    : null;
  if (units) for (const record of units) pinOf(record);
  else pinOf(marker);
  const pending = pins.filter((pin) => !pin.paid);
  // A pending marker whose pins are unreadable stays fail-closed, as before.
  if (pending.length === 0) return false;
  if (pending.some((pin) => workUnit.contractHash === pin.contract && observedAllowlist === pin.allowlist)) {
    return true;
  }
  // The UNION envelope: exactly the debts' pinned source files, nothing more.
  // With per-unit debts a single paid child must be able to hold ONE envelope
  // covering every owed file — no publisher can synthesize a union otherwise,
  // so two debts for one role could never both be discharged and the settlement
  // stayed `fallback-pending` forever. SET EQUALITY, deliberately:
  // `every(pin ⊆ candidate)` would admit the union plus one extra file, which
  // is a widening — the exact backdoor this guard exists to refuse. A debt
  // without a readable baseline fails the union closed.
  //
  // PAID debts stay in the union: after a partial discharge the same envelope —
  // under which the paid child already delivered part of the batch — must stay
  // readable so the finalizer can discharge the remaining debts from it. That
  // admits nothing new (the identical envelope was admitted before the first
  // discharge), and the pending-only union is accepted too so a fresh child
  // scoped to just the remaining debts also binds.
  if (workUnit.unitId === `${role}:bounded-maintenance`) {
    const candidate = [...new Set(
      workUnit.allowlist.filter((entry) => !entry.startsWith('.traffic-one/')),
    )].sort();
    const unionOf = (subset: DebtPin[]): string | null => (
      subset.length > 0 && subset.every((pin) => pin.sources !== null)
        ? JSON.stringify([...new Set(subset.flatMap((pin) => pin.sources!))].sort())
        : null
    );
    const candidateKey = JSON.stringify(candidate);
    if (candidate.length > 0
      && (candidateKey === unionOf(pending) || candidateKey === unionOf(pins))) {
      return true;
    }
  }
  // A DISJOINT sibling bounded unit is not a widening. The guard exists so the
  // owed fallback's contract cannot be widened or REPLACED before it is
  // finalized — voiding every non-matching envelope was what killed unit 2 of
  // the 16co news batch in 28ms pre-model. Each debt keeps its own pin in the
  // per-unit ledger, so the admissibility test is per-debt:
  //   - only `<role>:bounded-maintenance` (a batch shape) qualifies; quick-fix
  //     is single-unit by design and a different scope IS a replacement;
  //   - the candidate's source scope must be disjoint from EVERY pending
  //     debt's pinned source files — touching an owed file is a takeover, and
  //     every legal queue is disjoint anyway (overlap requires `depends:`, and
  //     dependents of a failed producer are skipped pre-model);
  //   - a pending debt without a readable baseline fails closed.
  // Full-scope envelopes never qualify — that is the widening the guard was
  // built against, and exactly the 21:44:55 write that wedged 16co.
  if (workUnit.unitId !== `${role}:bounded-maintenance`) return false;
  const candidateSources = workUnit.allowlist.filter((entry) => !entry.startsWith('.traffic-one/'));
  return pending.every((pin) => (
    pin.sources !== null
    && candidateSources.every((candidate) => !pin.sources!.includes(candidate))
  ));
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

/**
 * Does a role owe a PENDING maintenance fallback?
 *
 * While it does, `fallbackContractMatches` admits ONLY the debts' own bounded
 * scope for that role: every other envelope — including the role's planned
 * full-scope one — is a widening and is refused by design. A publisher that
 * cannot derive that bounded scope must therefore treat the refusal as "this
 * role is temporarily unpublishable", never as "this run is broken".
 */
export function roleOwesPendingMaintenanceFallback(
  cwd: string,
  runId: string,
  role: string,
): boolean {
  const marker = readJson<Record<string, unknown> | null>(
    path.join(cwd, RUNS_REL_DIR, safePart(runId), 'maintenance.json'),
    null,
  );
  return Boolean(marker
    && marker.overallOutcome === 'fallback-pending'
    && maintenanceRole(marker.role) === role);
}

/**
 * The union of every pending maintenance debt's pinned source files for a role,
 * or null when nothing is pending (or any pending debt's baseline is
 * unreadable — the union must never be a guess).
 *
 * This is how a paid fallback child gets ONE envelope covering every owed file:
 * the spawn gate derives its bounded scope from this union, the union branch in
 * `fallbackContractMatches` admits exactly that envelope, and the finalizer
 * discharges each covered debt on its own delta.
 */
export function pendingMaintenanceDebtSources(
  cwd: string,
  runId: string,
  role: string,
): string[] | null {
  const marker = readJson<Record<string, unknown> | null>(
    path.join(cwd, RUNS_REL_DIR, safePart(runId), 'maintenance.json'),
    null,
  );
  if (!marker || marker.overallOutcome !== 'fallback-pending' || maintenanceRole(marker.role) !== role) return null;
  const records = marker.units && typeof marker.units === 'object'
    ? Object.values(marker.units as Record<string, Record<string, unknown>>)
    : [marker];
  const union = new Set<string>();
  let pending = 0;
  for (const record of records) {
    if (record.overallOutcome !== 'fallback-pending') continue;
    pending += 1;
    const baseline = record.fallbackSourceBaseline as { files?: Array<{ path?: unknown }> } | undefined;
    const files = Array.isArray(baseline?.files) ? baseline.files : null;
    if (!files) return null;
    for (const entry of files) {
      if (typeof entry?.path === 'string' && entry.path) union.add(entry.path);
    }
  }
  return pending > 0 && union.size > 0 ? [...union].sort() : null;
}
