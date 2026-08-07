// src/shared/run-model-policy.ts
// Locked model-policy writes: freeze, ensure, and bootstrap publication.

import * as fs from 'fs';
import * as path from 'path';
import { AGENT_ROLES } from '../config/performance';
import {
  ONE_MCP_MAX_CONFIG_VERSION,
} from '../config/one-mcp';
import type {  TierId } from '../config/model-tiers';
import {  VALID_AGENT_ROLES } from '../config/state';
import { isNonProjectRoot } from './authoring-root';
import { trustworthyAgeSince } from './clock-skew';
import {
  capabilityProfileForRun,
  readCompiledArchitecture,
  readRuntimeAssignments,
} from './architecture-contract';
import {
  ensureRunHostCapability,
  readRunHostCapability,
  RUN_HOST_CAPABILITY_RELATIVE_FILE,
} from './host/capabilities';
import { currentHostModelTarget } from './current-model-tiers';
import { detectHostPlan } from './host/plan';
import { freshCursorModels } from './materialize/cursor-models';
import { canonicalHost, canonicalPlan } from './model-tiers';
import { obj, type Rec } from './obj';
import { roleModelSelection } from './performance';
import {
  canResolveRunBootstrapSet,
  ensureRunBootstrap,
  pendingMaintenanceDebtSources,
  roleOwesPendingMaintenanceFallback,
  roleSkippableWithoutAssignment,
  type BootstrapRuntimeContractsV1,
} from './run-bootstrap-policy';
import { readVerificationContract } from './verification-contract';

import {
  POLICY_LOCK_STALE_MS,
  POLICY_LOCK_TIMEOUT_MS,
  readRunModelPolicy,
  runModelPolicyPath,
  sha256,
  type RunModelPolicyV1,
  type RunRoleModelPolicy,
  missingCursorPolicyTiers,
} from './run-model-policy-schema';

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* bounded retry */ }
}

// Canonical definition: state/run-agent/locks.ts. Deliberately copied rather
// than shared — folding this repo's liveness predicates into one helper is the
// host-capability-consolidation wave, and doing it from here would touch far
// more files than the defect being fixed. What every copy MUST keep is the EPERM
// direction: `kill(pid, 0)` raising EPERM means the process EXISTS and belongs
// to another uid, so it is not dead and its lease may not be taken. Only ESRCH
// is proof of death. Pinned across every copy by
// shared/__tests__/process-liveness-eperm.test.ts.
function processDefinitelyDead(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

interface PolicyLock {
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

/**
 * Reclaim a policy lock ONLY from an owner that is provably gone.
 *
 * This used to reclaim on `owner.at` alone — with the owner's pid sitting
 * unread in the very record it was parsing — and then `rmSync(recursive,
 * force)` the whole directory, so a publication slower than
 * POLICY_LOCK_STALE_MS had its lease deleted out from under it.
 *
 * Both removals below are their own compare-and-swap, which is what keeps two
 * reapers from handing two writers the same lease:
 *   - unlinking THIS EXACT owner record: only the reaper whose unlink succeeds
 *     goes on to rmdir, so a rival that decided the same lock was stale cannot
 *     delete the replacement lease the winner has already published;
 *   - `rmdirSync`, never `rmSync(recursive)`: a non-recursive rmdir fails with
 *     ENOTEMPTY the instant a new owner has published its record, so the aged
 *     empty-directory path cannot take a live lease either.
 */
function reclaimStalePolicyLock(lockPath: string, ownerPath: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(lockPath); } catch { return false; }
  if (entries.length === 0) {
    // A holder publishes owner.json immediately after mkdir, so an empty
    // directory is either an acquisition in flight or the residue of one that
    // died between the two. Age decides, and rmdir is the CAS.
    try {
      // A negative age (mtime ahead of now) is `<= STALE` forever, so this
      // residue would wedge the policy path permanently. An unusable age does
      // not veto the reclaim; the emptiness check above and rmdir are the CAS.
      const dirAgeMs = trustworthyAgeSince(fs.statSync(lockPath).mtimeMs, Date.now());
      if (dirAgeMs !== null && dirAgeMs <= POLICY_LOCK_STALE_MS) return false;
      fs.rmdirSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  if (entries.length !== 1 || entries[0] !== path.basename(ownerPath)) return false;
  let owner: Rec;
  try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Rec; } catch { return false; }
  const at = typeof owner.at === 'number' ? owner.at : 0;
  // A record with no stamp at all is a different question from a stamp no clock
  // could have produced, and this file's answer to it stays fail-closed. What
  // that costs, measured: the acquirer burns the full POLICY_LOCK_TIMEOUT_MS
  // (1015-1041ms) and publishes nothing, so this run's policy is never frozen
  // and SessionStart blocks every parent tool call behind
  // TRAFFIC_ONE_MODEL_POLICY_BLOCKED. Bounded by the RUN ID: this lock is
  // `runs/<runId>/model-policy.json.lock`, and the next parent run publishes in
  // ~60ms — which is why the same input folds the OTHER way in
  // onboarding-server/ensure.ts, whose lock is per project+host in the HOME
  // state root with no rotation and no reaper.
  //
  // Reclaiming instead would fix nothing reachable and break something that is:
  // no writer here can leave a parseable record without a stamp (a killed writer
  // leaves a byte prefix of one writeFileSync, which never parses), while an
  // UNPARSEABLE record — refused by the catch above for the same reason — is
  // exactly what a LIVE acquisition looks like inside its mkdir→owner-file gap,
  // so treating "no usable stamp" as evidence of death would hand out two
  // leases. Pinned by shared/__tests__/lock-absent-stamp.test.ts.
  if (!at) return false;
  // The mirror of a freshness window: `Date.now() - at` goes negative for a
  // future stamp, which is never `> STALE`, so a policy lock whose owner is
  // provably dead could never be reclaimed and every publisher timed out behind
  // it. An unusable age does not veto the reclaim; `processDefinitelyDead` is
  // still the thing that decides, so a live publisher keeps its lease.
  const ownerAgeMs = trustworthyAgeSince(at, Date.now());
  if ((ownerAgeMs !== null && ownerAgeMs <= POLICY_LOCK_STALE_MS) || !processDefinitelyDead(owner.pid)) return false;
  try {
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquirePolicyLock(filePath: string): PolicyLock | null {
  const lockPath = `${filePath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + POLICY_LOCK_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  while (true) {
    let madeDir = false;
    try {
      // Non-recursive on purpose: this mkdir is the compare-and-swap that IS
      // the lock, and EEXIST is how contention is reported.
      fs.mkdirSync(lockPath, { mode: 0o700 });
      madeDir = true;
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { mode: 0o600, flag: 'wx' });
      return { lockPath, ownerPath, token };
    } catch (error) {
      if (madeDir) {
        // We own the directory but could not publish ownership. Leaving it would
        // wedge the path for a full stale window with nobody inside it.
        try { fs.unlinkSync(ownerPath); } catch { /* best-effort */ }
        try { fs.rmdirSync(lockPath); } catch { /* best-effort */ }
        return null;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (reclaimStalePolicyLock(lockPath, ownerPath)) continue;
      if (Date.now() >= deadline) return null;
      sleepSync(10);
    }
  }
}

// Never remove a lease this process cannot prove it still holds: the token in
// the owner record is the proof. A blind recursive rm here would delete the
// directory of whoever acquired it next.
function releasePolicyLock(lock: PolicyLock): void {
  try {
    const owner = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8')) as Rec;
    if (owner.token !== lock.token) return;
    fs.unlinkSync(lock.ownerPath);
  } catch {
    return;
  }
  try { fs.rmdirSync(lock.lockPath); } catch { /* a foreign entry stays fail-closed */ }
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
  const capability = readRunHostCapability(cwd, runId, host)
    || ensureRunHostCapability(cwd, runId, host);
  if (!capability) return null;
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
    hostCapabilityFile: RUN_HOST_CAPABILITY_RELATIVE_FILE as typeof RUN_HOST_CAPABILITY_RELATIVE_FILE,
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
  if (existing) return ensureRunPolicyBootstraps(cwd, existing, state) ? existing : null;
  // Create-once is stronger than "valid existing wins": once the path has
  // been published, a malformed/tampered snapshot must never be silently
  // replaced from mutable machine-global state. Children and parents both fail
  // closed; recovery is an explicit run repair/new run operation.
  if (fs.existsSync(filePath)) return null;
  const candidate = buildRunModelPolicy(cwd, runId, host, state, env);
  if (!candidate) return null;
  const lock = acquirePolicyLock(filePath);
  if (!lock) {
    const raced = readRunModelPolicy(cwd, runId);
    return raced && ensureRunPolicyBootstraps(cwd, raced, state) ? raced : null;
  }
  try {
    const underLock = readRunModelPolicy(cwd, runId);
    if (underLock) return ensureRunPolicyBootstraps(cwd, underLock, state) ? underLock : null;
    if (fs.existsSync(filePath)) return null;
    writePolicyAtomic(filePath, candidate);
    const published = readRunModelPolicy(cwd, runId);
    return published && ensureRunPolicyBootstraps(cwd, published, state) ? published : null;
  } finally {
    releasePolicyLock(lock);
  }
}

export function ensureRunPolicyBootstraps(
  cwd: string,
  policy: RunModelPolicyV1,
  state: unknown,
): boolean {
  const capability = capabilityProfileForRun(cwd, state);
  const architecture = readCompiledArchitecture(cwd, policy.runId);
  const verification = readVerificationContract(cwd, policy.runId);
  const assignments = readRuntimeAssignments(cwd, policy.runId);
  const compiledReady = Boolean(
    architecture
    && verification
    && assignments
    && assignments.architectureHash === architecture.contractHash
    && assignments.verificationHash === verification.contractHash,
  );
  // Precompile is a planning phase: only the architect has a strict work unit
  // hashed to the immutable capability+baseline snapshot. Empty implementer,
  // tester, reviewer, shipper, or quick-fix envelopes are never published.
  // A skippable scope-requiring role the compiled assignments give nothing to
  // is not part of this run either — publishing must not demand an envelope
  // for it (see roleSkippableWithoutAssignment: the frontend-only
  // existing-codebase maintenance plan that senior-backend deadlocked at
  // PLAN_READY; senior-tester deliberately stays load-bearing).
  const roles = (compiledReady ? capability.roles : ['senior-architect'])
    .filter((role) => Boolean(policy.roles[role]))
    .filter((role) => !compiledReady
      || !roleSkippableWithoutAssignment(role)
      || assignments!.assignments.some((entry) => entry.role === role));
  const host = readRunHostCapability(cwd, policy.runId, policy.host)
    || ensureRunHostCapability(cwd, policy.runId, policy.host);
  if (!host) return false;
  const typed = host.typedSubagents === true;
  return roles.every((role) => {
    const options = {
      host: policy.host,
      hostAgentType: typed ? role : null,
      evidenceSource: 'parent-policy-preflight',
      modelPolicyId: policy.policyId,
    };
    // A role that owes a PENDING maintenance fallback cannot hold its planned
    // full-scope envelope: until the debt is discharged `fallbackContractMatches`
    // admits only the debts' own bounded scope, and a full-scope preflight
    // publish is precisely the widening that guard exists to refuse. Failing the
    // whole preflight on that refusal wedged the entire session — the policy
    // read null, SessionStart emitted TRAFFIC_ONE_MODEL_POLICY_BLOCKED and the
    // onboarding gate denied every parent tool call, while the only thing that
    // can discharge the debt is a paid fallback child the blocked parent can no
    // longer start (observed 16co, senior-frontend, permanent).
    if (roleOwesPendingMaintenanceFallback(cwd, policy.runId, role)) {
      const debtSources = pendingMaintenanceDebtSources(cwd, policy.runId, role);
      // Publish the SAME bounded union the spawn gate derives, so the role stays
      // live for the work it actually owes and the paid-fallback finalizer finds
      // a valid active envelope. When no scope can be derived — an unreadable
      // debt baseline, or a role that cannot carry a bounded unit — publish
      // NOTHING and leave the spawn gate as the enforcement point. Skipping
      // grants no authority: publication is what grants it, `ensureRunBootstrap`
      // still denies the spawn, and every reader re-runs the same guard through
      // `readActiveRunBootstrap`, so a stale envelope stays void either way.
      if (debtSources) {
        ensureRunBootstrap(cwd, policy.runId, role, state, {
          ...options,
          boundedOutputs: debtSources,
          boundedAllowlist: debtSources,
          boundedAllowlistExclude: [],
        });
      }
      return true;
    }
    return Boolean(ensureRunBootstrap(cwd, policy.runId, role, state, options));
  });
}

// "Will the parent gates refuse to work in this run?" — the read-only form of
// the exact question SessionStart and the onboarding gate already answer, so a
// THIRD surface (prompt-boundary maintenance routing) can defer to them instead
// of re-deriving the chain. Two hooks contradicting each other inside one turn
// is what burned 16co: 07:12:09Z SessionStart "Do not spawn a child", 07:12:10Z
// the triage reminder "OpenCode runId for opencode_delegate: 1785619235671".
// The agent followed the newer instruction and spent the session against a gate
// that denies every parent tool call.
//
// The precondition is CREATE-ONCE, not "something failed": a run whose policy
// path is already published can never be rebased, so no later prompt in that run
// repairs it — all three arms below are permanent for this run id. A run with no
// policy file yet is merely unfrozen: Performance still repairs it and the next
// freeze can succeed, so routing stays best-effort there (the F3 rotation
// contract) and this returns false.
export function runBootstrapBlocked(
  cwd: string,
  runId: string,
  hostInput: unknown,
  state: unknown,
): boolean {
  if (!runId || isNonProjectRoot(cwd)) return false;
  if (!fs.existsSync(runModelPolicyPath(cwd, runId))) return false;
  // Published but unreadable/tampered: create-once forbids replacing it.
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy) return true;
  // Frozen for another host: only a NEW parent run can serve this one.
  if (policy.host !== canonicalHost(hostInput)) return true;
  try {
    return !ensureRunPolicyBootstraps(cwd, policy, state);
  } catch {
    // Fail OPEN, matching every freeze call site: a throwing preflight must
    // never be the thing that silences routing. The gates remain the
    // enforcement point.
    return false;
  }
}

export function canPublishRunPolicyBootstraps(
  cwd: string,
  policy: RunModelPolicyV1,
  state: unknown,
  contracts: BootstrapRuntimeContractsV1,
): boolean {
  const capability = capabilityProfileForRun(cwd, state);
  const roles = capability.roles.filter((role) => Boolean(policy.roles[role]));
  const host = readRunHostCapability(cwd, policy.runId, policy.host);
  if (!host) return false;
  return canResolveRunBootstrapSet(
    cwd,
    policy.runId,
    roles,
    policy.host,
    host.typedSubagents === true,
    contracts,
  );
}

export {
  RUN_MODEL_POLICY_SCHEMA_VERSION,
  policyModelsForExpected,
  readRunModelPolicy,
  resolveRunPolicyFallback,
  runModelPolicyPath,
  type RunModelPolicyV1,
  type RunPolicyFallbackCandidate,
  type RunPolicyFallbackRequest,
  type RunRoleModelPolicy,
} from './run-model-policy-schema';
