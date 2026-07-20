// Cross-event Codex model evidence. SubagentStart is non-blocking and may arrive
// before role metadata is visible; the child's first PreToolUse is blocking and
// completes verification against the immutable per-run model policy.

import * as fs from 'fs';
import * as path from 'path';

import { RUNS_REL_DIR, VALID_AGENT_ROLES } from '../../config/state';
import { obj, type Rec } from '../obj';
import { readRunModelPolicy } from '../run-model-policy';

const STORE_VERSION = 1;
const STORE_FILE = 'codex-model-observations.json';
const LOCK_TIMEOUT_MS = 1_000;
const LOCK_STALE_MS = 10_000;

export type CodexModelObservationStatus = 'pending-role' | 'verified' | 'mismatch' | 'conflict';

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
    const raw = obj(JSON.parse(fs.readFileSync(storePath(cwd, runId), 'utf8')));
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

function withStoreLock<T>(cwd: string, runId: string, body: () => T): T | null {
  const filePath = storePath(cwd, runId);
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as Rec;
        if (typeof owner.at === 'number' && Date.now() - owner.at > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch { /* writer may still be publishing owner */ }
      if (Date.now() >= deadline) return null;
      sleepSync(10);
    }
  }
  try {
    return body();
  } finally {
    try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    if (previous?.parentSessionId && parentSessionId && previous.parentSessionId !== parentSessionId) {
      const conflict = { ...previous, status: 'conflict' as const, reason: 'parent-session-conflict', updatedAt: now };
      observations[childId] = conflict;
      writeStore(cwd, runId, observations);
      return conflict;
    }
    if (previous?.actualModel && actualModel && previous.actualModel !== actualModel) {
      const conflict = { ...previous, status: 'conflict' as const, reason: 'hook-model-conflict', updatedAt: now };
      observations[childId] = conflict;
      writeStore(cwd, runId, observations);
      return conflict;
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
    // A terminal mismatch cannot be healed by an ordinary delayed event. Only an
    // authoritative role correction may re-evaluate the same immutable model.
    if (previous?.status === 'mismatch' && !allowRoleCorrection) return previous;
    const next: CodexModelObservation = {
      childId,
      parentSessionId: previous?.parentSessionId || parentSessionId,
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
