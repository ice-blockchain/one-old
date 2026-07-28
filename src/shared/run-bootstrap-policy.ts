// Parent-created bootstrap envelope: a hash manifest + work-unit contract. It is
// written atomically before a child is allowed to spawn and validated again on
// the child's first tool call. Children may consume it but can never create or
// replace it. Role/rule/skill BODIES are not embedded (schemaVersion 2): they
// live in the installed plugin (re-read from disk on every validation) and are
// materialized for agents under .traffic-one/rules/** and .traffic-one/skills/**.

import * as fs from 'fs';
import * as path from 'path';

import type { HostModelKey } from '../config/model-tiers';
import { RUNS_REL_DIR } from '../config/state';
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
} from './architecture-contract';
import { pluginRoot } from './paths';
import {
  activeSkillsForProfile,
  activeSkillsForProject,
  roleAgentBody,
  roleDeclaredSkills,
} from './skill-filters';
import {
  eligibleRolesForProfile,
  runtimeCapabilityStateFromProfile,
  type CapabilityProfileV1,
} from './capabilities';
import { roleScopedRules, templatePath } from './stacks';
import { readJson, writeJson } from './fsjson';
import {
  ensureRunHostCapability,
  readRunHostCapability,
  RUN_HOST_CAPABILITY_RELATIVE_FILE,
} from './host-capabilities';
import { readRunModelPolicy } from './run-model-policy';
import {
  readVerificationContract,
  type VerificationContractV2,
} from './verification-contract';
import { sha256 } from './text';

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

function safePart(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

export function quickFixDigestPath(runId: string): string {
  return `.traffic-one/digests/${safePart(runId)}/quick-fix.md`;
}

function maintenanceDigestPath(runId: string, role: string): string {
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

export function quickFixSourceScope(
  runId: string,
  values: readonly string[],
): string[] {
  return boundedMaintenanceSourceScope(runId, 'quick-fix', values);
}

function runBootstrapDir(cwd: string, runId: string): string {
  return path.join(cwd, RUNS_REL_DIR, safePart(runId), 'bootstrap');
}

function roleBootstrapDir(cwd: string, runId: string, role: string): string {
  return path.join(runBootstrapDir(cwd, runId), safePart(role));
}

export function activeRunBootstrapPath(cwd: string, runId: string, role: string): string {
  return path.join(roleBootstrapDir(cwd, runId, role), 'active.json');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function hashEnvelope(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function readFirst(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, 'utf8');
      if (text.trim()) return text;
    } catch {
      // try the next installed/source layout
    }
  }
  return null;
}

// Still takes the body read from disk: hashing it here is the fail-closed proof
// that the material is resolvable at publish time. Only the hash is stored.
function material(id: string, content: string): BootstrapMaterialRefV2 {
  return { id, contentHash: sha256(content) };
}

function ruleContent(relPath: string): string | null {
  const root = pluginRoot();
  return readFirst([
    path.join(root, templatePath(relPath)),
    path.join(root, 'dist', templatePath(relPath)),
    path.join(root, 'src', 'modules', 'rules', templatePath(relPath)),
  ]);
}

function skillContent(name: string): string | null {
  const root = pluginRoot();
  return readFirst([
    path.join(root, 'skills-catalog', name, 'SKILL.md'),
    path.join(root, 'dist', 'skills-catalog', name, 'SKILL.md'),
    path.join(root, 'src', 'modules', 'skills', 'skills-catalog', name, 'SKILL.md'),
  ]);
}

export function resolvedRoleSkillIds(
  active: Iterable<string>,
  declared: ReadonlySet<string> | null,
): string[] | null {
  if (!declared) return null;
  return [...active].filter((name) => declared.has(name)).sort();
}

function resolvedRoleMaterials(
  cwd: string,
  role: string,
  state: unknown,
  host: HostModelKey,
  profile?: CapabilityProfileV1,
): { role: BootstrapMaterialRefV2; rules: BootstrapMaterialRefV2[]; skills: BootstrapMaterialRefV2[] } | null {
  if (role !== 'quick-fix' && !(profile
    ? eligibleRolesForProfile(profile)
    : new Set<string>()).has(role)) return null;
  const capabilityState = profile
    ? runtimeCapabilityStateFromProfile(profile, state)
    : state;
  const roleBody = roleAgentBody(role);
  if (!roleBody) return null;
  const ruleIds = roleScopedRules(role, capabilityState);
  if (!ruleIds) return null;
  const rules: BootstrapMaterialRefV2[] = [];
  for (const id of ruleIds) {
    const content = ruleContent(id);
    if (!content) return null;
    rules.push(material(id, content));
  }
  const active = profile
    ? activeSkillsForProfile(profile, host)
    : activeSkillsForProject(cwd, state, host);
  const declared = roleDeclaredSkills(role);
  // A missing/malformed role frontmatter is a policy compilation failure, not
  // permission to inherit every active project skill.
  const skillIds = resolvedRoleSkillIds(active, declared);
  if (!skillIds) return null;
  const skills: BootstrapMaterialRefV2[] = [];
  for (const id of skillIds) {
    const content = skillContent(id);
    if (!content) return null;
    skills.push(material(id, content));
  }
  return {
    role: material(role, roleBody),
    rules: rules.sort((a, b) => a.id.localeCompare(b.id)),
    skills,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function boundedScopeList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const rel = item.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
    if (!rel
      || rel.startsWith('/')
      || rel.split('/').includes('..')
      || rel.includes('\0')
      || /[*?[\]{}]/.test(rel)
      || rel === '.traffic-one'
      || rel.startsWith('.traffic-one/')) return null;
    normalized.push(rel);
  }
  return [...new Set(normalized)].sort();
}

const ARCHITECT_MEMORY_OUTPUTS = [
  '.traffic-one/plan.md',
  '.traffic-one/product.md',
  '.traffic-one/stack.md',
  '.traffic-one/coding.md',
  '.traffic-one/security.md',
  '.traffic-one/known-issues.md',
  '.traffic-one/deployment.md',
  '.traffic-one/environment-setup.md',
  '.traffic-one/agent-log.md',
  '.traffic-one/.agentignore',
  '.traffic-one/api.md',
  '.traffic-one/database.md',
  '.traffic-one/schema.sql',
] as const;

function architectPlanningScope(runId: string): { outputs: string[]; allowlist: string[] } {
  const decision = `.traffic-one/decisions/${safePart(runId)}-architecture.md`;
  const outputs = [
    ...ARCHITECT_MEMORY_OUTPUTS,
    decision,
    `.traffic-one/runs/${safePart(runId)}/architecture-input-v1.json`,
    `.traffic-one/digests/${safePart(runId)}/architect.md`,
  ];
  return {
    outputs,
    allowlist: outputs,
  };
}

function roleRunArtifacts(
  runId: string,
  role: string,
  verification: VerificationContractV2 | null,
): string[] {
  const suffix = role.replace(/^senior-/, '');
  const outputs = [`.traffic-one/digests/${safePart(runId)}/${safePart(suffix)}.md`];
  if (role === 'senior-tester' && verification) {
    outputs.push(`.traffic-one/reports/qa/${safePart(runId)}/report-v2.json`);
  }
  if (role === 'senior-shipper') outputs.push('.traffic-one/deployments.jsonl');
  // The committed schema snapshot must track the migrations the backend
  // authors; it lived in nobody's scope, so the 4cu backend digested BLOCKED
  // on it and forced a replan. Same artifact class as the digests above.
  if (role === 'senior-backend') outputs.push('.traffic-one/schema.sql');
  return outputs;
}

// NOTE: workUnit bytes and contractHash are byte-identical to schemaVersion-1
// envelopes for identical inputs — rules/skills were always hashed here as
// {id, contentHash} pairs. That stability is why maintenance.json fallback
// markers (fallbackContractMatches) survive the v1→v2 envelope migration.
function workUnitForRole(
  cwd: string,
  runId: string,
  role: string,
  hostAgentType: string | null,
  resolved: { rules: BootstrapMaterialRefV2[]; skills: BootstrapMaterialRefV2[] },
  snapshot: ArchitectureRunSnapshotV1,
  options: Pick<
    EnsureRunBootstrapOptions,
    'boundedOutputs' | 'boundedAllowlist' | 'boundedAllowlistExclude'
  >,
  runtimeContracts?: BootstrapRuntimeContractsV1,
): WorkUnitContractV1 | null {
  const boundedMaintenance = options.boundedOutputs !== undefined
    && ['quick-fix', 'senior-frontend', 'senior-backend'].includes(role);
  if (boundedMaintenance) {
    const sourceOutputs = boundedScopeList(options.boundedOutputs);
    const sourceAllowlist = boundedScopeList(options.boundedAllowlist || options.boundedOutputs);
    const allowlistExclude = options.boundedAllowlistExclude === undefined
      || options.boundedAllowlistExclude.length === 0
      ? []
      : boundedScopeList(options.boundedAllowlistExclude);
    if (!sourceOutputs || !sourceAllowlist || allowlistExclude === null) return null;
    const digest = role === 'quick-fix'
      ? quickFixDigestPath(runId)
      : maintenanceDigestPath(runId, role);
    const outputs = [...sourceOutputs, digest];
    const allowlist = [...sourceAllowlist, digest];
    try {
      return createWorkUnitContract({
        runId,
        unitId: role === 'quick-fix'
          ? `${role}:bootstrap`
          : `${role}:bounded-maintenance`,
        trafficOneRole: role,
        hostAgentType,
        rules: resolved.rules.map(({ id, contentHash }) => ({ id, contentHash })),
        skills: resolved.skills.map(({ id, contentHash }) => ({ id, contentHash })),
        outputs,
        allowlist,
        allowlistExclude,
        architectureHash: snapshot.snapshotHash,
        verificationHash: snapshot.baselineHash,
      });
    } catch {
      return null;
    }
  }
  if (role === 'senior-architect') {
    // The architect's planning contract is hashed to the immutable
    // capability+baseline snapshot ONLY — never to compiled artifacts. Its
    // scope does not depend on them, and deriving its hash from
    // architecture-v1.json made the contract flip the instant a compile
    // persisted mid-completion: the still-live architect's envelope stopped
    // matching and every subsequent tool call was denied (observed 2cl — the
    // digest deny itself revoked the tools needed to fix the digest).
    const planning = architectPlanningScope(runId);
    try {
      return createWorkUnitContract({
        runId,
        unitId: `${role}:bootstrap`,
        trafficOneRole: role,
        hostAgentType,
        rules: resolved.rules.map(({ id, contentHash }) => ({ id, contentHash })),
        skills: resolved.skills.map(({ id, contentHash }) => ({ id, contentHash })),
        outputs: planning.outputs,
        allowlist: planning.allowlist,
        allowlistExclude: [],
        architectureHash: snapshot.snapshotHash,
        verificationHash: snapshot.baselineHash,
      });
    } catch {
      return null;
    }
  }
  const architecture = runtimeContracts?.architecture || readCompiledArchitecture(cwd, runId);
  const verification = runtimeContracts?.verification || readVerificationContract(cwd, runId);
  const runtimeAssignments = runtimeContracts?.assignments
    || (architecture && verification ? readRuntimeAssignments(cwd, runId) : null);
  const assignment = runtimeAssignments?.assignments.find((entry) => entry.role === role);
  const artifacts = roleRunArtifacts(runId, role, verification);
  const allowlist = [...new Set([...stringList(assignment?.scope.include), ...artifacts])].sort();
  const allowlistExclude = stringList(assignment?.scope.exclude);
  const outputs = [...new Set([...stringList(assignment?.scope.include), ...artifacts])].sort();
  const requiresAssignment = ['senior-frontend', 'senior-backend', 'senior-tester'].includes(role);
  if (
    !architecture
    || !verification
    || !runtimeAssignments
    || runtimeAssignments.architectureHash !== architecture.contractHash
    || runtimeAssignments.verificationHash !== verification.contractHash
  ) return null;
  if (requiresAssignment && !assignment) return null;
  const architectureHash = architecture.contractHash;
  const verificationHash = verification.contractHash;
  try {
    return createWorkUnitContract({
      runId,
      unitId: `${role}:bootstrap`,
      trafficOneRole: role,
      hostAgentType,
      rules: resolved.rules.map(({ id, contentHash }) => ({ id, contentHash })),
      skills: resolved.skills.map(({ id, contentHash }) => ({ id, contentHash })),
      outputs,
      allowlist,
      allowlistExclude,
      architectureHash,
      verificationHash,
    });
  } catch {
    return null;
  }
}

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

function fallbackContractMatches(
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

function immutableEnvelopePath(cwd: string, runId: string, role: string, hash: string): string {
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

function pruneBootstrapHistory(cwd: string, runId: string): void {
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
  const canonical = {
    schemaVersion: RUN_BOOTSTRAP_SCHEMA_VERSION,
    runId,
    host: options.host,
    trafficOneRole: role,
    hostAgentType,
    roleSource,
    evidenceSource: options.evidenceSource || 'runtime-resolved',
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

