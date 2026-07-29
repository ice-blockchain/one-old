// src/shared/opencode-roles-batch-state.ts
// Plan-batch lifecycle: marker files, outcome derivation from unit statuses,
// completion gates, and architect queue freshness.

import * as fs from 'fs';
import * as path from 'path';
import { opencodeAssignmentHash, readOpenCodeQueue, readOpenCodeUnitStatuses } from '../opencode-queue';
import { detectHost } from '../host';
import { openCodeDelegationActive } from '../performance';
import { isMaintenancePhase } from '../state/lifecycle';
import { obj } from '../obj';

import {
  TERMINAL_BATCH_OUTCOMES,
  planDelegationQueueRolesForRun,
  type OpenCodePlanBatchOutcome,
  type OpenCodePlanBatchState,
  type Rec,
  normalizeAttemptRole,
} from './plan-units';

function planBatchDir(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-plan-batch');
}

function planBatchCompletePath(cwd: string, runId: string): string {
  return path.join(planBatchDir(cwd, runId), 'COMPLETE');
}

export function planBatchJsonPath(cwd: string, runId: string): string {
  return path.join(planBatchDir(cwd, runId), 'batch.json');
}

export function planBatchMarkerPath(cwd: string, runId: string, role: string): string {
  return path.join(planBatchDir(cwd, runId), normalizeAttemptRole(role));
}

export function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeLegacyBatchComplete(cwd: string, runId: string): void {
  const p = planBatchCompletePath(cwd, runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '', 'utf8');
}

export function readOpenCodePlanBatchState(cwd: string, runId: string): OpenCodePlanBatchState | null {
  if (!runId) return null;
  try {
    const raw = fs.readFileSync(planBatchJsonPath(cwd, runId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Rec;
    const outcome = rec.outcome;
    if (outcome !== 'running' && outcome !== 'success' && outcome !== 'failed' && outcome !== 'partial' && outcome !== 'abandoned') return null;
    const startedAt = typeof rec.startedAt === 'string' ? rec.startedAt : '';
    if (!startedAt) return null;
    const rolesCompleted = Array.isArray(rec.rolesCompleted)
      ? rec.rolesCompleted.filter((r): r is string => typeof r === 'string')
      : [];
    const assignmentHash = typeof rec.assignmentHash === 'string' && rec.assignmentHash
      ? rec.assignmentHash
      : null;
    // Supersession: a replan republishes assignments.json, so a batch stamped
    // with a DIFFERENT hash belongs to the pre-replan world. Report "no batch"
    // so Step-0 runs again on the fresh queue instead of replaying the stale
    // verdict (observed 4cu). Legacy batches without a stamp keep old behavior.
    if (assignmentHash) {
      const current = opencodeAssignmentHash(cwd, runId);
      if (current && current !== assignmentHash) return null;
    }
    return {
      version: 1,
      outcome,
      startedAt,
      ...(typeof rec.finishedAt === 'string' ? { finishedAt: rec.finishedAt } : {}),
      rolesCompleted,
      ...(rec.error != null ? { error: String(rec.error) } : {}),
      ...(assignmentHash ? { assignmentHash } : {}),
    };
  } catch {
    return null;
  }
}

/** Idempotent: marks the Step-0 batch as running without clobbering a terminal state. */
export function markOpenCodePlanBatchRunning(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    const existing = readOpenCodePlanBatchState(cwd, runId);
    if (existing && TERMINAL_BATCH_OUTCOMES.has(existing.outcome)) return;
    if (existing?.outcome === 'running') return;
    atomicWriteJson(planBatchJsonPath(cwd, runId), {
      version: 1,
      outcome: 'running',
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      rolesCompleted: existing?.rolesCompleted ?? [],
      assignmentHash: opencodeAssignmentHash(cwd, runId),
    } satisfies OpenCodePlanBatchState);
  } catch {
    // best-effort
  }
}

const TERMINAL_FAILURE_ACTIONS = new Set(['failed', 'skipped', 'no-changes', 'no_changes', 'rejected_policy']);

function unitIsDelegated(u: { action?: string; status?: string }): boolean {
  return u.action === 'delegated' || u.status === 'delegated';
}

function unitIsTerminalFailure(u: { action?: string; status?: string }): boolean {
  return TERMINAL_FAILURE_ACTIONS.has(u.action || u.status || '');
}

export function deriveBatchOutcomeFromUnits(
  units: ReadonlyArray<{ action?: string; status?: string }>,
  error?: string | null,
): OpenCodePlanBatchOutcome {
  if (/stopped polling|abandoned/i.test(error || '')) return 'abandoned';
  if (units.some((u) => u.action === 'abandoned' || u.status === 'abandoned')) return 'abandoned';
  if (units.length === 0) return 'failed';
  const hasDelegated = units.some(unitIsDelegated);
  if (!hasDelegated) return 'failed';
  const hasFailure = units.some(unitIsTerminalFailure);
  if (hasFailure) return 'partial';
  return 'success';
}

/** Sole terminal writer for batch.json; also writes the legacy COMPLETE marker (fail-open gate). */
export function markOpenCodePlanBatchTerminal(
  cwd: string,
  runId: string,
  outcome: OpenCodePlanBatchOutcome,
  error?: string | null,
): void {
  if (!runId || outcome === 'running') return;
  try {
    const existing = readOpenCodePlanBatchState(cwd, runId);
    if (existing && TERMINAL_BATCH_OUTCOMES.has(existing.outcome)) return;
    atomicWriteJson(planBatchJsonPath(cwd, runId), {
      version: 1,
      outcome,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      rolesCompleted: existing?.rolesCompleted ?? [],
      ...(error ? { error: String(error).slice(0, 500) } : {}),
      assignmentHash: opencodeAssignmentHash(cwd, runId),
    } satisfies OpenCodePlanBatchState);
    writeLegacyBatchComplete(cwd, runId);
  } catch {
    // best-effort; legacy markers remain the fallback
  }
}

// Run-level terminal marker for the entire Step-0 from-plan batch. The spawn gate
// treats this as authoritative so a single check clears implementers after the
// orchestrator (or runner) finishes the batch — even when per-role markers lag.
export function markOpenCodePlanBatchComplete(cwd: string, runId: string): void {
  markOpenCodePlanBatchTerminal(cwd, runId, 'success');
}

const TERMINAL_PLAN_UNIT_STATUSES = new Set([
  'delegated',
  'failed',
  'no_changes',
  'no-changes',
  'skipped',
  'skipped_no_units',
  'rejected_policy',
  'fallback_required',
]);

function allQueuedPlanUnitsTerminal(cwd: string, runId: string): boolean {
  if (!runId) return false;
  if (planDelegationQueueRolesForRun(cwd, runId).length === 0) return false;
  const queue = readOpenCodeQueue(cwd, runId);
  if (!queue || queue.units.length === 0) return false;
  const statuses = readOpenCodeUnitStatuses(cwd, runId);
  return queue.units.every((q) => {
    const s = statuses.find((x) => x.id === q.id);
    if (!s) return false;
    if (s.status === 'running' || s.action === 'running') return false;
    const status = s.status || '';
    const action = s.action || '';
    return TERMINAL_PLAN_UNIT_STATUSES.has(status) || TERMINAL_PLAN_UNIT_STATUSES.has(action);
  });
}

export function openCodePlanBatchComplete(cwd: string, runId: string): boolean {
  if (!runId) return false;
  try {
    const state = readOpenCodePlanBatchState(cwd, runId);
    if (state?.outcome === 'running') return false;
    if (state && TERMINAL_BATCH_OUTCOMES.has(state.outcome)) return true;
    if (fs.existsSync(planBatchCompletePath(cwd, runId))) {
      const batchState = readOpenCodePlanBatchState(cwd, runId);
      if (batchState?.outcome === 'running') return false;
      return true;
    }
    // Belt-and-suspenders: shell fallback may have terminal unit rows without
    // batch.json when an older runner omitted finalizePlanBatch — clear only when
    // every queued unit is terminal and no running batch marker exists.
    if (allQueuedPlanUnitsTerminal(cwd, runId)) {
      const batch = readOpenCodePlanBatchState(cwd, runId);
      if (!batch || batch.outcome !== 'running') return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Architect-run evidence for THIS run: its handoff digest on disk, or a
// recorded `senior-architect` entry in the run's agent registry. A hand-copied
// assignments manifest comes with NEITHER (observed 11c: the orchestrator
// copied the build's assignments.json into a small maintenance run — runId
// rewritten, createdBy kept — which made the stale plan.md queue look fresh
// and re-armed the Step-0 gate into one dead "Couldn't start" spawn).
function architectRanThisRun(cwd: string, runId: string): boolean {
  for (const name of ['architect.md', 'senior-architect.md']) {
    try {
      if (fs.statSync(path.join(cwd, '.traffic-one', 'digests', runId, name)).isFile()) return true;
    } catch {
      // try the next digest name
    }
  }
  try {
    const registry = obj(JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', runId, 'agents.json'), 'utf8')));
    const agents = registry ? obj(registry.agents) : null;
    if (agents && obj(agents['senior-architect'])) return true;
  } catch {
    // no registry — not an architect run
  }
  return false;
}

// The senior-architect writes a run-scoped `runs/<runId>/assignments.json` on
// every architect run (a new-project scaffold OR a complex maintenance build it
// was spawned for). Its presence — TOGETHER with architect-run evidence for the
// same run (digest or agent-registry entry; see architectRanThisRun) — is our
// proof that plan.md's `opencode-delegate` block is FRESH for THIS run, not the
// durable block left over from a previous build. The manifest alone is not
// enough: an orchestrator can hand-copy it for scope provisioning, and that
// copy must not re-run a stale queue. `opencodeAssignmentHash` reads exactly
// that file and is null when it is absent, so small/triage maintenance runs
// (which never invoke the architect) never look fresh. Requiring it also makes
// `expectedAssignmentHash` non-null, re-activating the runner's stale-diff guard.
export function hasFreshArchitectQueueForRun(cwd: string, runId: string): boolean {
  return Boolean(runId)
    && opencodeAssignmentHash(cwd, runId) !== null
    && architectRanThisRun(cwd, runId);
}

// Plan-batch delegation applies to new-project builds AND to complex maintenance
// builds that re-entered the architect THIS run. Small maintenance work (triage
// → direct-to-implementer, no fresh architect queue) stays on the per-role
// `opencode_delegate` path and must NOT re-run a stale plan.md queue. `mode`
// stays "new-project" for the project's whole life, so the build-phase disjunct
// must exclude maintenance explicitly — otherwise every small maintenance run
// re-triggers Step-0 on the previous build's queue (observed 8c: the first
// "Couldn't start" on a maintenance feature was this gate demanding a Step-0
// batch for a stale queue).
export function planBatchPhaseEligible(cwd: string, runId: string, state: unknown): boolean {
  if (hasFreshArchitectQueueForRun(cwd, runId)) return true;
  return obj(state)?.mode === 'new-project' && !isMaintenancePhase(state);
}

// True when an implementer spawn must wait for Step-0 from-plan — in a new-project
// build, or a complex maintenance build with a fresh architect-produced queue.
export function shouldBlockImplementerForPlanBatch(cwd: string, runId: string, state: unknown, host: unknown = detectHost()): boolean {
  if (!runId || !openCodeDelegationActive(state, host)) return false;
  if (!planBatchPhaseEligible(cwd, runId, state)) return false;
  if (planDelegationQueueRolesForRun(cwd, runId).length === 0) return false;
  return !openCodePlanBatchComplete(cwd, runId);
}

// Terminal marker for the Step-0 `opencode_delegate_from_plan` batch. Unlike
// `opencode-attempts/<role>`, this is written only after the plan-batch runner
// finishes processing that queued role. That lets the spawn gate block paid
// implementers while the batch is merely RUNNING, but proceed once the batch is
// terminal even when a unit was skipped before the OpenCode CLI could be reached.
