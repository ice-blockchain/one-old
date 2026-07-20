// Immutable per-run model policy. Machine-global One MCP state may change while
// a team is already running; every spawn, retry, and child verification must use
// the catalog frozen for that run instead of re-reading the mutable sidecar.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { AGENT_ROLES } from '../config/performance';
import {
  isSafeOneMcpModelId,
  ONE_MCP_MAX_AVAILABLE_MODELS,
  ONE_MCP_MAX_CONFIG_VERSION,
  ONE_MCP_MAX_MODELS_PER_TIER,
} from '../config/one-mcp';
import type { HostModelKey, TierId, UserPlan } from '../config/model-tiers';
import { RUNS_REL_DIR, VALID_AGENT_ROLES } from '../config/state';
import { isNonProjectRoot } from './authoring-root';
import { currentHostModelTarget } from './current-model-tiers';
import { detectHostPlan } from './host-plan';
import { freshCursorModels } from './materialize/cursor-models';
import { canonicalHost, canonicalPlan, modelMatchesExpected, type ModelTierSnapshot } from './model-tiers';
import { obj, type Rec } from './obj';
import { roleModelSelection } from './performance';

export const RUN_MODEL_POLICY_SCHEMA_VERSION = 1;
const POLICY_FILE = 'model-policy.json';
const POLICY_LOCK_TIMEOUT_MS = 1_000;
const POLICY_LOCK_STALE_MS = 10_000;

export interface RunRoleModelPolicy {
  readonly tier: TierId;
  readonly preferredModel: string;
  readonly acceptableModels: readonly string[];
}

export interface RunModelPolicyV1 {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly runId: string;
  readonly host: HostModelKey;
  readonly plan: UserPlan;
  readonly source: 'remote' | 'bundled';
  readonly configVersion: number | null;
  readonly payloadFingerprint: string;
  readonly appliedFingerprint: string;
  readonly performanceLevel: string;
  readonly teamOverrides: Readonly<Record<string, TierId>>;
  readonly tiers: ModelTierSnapshot;
  readonly roles: Readonly<Record<string, RunRoleModelPolicy>>;
  readonly cursorAvailableModels?: readonly string[];
  readonly capturedAt: string;
}

export interface RunPolicyFallbackRequest {
  readonly tier: TierId;
  readonly exhaustedModels?: readonly string[];
  readonly unavailableModels?: readonly string[];
  readonly capturedModels?: readonly string[];
}

export interface RunPolicyFallbackCandidate {
  readonly family: string;
  readonly model: string;
}

function sameModelFamily(left: string, right: string): boolean {
  return modelMatchesExpected(left, right) || modelMatchesExpected(right, left);
}

export function resolveRunPolicyFallback(
  policy: RunModelPolicyV1,
  request: RunPolicyFallbackRequest,
): RunPolicyFallbackCandidate | null {
  const row = policy.tiers[request.tier] || [];
  const excluded = [
    ...(request.exhaustedModels || []),
    ...(request.unavailableModels || []),
  ].filter((model) => typeof model === 'string' && model.trim().length > 0);
  for (const family of row) {
    if (excluded.some((model) => sameModelFamily(model, family))) continue;
    if (request.capturedModels !== undefined) {
      const model = request.capturedModels.find((candidate) => modelMatchesExpected(candidate, family));
      if (!model) continue;
      return { family, model };
    }
    return { family, model: family };
  }
  return null;
}

export function policyModelsForExpected(
  policy: RunModelPolicyV1,
  expected: string,
): readonly string[] {
  for (const row of Object.values(policy.tiers)) {
    const preferred = row[0];
    if (preferred && sameModelFamily(expected, preferred)) return row;
  }
  for (const row of Object.values(policy.tiers)) {
    if (row.some((candidate) => sameModelFamily(expected, candidate))) return row;
  }
  return expected ? [expected] : [];
}

function safeRunId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

export function runModelPolicyPath(cwd: string, runId: string): string {
  return path.join(cwd, RUNS_REL_DIR, safeRunId(runId), POLICY_FILE);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validModel(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function parseTierRows(value: unknown): ModelTierSnapshot | null {
  const raw = obj(value);
  if (!raw) return null;
  const out = {} as Record<TierId, readonly string[]>;
  for (const tier of ['highest', 'balanced', 'cheapest'] as const) {
    const row = raw[tier];
    if (!Array.isArray(row)
      || row.length === 0
      || row.length > ONE_MCP_MAX_MODELS_PER_TIER
      || !row.every(validModel)) return null;
    if (new Set(row).size !== row.length) return null;
    out[tier] = [...row];
  }
  return out;
}

function parsePolicy(value: unknown, expectedRunId?: string): RunModelPolicyV1 | null {
  const raw = obj(value);
  if (!raw
    || raw.schemaVersion !== RUN_MODEL_POLICY_SCHEMA_VERSION
    || typeof raw.policyId !== 'string'
    || !validFingerprint(raw.policyId)
    || typeof raw.runId !== 'string'
    || (expectedRunId && raw.runId !== expectedRunId)
    || typeof raw.host !== 'string'
    || typeof raw.plan !== 'string'
    || (raw.source !== 'remote' && raw.source !== 'bundled')
    || !(raw.configVersion === null || (typeof raw.configVersion === 'number'
      && Number.isInteger(raw.configVersion)
      && raw.configVersion >= 0
      && raw.configVersion <= ONE_MCP_MAX_CONFIG_VERSION))
    || !validFingerprint(raw.payloadFingerprint)
    || !validFingerprint(raw.appliedFingerprint)
    || typeof raw.performanceLevel !== 'string'
    || typeof raw.capturedAt !== 'string') return null;
  const host = canonicalHost(raw.host);
  if (host !== raw.host) return null;
  const plan = canonicalPlan(host, raw.plan);
  if (plan !== raw.plan) return null;
  const tiers = parseTierRows(raw.tiers);
  const rolesRaw = obj(raw.roles);
  const overridesRaw = obj(raw.teamOverrides);
  if (!tiers || !rolesRaw || !overridesRaw) return null;
  const roles: Record<string, RunRoleModelPolicy> = {};
  for (const [role, value] of Object.entries(rolesRaw)) {
    if (!VALID_AGENT_ROLES.has(role)) return null;
    const item = obj(value);
    const tier = item?.tier;
    const acceptable = item?.acceptableModels;
    if ((tier !== 'highest' && tier !== 'balanced' && tier !== 'cheapest')
      || !validModel(item?.preferredModel)
      || !Array.isArray(acceptable)
      || acceptable.length === 0
      || !acceptable.every(validModel)
      || new Set(acceptable).size !== acceptable.length
      || acceptable[0] !== item.preferredModel
      || acceptable.length !== tiers[tier].length
      || acceptable.some((model) => !tiers[tier].includes(model))
      || tiers[tier].some((model) => !acceptable.includes(model))) return null;
    roles[role] = { tier, preferredModel: item.preferredModel, acceptableModels: [...acceptable] };
  }
  for (const role of [...AGENT_ROLES, 'quick-fix']) {
    if (!roles[role]) return null;
  }
  const teamOverrides: Record<string, TierId> = {};
  for (const [role, tier] of Object.entries(overridesRaw)) {
    if (!VALID_AGENT_ROLES.has(role)) continue;
    if (tier === 'highest' || tier === 'balanced' || tier === 'cheapest') teamOverrides[role] = tier;
  }
  const cursorAvailableModels = raw.cursorAvailableModels;
  if (host === 'cursor') {
    if (!Array.isArray(cursorAvailableModels)
      || cursorAvailableModels.length === 0
      || cursorAvailableModels.length > ONE_MCP_MAX_AVAILABLE_MODELS
      || !cursorAvailableModels.every((model) => isSafeOneMcpModelId(model, 'cursor'))
      || new Set(cursorAvailableModels).size !== cursorAvailableModels.length
      || missingCursorPolicyTiers(roles, cursorAvailableModels).length > 0) return null;
  } else if (cursorAvailableModels !== undefined) {
    return null;
  }
  const canonical = {
    schemaVersion: 1 as const,
    runId: raw.runId,
    host,
    plan,
    source: raw.source as 'remote' | 'bundled',
    configVersion: raw.configVersion,
    payloadFingerprint: raw.payloadFingerprint,
    appliedFingerprint: raw.appliedFingerprint,
    performanceLevel: raw.performanceLevel,
    teamOverrides,
    tiers,
    roles,
    ...(host === 'cursor' ? { cursorAvailableModels: [...(cursorAvailableModels as string[])] } : {}),
  };
  if (sha256(JSON.stringify(canonical)) !== raw.policyId) return null;
  return { ...canonical, policyId: raw.policyId, capturedAt: raw.capturedAt };
}

export function readRunModelPolicy(cwd: string, runId: string): RunModelPolicyV1 | null {
  try {
    return parsePolicy(JSON.parse(fs.readFileSync(runModelPolicyPath(cwd, runId), 'utf8')), runId);
  } catch {
    return null;
  }
}

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* bounded retry */ }
}

function acquirePolicyLock(filePath: string): string | null {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + POLICY_LOCK_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      return lockPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as Rec;
        const at = typeof owner.at === 'number' ? owner.at : 0;
        if (at && Date.now() - at > POLICY_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* another process may still be publishing the owner */ }
      if (Date.now() >= deadline) return null;
      sleepSync(10);
    }
  }
}

function writePolicyAtomic(filePath: string, policy: RunModelPolicyV1): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }
}

function normalizedOverrides(value: unknown): Record<string, TierId> {
  const raw = obj(value);
  const out: Record<string, TierId> = {};
  if (!raw) return out;
  for (const [role, tier] of Object.entries(raw)) {
    if (!VALID_AGENT_ROLES.has(role)) continue;
    if (tier === 'highest' || tier === 'balanced' || tier === 'cheapest') out[role] = tier;
  }
  return out;
}

export function missingCursorPolicyTiers(
  roles: Readonly<Record<string, RunRoleModelPolicy>>,
  capturedModels: readonly string[],
): TierId[] {
  const missing = new Set<TierId>();
  for (const role of Object.values(roles)) {
    if (!capturedModels.some((model) => role.acceptableModels.some((family) => modelMatchesExpected(model, family)))) {
      missing.add(role.tier);
    }
  }
  return (['highest', 'balanced', 'cheapest'] as const).filter((tier) => missing.has(tier));
}

function resolvedRunPolicyInputs(
  cwd: string,
  hostInput: unknown,
  stateInput: unknown,
  env: NodeJS.ProcessEnv,
) {
  const state = obj(stateInput);
  const performance = obj(state?.performance);
  const team = obj(state?.team);
  const level = typeof performance?.level === 'string' ? performance.level : '';
  if (!state || team?.mode !== 'subagents' || (level !== 'balanced' && level !== 'high')) return null;
  const host = canonicalHost(hostInput);
  const plan = canonicalPlan(host, detectHostPlan(host, env));
  const target = currentHostModelTarget(host, plan, env);
  const acknowledged = performance ? obj(performance.target) : null;
  if (!acknowledged
    || acknowledged.plan !== plan
    || acknowledged.appliedFingerprint !== target.appliedFingerprint
    || !Number.isInteger(acknowledged.configVersion)
    || (acknowledged.configVersion as number) < 0
    || (acknowledged.configVersion as number) > ONE_MCP_MAX_CONFIG_VERSION) return null;
  const overrides = normalizedOverrides(team.overrides);
  const modelSelections = obj(team.modelSelections);
  const roles: Record<string, RunRoleModelPolicy> = {};
  for (const role of [...AGENT_ROLES, 'quick-fix'] as const) {
    if (role === 'quick-fix') {
      const acceptableModels = [...target.snapshot.tiers.cheapest];
      if (!acceptableModels.length) return null;
      roles[role] = { tier: 'cheapest', preferredModel: acceptableModels[0]!, acceptableModels };
      continue;
    }
    const selection = roleModelSelection(
      level,
      role,
      host,
      overrides,
      modelSelections,
      { host, plan },
      env,
    );
    if (!selection) return null;
    roles[role] = {
      tier: selection.tier,
      preferredModel: selection.preferredModel,
      acceptableModels: [...selection.acceptableModels],
    };
  }
  const cursorAvailableModels = host === 'cursor'
    ? freshCursorModels(cwd, plan, undefined, undefined, env)
    : [];
  return { host, plan, target, level, overrides, roles, cursorAvailableModels };
}

export function cursorRunPolicyMissingTiers(
  cwd: string,
  hostInput: unknown,
  stateInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): TierId[] | null {
  const inputs = resolvedRunPolicyInputs(cwd, hostInput, stateInput, env);
  if (!inputs || inputs.host !== 'cursor') return null;
  return missingCursorPolicyTiers(inputs.roles, inputs.cursorAvailableModels);
}

export function buildRunModelPolicy(
  cwd: string,
  runId: string,
  hostInput: unknown,
  stateInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): RunModelPolicyV1 | null {
  const inputs = resolvedRunPolicyInputs(cwd, hostInput, stateInput, env);
  if (!inputs) return null;
  const { host, plan, target, level, overrides, roles, cursorAvailableModels } = inputs;
  // Cursor's concrete Task slugs are runner-owned capability state. A policy
  // must cover every role row before create-once publication. A non-empty but
  // partial capture would otherwise strand unmatched roles for the entire run,
  // because a later picker refresh intentionally cannot rebase this snapshot.
  if (host === 'cursor' && missingCursorPolicyTiers(roles, cursorAvailableModels).length > 0) return null;
  const payloadFingerprint = typeof (target as unknown as Rec).payloadFingerprint === 'string'
    ? String((target as unknown as Rec).payloadFingerprint)
    : target.appliedFingerprint;
  const canonical = {
    schemaVersion: 1 as const,
    runId,
    host,
    plan,
    source: target.source === 'one-mcp' ? 'remote' as const : 'bundled' as const,
    configVersion: target.source === 'one-mcp' ? target.configVersion : null,
    payloadFingerprint,
    appliedFingerprint: target.appliedFingerprint,
    performanceLevel: level,
    teamOverrides: overrides,
    tiers: {
      highest: [...target.snapshot.tiers.highest],
      balanced: [...target.snapshot.tiers.balanced],
      cheapest: [...target.snapshot.tiers.cheapest],
    },
    roles,
    ...(cursorAvailableModels.length ? { cursorAvailableModels } : {}),
  };
  const policyId = sha256(JSON.stringify(canonical));
  return { ...canonical, policyId, capturedAt: new Date().toISOString() };
}

// Parent-only create/repair. A valid existing snapshot always wins: it is the
// immutable policy for the active run even if machine-global config changed.
export function ensureRunModelPolicy(
  cwd: string,
  runId: string,
  host: unknown,
  state: unknown,
  env: NodeJS.ProcessEnv = process.env,
): RunModelPolicyV1 | null {
  if (!runId || isNonProjectRoot(cwd)) return null;
  const filePath = runModelPolicyPath(cwd, runId);
  const existing = readRunModelPolicy(cwd, runId);
  if (existing) return existing;
  // Create-once is stronger than "valid existing wins": once the path has
  // been published, a malformed/tampered snapshot must never be silently
  // replaced from mutable machine-global state. Children and parents both fail
  // closed; recovery is an explicit run repair/new run operation.
  if (fs.existsSync(filePath)) return null;
  const candidate = buildRunModelPolicy(cwd, runId, host, state, env);
  if (!candidate) return null;
  const lockPath = acquirePolicyLock(filePath);
  if (!lockPath) return readRunModelPolicy(cwd, runId);
  try {
    const underLock = readRunModelPolicy(cwd, runId);
    if (underLock) return underLock;
    if (fs.existsSync(filePath)) return null;
    writePolicyAtomic(filePath, candidate);
    return readRunModelPolicy(cwd, runId);
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function runRoleModelPolicy(
  cwd: string,
  runId: string,
  role: string,
): RunRoleModelPolicy | null {
  return readRunModelPolicy(cwd, runId)?.roles[role] || null;
}
