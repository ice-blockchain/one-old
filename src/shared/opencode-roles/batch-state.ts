// src/shared/opencode-roles-batch-state.ts
// Plan-batch lifecycle: marker files, outcome derivation from unit statuses,
// completion gates, and architect queue freshness.

import * as fs from 'fs';
import * as path from 'path';
import { opencodeAssignmentHash, readOpenCodeQueue, readOpenCodeUnitStatuses } from '../opencode-queue';
import { abandonAfterMs, maxConsecutiveStalls, opencodeUnitTimeoutMs } from '../../config/opencode-timeouts';
import { detectHost } from '../host';
import { openCodeDelegationActive } from '../performance';
import { isMaintenancePhase } from '../state/lifecycle';
import { obj } from '../obj';

import { openCodeApplyInProgress } from './apply-latch';
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

// ── Batch liveness ───────────────────────────────────────────────────────────
// batch.json has NO heartbeat by design (its mtime never advances while
// running, and adding a field would race the terminal writer: atomicWriteJson
// is rename-atomic but lock-free, so a 30s tick could rename OVER a
// just-written terminal state and resurrect `running` — the exact permanent
// wedge this machinery exists to recover from). Liveness is therefore a
// SIDECAR dotfile (dotfiles are excluded from completedRolesFromMarkers) that
// only ever gets touched, never carries batch state.

function planBatchHeartbeatPath(cwd: string, runId: string): string {
  return path.join(planBatchDir(cwd, runId), '.heartbeat');
}

/** Touched by the MCP watchdog tick and between role shards/units. Never
 *  writes batch.json. */
export function touchPlanBatchHeartbeat(cwd: string, runId: string): void {
  if (!runId) return;
  try {
    const p = planBatchHeartbeatPath(cwd, runId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid })}\n`, 'utf8');
  } catch {
    // best-effort; absence just narrows liveness evidence to unit freshness
  }
}

function planBatchHeartbeatFresh(cwd: string, runId: string, withinMs: number, nowMs: number): boolean {
  try {
    return nowMs - fs.statSync(planBatchHeartbeatPath(cwd, runId)).mtimeMs < withinMs;
  } catch {
    return false;
  }
}

/** The sanctioned in-flight budget of ONE unit: the runner is spawnSync end to
 *  end, so a unit's ledger `updatedAt` is written once at start and cannot be
 *  refreshed mid-attempt from inside the runner. The longest legitimate unit
 *  is the full stall walk (maxConsecutiveStalls × unit timeout) plus apply and
 *  post-apply verification headroom. */
export function unitLivenessWindowMs(): number {
  return maxConsecutiveStalls() * opencodeUnitTimeoutMs() + 5 * 60_000;
}

function anyRunningUnitFresh(cwd: string, runId: string, nowMs: number): boolean {
  const windowMs = unitLivenessWindowMs();
  return readOpenCodeUnitStatuses(cwd, runId).some((entry) => {
    if (entry.status !== 'running') return false;
    const at = Date.parse(entry.updatedAt || '');
    return Number.isFinite(at) && nowMs - at < windowMs;
  });
}

/** Any positive evidence that a `running` batch still has a live executor:
 *  a fresh heartbeat sidecar (MCP watchdog / between-shard touches), a running
 *  unit inside its sanctioned in-flight window, or a pid-verified apply latch.
 *  A `running` batch.json with NONE of these is a leftover from a dead process
 *  (kill -9, host crash) — observed to wedge the spawn gate forever. */
export function batchLooksLive(cwd: string, runId: string, nowMs: number = Date.now()): boolean {
  if (!runId) return false;
  return planBatchHeartbeatFresh(cwd, runId, abandonAfterMs(), nowMs)
    || anyRunningUnitFresh(cwd, runId, nowMs)
    || openCodeApplyInProgress(cwd, runId, nowMs);
}

// ── Live file reservations ───────────────────────────────────────────────────

export interface OpenCodeReservation {
  unitId: string;
  role: string;
  patterns: string[];
}

/** The allowedFiles of every unit that is verifiably EXECUTING right now:
 *  ledger status `running` with a fresh `updatedAt` (inside the sanctioned
 *  in-flight window — the runner is spawnSync and cannot refresh mid-attempt;
 *  the MCP watchdog touches it every tick), or a pid-verified apply latch for
 *  the run. Derived, never a sidecar: the unit ledger is already the single
 *  source of execution state. Units with an empty allowlist reserve nothing
 *  (fail-open — there is nothing verifiable to reserve). */
export function reservedOpenCodeFiles(cwd: string, runId: string, nowMs: number = Date.now()): OpenCodeReservation[] {
  if (!runId) return [];
  try {
    const windowMs = unitLivenessWindowMs();
    const latchLive = openCodeApplyInProgress(cwd, runId, nowMs);
    return readOpenCodeUnitStatuses(cwd, runId)
      .filter((entry) => entry.status === 'running'
        && Array.isArray(entry.allowedFiles)
        && entry.allowedFiles.length > 0)
      .filter((entry) => {
        if (latchLive) return true;
        const at = Date.parse(entry.updatedAt || '');
        return Number.isFinite(at) && nowMs - at < windowMs;
      })
      .map((entry) => ({
        unitId: entry.id,
        role: entry.role,
        patterns: (entry.allowedFiles as string[]).filter(Boolean),
      }));
  } catch {
    return []; // stale/no ledger never blocks a paid writer
  }
}

// Roles whose per-role completion MARKER exists on disk. The markers are the
// durable record; `rolesCompleted` in batch.json is only a mirror of them, and
// that mirror was written by the terminal writer BEFORE the per-role loop ran —
// and `markOpenCodePlanRoleCompleted` refuses to touch a terminal batch — so a
// finished batch recorded `outcome: "success"` with `rolesCompleted: []` while
// four units had completed (observed live). Union the markers in here so the
// mirror is right whatever order the two writers run in.
function completedRolesFromMarkers(cwd: string, runId: string): string[] {
  try {
    return fs.readdirSync(planBatchDir(cwd, runId), { withFileTypes: true })
      .filter((entry) => entry.isFile()
        && entry.name !== 'batch.json'
        && entry.name !== 'COMPLETE'
        && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return []; // no batch dir yet — nothing has completed
  }
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
    if (existing?.outcome === 'running') {
      // A re-mark means a live executor touched the batch — refresh liveness
      // even though batch.json itself is left alone.
      touchPlanBatchHeartbeat(cwd, runId);
      return;
    }
    atomicWriteJson(planBatchJsonPath(cwd, runId), {
      version: 1,
      outcome: 'running',
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      rolesCompleted: existing?.rolesCompleted ?? [],
      assignmentHash: opencodeAssignmentHash(cwd, runId),
    } satisfies OpenCodePlanBatchState);
    // Starting the batch IS the first proof of life: without this, the window
    // between `running` landing and the first watchdog tick / unit record
    // would read as a dead batch and briefly open the spawn gate.
    touchPlanBatchHeartbeat(cwd, runId);
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
      rolesCompleted: [...new Set([
        ...(existing?.rolesCompleted ?? []),
        ...completedRolesFromMarkers(cwd, runId),
      ])],
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
  if (openCodePlanBatchComplete(cwd, runId)) return false;
  // A batch stamped `running` blocks ONLY while something is verifiably alive.
  // batch.json cannot go terminal on its own after a kill -9 / host crash
  // (shards never write terminal; the in-memory MCP registry is gone), and the
  // old behavior blocked implementers FOREVER with a prose-only recovery
  // (--finalize-only). With liveness, a dead batch opens the gate within
  // ~unitLivenessWindowMs (~25 min) automatically; a batch that never started
  // (no batch.json) still blocks — Step-0 must run first.
  const batch = readOpenCodePlanBatchState(cwd, runId);
  if (batch?.outcome === 'running' && !batchLooksLive(cwd, runId)) return false;
  return true;
}

// Terminal marker for the Step-0 `opencode_delegate_from_plan` batch. Unlike
// `opencode-attempts/<role>`, this is written only after the plan-batch runner
// finishes processing that queued role. That lets the spawn gate block paid
// implementers while the batch is merely RUNNING, but proceed once the batch is
// terminal even when a unit was skipped before the OpenCode CLI could be reached.
