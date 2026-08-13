// Cross-event Codex model evidence. SubagentStart is non-blocking and may arrive
// before role metadata is visible; the child's first PreToolUse is blocking and
// completes verification against the immutable per-run model policy.

import * as fs from 'fs';
import * as path from 'path';

import { RUNS_REL_DIR, VALID_AGENT_ROLES } from '../../config/state';
import { readOwnerEntry } from '../bounded-read';
import { trustworthyAgeSince } from '../clock-skew';
import { obj, type Rec } from '../obj';
import { readRunModelPolicy } from '../run-model-policy';
import { readRegularFileOrThrow } from '../bounded-read';

const STORE_VERSION = 1;
const STORE_FILE = 'codex-model-observations.json';
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 10_000;

type CodexModelObservationStatus = 'pending-role' | 'verified' | 'mismatch' | 'conflict';

// A verified row whose reason carries this prefix accepted ONE host continuation
// on a different model than its anchor (see evaluate()). Readers that compare the
// hook's model against the anchor must consult this, or a tolerated continuation
// looks like an identity mismatch and wedges the child.
const CONTINUATION_REASON_PREFIX = 'continuation-on-';

export function continuationModelOf(observation: CodexModelObservation | null | undefined): string | null {
  const reason = observation?.reason;
  if (observation?.status !== 'verified' || typeof reason !== 'string') return null;
  return reason.startsWith(CONTINUATION_REASON_PREFIX)
    ? reason.slice(CONTINUATION_REASON_PREFIX.length) || null
    : null;
}

export interface CodexModelObservation {
  childId: string;
  parentSessionId: string | null;
  policyId: string;
  role: string | null;
  actualModel: string | null;
  modelSources: readonly string[];
  status: CodexModelObservationStatus;
  reason: string | null;
  observedAt: string;
  updatedAt: string;
}

function safe(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

function storePath(cwd: string, runId: string): string {
  return path.join(cwd, RUNS_REL_DIR, safe(runId), STORE_FILE);
}

function validModel(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function parseObservation(value: unknown): CodexModelObservation | null {
  const raw = obj(value);
  if (!raw
    || typeof raw.childId !== 'string'
    || typeof raw.policyId !== 'string'
    || !['pending-role', 'verified', 'mismatch', 'conflict'].includes(String(raw.status))
    || !(raw.role === null || (typeof raw.role === 'string' && VALID_AGENT_ROLES.has(raw.role)))
    || !(raw.actualModel === null || validModel(raw.actualModel))
    || !Array.isArray(raw.modelSources)
    || !raw.modelSources.every((source) => typeof source === 'string')
    || typeof raw.observedAt !== 'string'
    || typeof raw.updatedAt !== 'string') return null;
  return {
    childId: raw.childId,
    parentSessionId: typeof raw.parentSessionId === 'string' ? raw.parentSessionId : null,
    policyId: raw.policyId,
    role: raw.role as string | null,
    actualModel: raw.actualModel as string | null,
    modelSources: [...raw.modelSources],
    status: raw.status as CodexModelObservationStatus,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    observedAt: raw.observedAt,
    updatedAt: raw.updatedAt,
  };
}

function readStore(cwd: string, runId: string): Record<string, CodexModelObservation> {
  try {
    const raw = obj(JSON.parse(readRegularFileOrThrow(storePath(cwd, runId))));
    if (!raw || raw.version !== STORE_VERSION) return {};
    const values = obj(raw.observations);
    if (!values) return {};
    const out: Record<string, CodexModelObservation> = {};
    for (const [id, value] of Object.entries(values)) {
      const parsed = parseObservation(value);
      if (parsed && parsed.childId === id) out[id] = parsed;
    }
    return out;
  } catch {
    return {};
  }
}

function sleepSync(ms: number): void {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* bounded retry */ }
}

// Canonical definition: state/run-agent/locks.ts. Copied rather than shared for
// the reason given at the identical copy in shared/run-model-policy.ts: EPERM
// from `kill(pid, 0)` means the process EXISTS under another uid and is
// therefore NOT dead, so only ESRCH may authorize a reclaim. The direction is
// pinned across every copy by shared/__tests__/process-liveness-eperm.test.ts.
function processDefinitelyDead(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// Same reclaim contract as the policy lock next door, and it replaces the same
// defect: this loop parsed owner.json for its timestamp, ignored the pid sitting
// right beside it, and answered "stale" for any observation slower than
// LOCK_STALE_MS — then removed the lease with a recursive, forced rm. The
// unlink of this exact owner record, and the non-recursive rmdir, are each a
// compare-and-swap, so no reaper can delete a lease a rival has already
// replaced.
function reclaimStaleStoreLock(lockPath: string, ownerPath: string): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(lockPath); } catch { return false; }
  if (entries.length === 0) {
    try {
      // A future-stamped mtime makes this age negative and therefore eternally
      // fresh. An unusable age does not veto the reclaim; emptiness and the
      // non-recursive rmdir are the CAS that keeps it safe.
      const dirAgeMs = trustworthyAgeSince(fs.statSync(lockPath).mtimeMs, Date.now());
      if (dirAgeMs !== null && dirAgeMs <= LOCK_STALE_MS) return false;
      fs.rmdirSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
  if (entries.length !== 1 || entries[0] !== path.basename(ownerPath)) return false;
  let owner: Rec;
  // BOUNDED (shared/bounded-read.ts), the same substitution the identical fold in
  // shared/run-model-policy.ts takes. A non-regular file at the owner name lands
  // where unparseable bytes land — the reclaim is refused, because presence with
  // no liveness evidence is not evidence of death. Unbounded before: this read is
  // inside the observer's retry loop, so the LOCK_TIMEOUT_MS the comment below
  // prices was unreachable rather than generous.
  try {
    const bytes = readOwnerEntry(ownerPath);
    if (bytes === null) return false;
    owner = JSON.parse(bytes) as Rec;
  } catch { return false; }
  const at = typeof owner.at === 'number' ? owner.at : 0;
  // An absent stamp is the neighbouring question and keeps its fail-closed
  // answer, for the reason spelled out at the identical fold in
  // shared/run-model-policy.ts: no writer here can leave a record that PARSES
  // without a stamp, while an unparseable one is what a live acquisition looks
  // like inside its mkdir→owner-file gap, so reclaiming on a missing stamp would
  // fix nothing reachable and could hand out two leases. Measured cost if a
  // foreign writer does leave one: the observer burns the full LOCK_TIMEOUT_MS
  // (1008ms) and returns null, which codex-child-model.ts renders as
  // `codex-child-model-observation-persist-failed` on EVERY tool call of EVERY
  // Codex child in this run — its prescribed replacement child included, since
  // the lock is per run. Bounded by the RUN ID: the next run observes in ~ms.
  // Pinned by shared/__tests__/lock-absent-stamp.test.ts.
  if (!at) return false;
  // Negative age = maximally fresh, so a future-stamped owner record made this
  // store lock unreclaimable even with a provably dead owner, and every observer
  // returned null at the timeout. An unusable age does not veto the reclaim;
  // `processDefinitelyDead` still governs, so a live observer keeps its lease.
  const ownerAgeMs = trustworthyAgeSince(at, Date.now());
  if ((ownerAgeMs !== null && ownerAgeMs <= LOCK_STALE_MS) || !processDefinitelyDead(owner.pid)) return false;
  try {
    fs.unlinkSync(ownerPath);
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function withStoreLock<T>(cwd: string, runId: string, body: () => T): T | null {
  const filePath = storePath(cwd, runId);
  const lockPath = `${filePath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    let madeDir = false;
    try {
      // Non-recursive: this mkdir is the compare-and-swap that IS the lock.
      fs.mkdirSync(lockPath, { mode: 0o700 });
      madeDir = true;
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { mode: 0o600, flag: 'wx' });
      break;
    } catch (error) {
      if (madeDir) {
        try { fs.unlinkSync(ownerPath); } catch { /* best-effort */ }
        try { fs.rmdirSync(lockPath); } catch { /* best-effort */ }
        return null;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (reclaimStaleStoreLock(lockPath, ownerPath)) continue;
      if (Date.now() >= deadline) return null;
      sleepSync(10);
    }
  }
  try {
    return body();
  } finally {
    // The token proves the lease is still ours. Without that check the release
    // deletes whichever directory is at the path, including a successor's.
    try {
      // BOUNDED: this release runs in a `finally`, so a shape that never answers
      // at our own owner path hangs the caller AFTER the body already succeeded —
      // the work done, the lease still held, and nothing reportable. A null reads
      // as "we cannot prove this is ours", which is the branch this block already
      // has for a foreign token.
      const bytes = readOwnerEntry(ownerPath);
      const owner = (bytes === null ? {} : JSON.parse(bytes)) as Rec;
      if (owner.token === token) {
        fs.unlinkSync(ownerPath);
        try { fs.rmdirSync(lockPath); } catch { /* a foreign entry stays fail-closed */ }
      }
    } catch { /* already reclaimed or replaced: never remove what we cannot claim */ }
  }
}

function writeStore(cwd: string, runId: string, observations: Record<string, CodexModelObservation>): void {
  const filePath = storePath(cwd, runId);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ version: STORE_VERSION, observations }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
  }
}

function evaluate(
  cwd: string,
  runId: string,
  childId: string,
  parentSessionId: string | null,
  actualModel: string | null,
  role: string | null,
  source: string,
  allowRoleCorrection: boolean,
): CodexModelObservation | null {
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy || policy.host !== 'codex') return null;
  return withStoreLock(cwd, runId, () => {
    const observations = readStore(cwd, runId);
    const previous = observations[childId];
    const now = new Date().toISOString();
    if (previous?.status === 'conflict') return previous;
    if (previous && previous.policyId !== policy.policyId) {
      const conflict = { ...previous, status: 'conflict' as const, reason: 'policy-mismatch', updatedAt: now };
      observations[childId] = conflict;
      writeStore(cwd, runId, observations);
      return conflict;
    }
    // Parent identity has two grades of evidence: SubagentStart fires in the
    // spawner's context before the child rollout is readable (its parent notion
    // may be missing or the ROOT session), while PreToolUse reads the child's
    // line-zero `parent_thread_id` (the immediate parent). A disagreement across
    // grades is an upgrade, not a contradiction — flagging it stranded every
    // depth-2 replacement with `parent-session-conflict` (observed 9c-codex).
    // Same-grade disagreement (line-zero itself changed) remains terminal.
    let resolvedParent = previous?.parentSessionId || parentSessionId;
    if (previous?.parentSessionId && parentSessionId && previous.parentSessionId !== parentSessionId) {
      const previousAuthoritative = (previous.modelSources || []).includes('PreToolUse');
      const incomingAuthoritative = source === 'PreToolUse';
      if (incomingAuthoritative && !previousAuthoritative) {
        resolvedParent = parentSessionId;
      } else if (!incomingAuthoritative && previousAuthoritative) {
        resolvedParent = previous.parentSessionId;
      } else {
        const conflict = { ...previous, status: 'conflict' as const, reason: 'parent-session-conflict', updatedAt: now };
        observations[childId] = conflict;
        writeStore(cwd, runId, observations);
        return conflict;
      }
    }
    // Observed-model drift is terminal UNLESS this is a trusted CONTINUATION of a
    // thread the CHILD ITSELF already verified.
    //
    // Why the source matters: SubagentStart fires in the SPAWNER's context and
    // reports the model the parent REQUESTED, before the child runs. Accepting a
    // drift off that anchor would make the child's own first blocking turn
    // vacuous — a child actually running on a model its role forbids would pass,
    // and the immutable policy would keep the requested value as its record. So a
    // drift is only a continuation once `modelSources` includes 'PreToolUse': the
    // child's own blocking turn has been checked against the frozen policy.
    //
    // After that, a different observed model means the HOST continued/reattached
    // that same runtime (Codex runs a follow-up turn on the PARENT's model).
    // Treating that as a breach retired every continuation, so the orchestrator
    // could only ever spawn FRESH agents per fix cycle — each reloading the full
    // rules+skills+plan context and re-exploring the codebase, defeating the
    // "ONE live agent per role" reuse the design exists for (observed
    // 12c/15c/17c/18c: senior_<role>_fix_1, _fix_2, … proliferation). The
    // child-verified model stays the anchor (nextModel prefers
    // previous.actualModel below), so the policy record is never rewritten.
    // Accepted trade-off: a continuation turn may run on the parent's tier — a
    // cost/tier leak, strictly cheaper than a full context reload per fix cycle.
    let continuationDrift: string | null = null;
    if (previous?.actualModel && actualModel && previous.actualModel !== actualModel) {
      const childVerifiedItself = previous.status === 'verified'
        && (previous.modelSources || []).includes('PreToolUse');
      if (childVerifiedItself) {
        continuationDrift = actualModel;
      } else {
        const conflict = { ...previous, status: 'conflict' as const, reason: 'hook-model-conflict', updatedAt: now };
        observations[childId] = conflict;
        writeStore(cwd, runId, observations);
        return conflict;
      }
    }
    if (previous?.role && role && previous.role !== role && !allowRoleCorrection) {
      const conflict = { ...previous, status: 'conflict' as const, reason: 'role-conflict', updatedAt: now };
      observations[childId] = conflict;
      writeStore(cwd, runId, observations);
      return conflict;
    }
    const nextModel = previous?.actualModel || actualModel;
    const nextRole = allowRoleCorrection && role ? role : (previous?.role || role);
    let status: CodexModelObservationStatus = 'pending-role';
    let reason: string | null = null;
    if (nextRole && nextModel) {
      const rolePolicy = policy.roles[nextRole];
      if (!rolePolicy) {
        status = 'mismatch';
        reason = 'role-not-in-policy';
      } else if (!rolePolicy.acceptableModels.includes(nextModel)) {
        status = 'mismatch';
        reason = 'model-not-allowed-for-role';
      } else {
        status = 'verified';
      }
    } else if (!nextModel) {
      reason = 'model-not-observed';
    } else {
      reason = 'role-not-observed';
    }
    // Keep the accepted continuation auditable: the row stays verified against
    // its anchor model while naming the model the host actually continued on.
    if (continuationDrift && status === 'verified') {
      reason = `${CONTINUATION_REASON_PREFIX}${continuationDrift}`;
    }
    // A terminal mismatch cannot be healed by an ordinary delayed event. Only an
    // authoritative role correction may re-evaluate the same immutable model.
    if (previous?.status === 'mismatch' && !allowRoleCorrection) return previous;
    const next: CodexModelObservation = {
      childId,
      parentSessionId: resolvedParent,
      policyId: policy.policyId,
      role: nextRole,
      actualModel: nextModel,
      modelSources: [...new Set([...(previous?.modelSources || []), source].filter(Boolean))],
      status,
      reason,
      observedAt: previous?.observedAt || now,
      updatedAt: now,
    };
    observations[childId] = next;
    writeStore(cwd, runId, observations);
    return next;
  });
}

export function observeCodexChildModel(
  cwd: string,
  runId: string,
  input: {
    childId: string;
    parentSessionId?: string | null;
    actualModel?: string | null;
    role?: string | null;
    source: 'SubagentStart' | 'PreToolUse';
  },
): CodexModelObservation | null {
  const childId = input.childId.trim();
  if (!childId) return null;
  const actualModel = validModel(input.actualModel) ? input.actualModel : null;
  const role = typeof input.role === 'string' && VALID_AGENT_ROLES.has(input.role) ? input.role : null;
  return evaluate(cwd, runId, childId, input.parentSessionId || null, actualModel, role, input.source, false);
}

export function correctCodexChildObservationRole(
  cwd: string,
  runId: string,
  childId: string,
  role: string,
): CodexModelObservation | null {
  if (!VALID_AGENT_ROLES.has(role)) return null;
  return evaluate(cwd, runId, childId, null, null, role, 'PreToolUse', true);
}

export function readCodexModelObservation(
  cwd: string,
  runId: string,
  childIds: readonly string[],
): CodexModelObservation | null {
  const observations = readStore(cwd, runId);
  for (const id of childIds) {
    if (id && observations[id]) return observations[id]!;
  }
  return null;
}
