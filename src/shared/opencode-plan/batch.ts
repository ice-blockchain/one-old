// src/shared/opencode-plan/batch.ts
// Single source of truth for terminal Step-0 plan-batch state. Both the MCP
// delegate wrapper and the shell `opencode-runner.cjs --from-plan` path must
// produce identical artifacts under `.traffic-one/runs/<runId>/opencode-plan-batch/`.

import {
  deriveBatchOutcomeFromUnits,
  markOpenCodePlanBatchRunning,
  markOpenCodePlanBatchTerminal,
  markOpenCodePlanRoleCompleted,
  planDelegationQueueRolesForRun,
  readOpenCodePlanBatchState,
} from '../opencode-roles';
import {
  finalizeOpenCodeUnitsForBatch,
  hasRunningOpenCodeUnits,
  persistBatchUnitsToStatus,
  readOpenCodeQueue,
  readOpenCodeUnitStatuses,
  reconcileAllRunningUnits,
} from '../opencode-queue';

interface PlanBatchUnit {
  id?: string;
  role: string;
  task?: string;
  action?: string;
  status?: string;
  touched?: string[];
  error?: string | null;
}

export interface PlanBatchResult {
  ok?: boolean;
  action?: string;
  error?: string | null;
  total?: number;
  delegated?: number;
  units?: PlanBatchUnit[];
}

const TERMINAL_UNIT_STATUSES = new Set([
  'delegated',
  'failed',
  'no_changes',
  'no-changes',
  'skipped',
  'skipped_no_units',
  'rejected_policy',
  'fallback_required',
]);

export function mergeMissingQueueUnits(projectRoot: string, runId: string, merged: PlanBatchResult): void {
  const queue = readOpenCodeQueue(projectRoot, runId);
  if (!queue) return;
  if (!Array.isArray(merged.units)) merged.units = [];
  const seen = new Set(merged.units.map((u) => u.id).filter(Boolean));
  const error = merged.error || 'runner produced no JSON result';
  for (const q of queue.units) {
    if (seen.has(q.id)) continue;
    merged.units.push({
      id: q.id,
      role: q.role,
      task: q.task,
      action: 'failed',
      status: 'failed',
      touched: [],
      error,
    });
  }
  merged.total = queue.units.length;
  merged.delegated = merged.units.filter((u) => u.action === 'delegated' || u.status === 'delegated').length;
}

/** Idempotent: marks running only when the batch is not already terminal. */
export function markPlanBatchRunningIfNeeded(projectRoot: string, runId: string): void {
  if (!runId) return;
  markOpenCodePlanBatchRunning(projectRoot, runId);
}

export function buildBatchResultFromUnitStatuses(projectRoot: string, runId: string): PlanBatchResult {
  const queue = readOpenCodeQueue(projectRoot, runId);
  const statuses = readOpenCodeUnitStatuses(projectRoot, runId);
  const units: PlanBatchUnit[] = [];
  if (queue) {
    for (const q of queue.units) {
      const s = statuses.find((x) => x.id === q.id);
      const action = s?.action || s?.status || 'failed';
      units.push({
        id: q.id,
        role: q.role,
        task: q.task,
        action,
        status: s?.status,
        touched: s?.touched || [],
        error: s?.error ?? null,
      });
    }
  } else {
    for (const s of statuses) {
      units.push({
        id: s.id,
        role: s.role,
        action: s.action || s.status,
        status: s.status,
        touched: s.touched,
        error: s.error ?? null,
      });
    }
  }
  const delegated = units.filter((u) => u.action === 'delegated' || u.status === 'delegated').length;
  return { total: units.length, delegated, units };
}


/** Sole terminal writer shared by MCP and shell paths. */
export function finalizePlanBatch(projectRoot: string, runId: string, merged: PlanBatchResult): PlanBatchResult {
  if (!runId) return merged;
  const existing = readOpenCodePlanBatchState(projectRoot, runId);
  if (existing && existing.outcome !== 'running' && existing.outcome !== undefined) {
    const terminal = new Set(['success', 'failed', 'partial', 'abandoned']);
    if (terminal.has(existing.outcome)) return merged;
  }
  mergeMissingQueueUnits(projectRoot, runId, merged);
  finalizeOpenCodeUnitsForBatch(projectRoot, runId, merged.error || 'batch finalized');
  if (hasRunningOpenCodeUnits(projectRoot, runId)) {
    reconcileAllRunningUnits(projectRoot, runId, 'running units remain after batch reconcile');
  }
  persistBatchUnitsToStatus(projectRoot, runId, merged.units || []);
  const outcome = deriveBatchOutcomeFromUnits(merged.units || [], merged.error);
  markOpenCodePlanBatchTerminal(projectRoot, runId, outcome, merged.error ?? null);
  for (const role of planDelegationQueueRolesForRun(projectRoot, runId)) {
    markOpenCodePlanRoleCompleted(projectRoot, runId, role);
  }
  return merged;
}

export function finalizePlanBatchOnly(projectRoot: string, runId: string): PlanBatchResult {
  const merged = buildBatchResultFromUnitStatuses(projectRoot, runId);
  return finalizePlanBatch(projectRoot, runId, merged);
}
