// src/runners/opencode/from-plan.ts
// The --from-plan batch: parse the plan queue, walk units in dependency
// order with per-role sharding, and settle the plan-batch state.

import * as path from 'path';
import { resolveProjectRoot } from '../../shared/hook/paths';
import {
  hasFreshArchitectQueueForRun,
  markOpenCodePlanRoleCompleted,
  type PlanDelegationUnit,
  parsePlanDelegationUnits,
  touchPlanBatchHeartbeat,
} from '../../shared/opencode-roles';
import {
  finalizePlanBatch,
  finalizePlanBatchOnly,
  markPlanBatchRunningIfNeeded,
} from '../../shared/opencode-plan/batch';
import { restorePlanOpenCodeDelegateBlock } from '../../shared/opencode-plan/preserve';
import {
  blockedByFailedDependencies,
  buildOpenCodeQueue,
  implicitProducerDependencies,
  openCodeQueuePolicyReport,
  readOpenCodeUnitStatuses,
  recordOpenCodeUnitStatus,
  reconcileStaleRunningUnits,
  statusFromDelegateAction,
  writeOpenCodeQueue,
  type OpenCodeUnitStatus,
} from '../../shared/opencode-queue';
import { isMaintenancePhase, readEffectiveState, readRunAssignmentsResilient } from '../../shared/state';
import {
  type DelegateResult,
  type FailureKind,
  type Rec,
} from './types';
import {
  classifyFailureKind,
} from './maintenance';
import { delegate } from './index';
import { normalizePlanRole } from './diff-policy';
import {
  normalizePlanI18nUnits,
} from './i18n';
import { readRegularFileOrThrow } from '../../shared/bounded-read';

interface PlanDelegationResult {
  total: number;
  delegated: number;
  units: Array<{ id?: string; role: string; task: string; action: DelegateResult['action']; status?: string; touched: string[]; model?: string; failureKind?: FailureKind | null; error?: string | null }>;
}

// Parse the architect's plan.md delegation queue. The architect emits a
// machine-readable block listing ONLY bounded/low-risk units (senior work is
// never queued), so delegation does not depend on the orchestrator re-deciding
// per unit mid-flight:
//   <!-- opencode-delegate:start -->
//   - role: backend | files: src/lib/seed.ts | task: <self-contained task>
//   <!-- opencode-delegate:end -->
export { finalizePlanBatchOnly } from '../../shared/opencode-plan/batch';

export function parsePlanDelegationQueue(planText: string): PlanDelegationUnit[] {
  return parsePlanDelegationUnits(planText);
}

// Deterministically delegate EVERY queued bounded unit to OpenCode. Reuses
// delegate() per unit (each in its own worktree from HEAD); the free-model
// chain position is memoized across units, so a retired promo id is skipped
// after the first unit discovers it. A unit that opencode can't deliver
// (skipped/failed/no-changes) simply isn't applied — the orchestrator then
// spawns a normal subagent for it. Never throws.
// Normalize role labels for comparisons ("senior-frontend" ≡ "frontend").

export function delegateFromPlan(cwd: string = process.cwd(), opts: { runId?: string; model?: string; roles?: readonly string[] } = {}): PlanDelegationResult {
  cwd = resolveProjectRoot(cwd);
  const state = (readEffectiveState(cwd) || {}) as Rec;
  const stateRunId = typeof state.currentRunId === 'string'
    ? state.currentRunId.trim()
    : (typeof state.currentRunId === 'number' && Number.isFinite(state.currentRunId) ? String(Math.trunc(state.currentRunId)) : '');
  const runId = (opts.runId || '').trim() || stateRunId;
  let planText = '';
  try { planText = readRegularFileOrThrow(path.join(cwd, '.traffic-one', 'plan.md')); } catch { /* no plan → empty queue */ }
  // In maintenance, plan.md is a durable artifact from the last build, so from-plan
  // is a no-op — UNLESS the architect wrote a fresh run-scoped queue for THIS run
  // (a complex maintenance build). `hasFreshArchitectQueueForRun` gates that: it
  // requires `runs/<runId>/assignments.json` PLUS architect-run evidence (digest
  // or agent-registry entry) for the same run — small/triage maintenance runs
  // never produce those, and a hand-copied manifest alone doesn't count, so a
  // stale plan.md is never re-delegated.
  const maintenanceQueueSuppressed =
    isMaintenancePhase(state, typeof state.mode === 'string' ? state.mode : undefined) &&
    !hasFreshArchitectQueueForRun(cwd, runId);
  // Runtime touchpoint for the preserved-queue auto-fix: a prose rewrite may
  // have landed without the machine block (the plan-write gate preserved the
  // accepted queue instead of denying). Repair plan.md BEFORE parsing — and
  // before writeOpenCodeQueue below overwrites the compiled-queue sidecar the
  // repair may reconstruct from.
  if (!maintenanceQueueSuppressed && runId
    && parsePlanDelegationQueue(planText).length === 0
    && restorePlanOpenCodeDelegateBlock(cwd, runId)) {
    try { planText = readRegularFileOrThrow(path.join(cwd, '.traffic-one', 'plan.md')); } catch { /* keep prior read */ }
  }
  const parsedQueue = maintenanceQueueSuppressed ? [] : parsePlanDelegationQueue(planText);
  const normalizedI18n = normalizePlanI18nUnits(cwd, runId, parsedQueue);
  const queue = normalizedI18n.units;
  const formalQueue = buildOpenCodeQueue(cwd, runId, queue);
  writeOpenCodeQueue(cwd, formalQueue);
  // `index` is the position in the FULL parsed queue — the role-shard filter
  // below reorders `entries`, so a position recomputed from the filtered list
  // would key the i18n errors map wrong for every unit after the first shard.
  let entries = queue.map((unit, index) => ({ unit, formal: formalQueue.units[index]!, index }));
  // Role shard filter: the MCP layer parallelizes the batch ACROSS roles (units
  // within one role stay sequential — they share a digest file).
  if (opts.roles && opts.roles.length > 0) {
    const allowed = new Set(opts.roles.map((r) => normalizePlanRole(r)));
    entries = entries.filter((entry) => allowed.has(normalizePlanRole(entry.unit.role)));
  }
  const units: PlanDelegationResult['units'] = [];
  let delegated = 0;
  const totalByRole = new Map<string, number>();
  const processedByRole = new Map<string, number>();
  for (const entry of entries) {
    const normalizedRole = normalizePlanRole(entry.unit.role);
    totalByRole.set(normalizedRole, (totalByRole.get(normalizedRole) || 0) + 1);
  }
  if (entries.length === 0) {
    const unit = {
      id: '__no_units__',
      role: 'batch',
      task: 'No runnable OpenCode units were queued for this batch.',
      action: 'skipped' as const,
      status: 'skipped_no_units',
      touched: [] as string[],
      error: 'No runnable OpenCode units were queued for this batch or role shard.',
    };
    if (runId) {
      recordOpenCodeUnitStatus(cwd, runId, {
        id: unit.id,
        role: unit.role,
        status: 'skipped_no_units',
        action: 'skipped-no-units',
        error: unit.error,
        touched: [],
        assignmentHash: formalQueue.assignmentHash,
      });
    }
    return { total: 0, delegated: 0, units: [unit] };
  }
  if (runId) markPlanBatchRunningIfNeeded(cwd, runId);
  try {
    const scopeManifest = runId ? readRunAssignmentsResilient(cwd, runId) : null;
    const policyReport = openCodeQueuePolicyReport(queue, scopeManifest ? { assignments: scopeManifest.assignments } : {});
    const rejectAll = policyReport.violations.length > 0 && policyReport.byUnitId.size === 0;
    // Seed from the PERSISTED ledger: role shards are separate runner processes, so a
    // dependency may already have failed in an earlier shard (17c: a tester unit
    // depended on a backend unit rejected 3 minutes earlier, then burned 303s
    // rebuilding what that unit never delivered). Kept current as units settle below.
    const unitOutcomes = new Map<string, OpenCodeUnitStatus>();
    if (runId) {
      for (const status of readOpenCodeUnitStatuses(cwd, runId)) unitOutcomes.set(status.id, status.status);
    }
    // Kind-derived producer edges for the units whose `depends:` the plan left
    // implicit. Built from the FULL queue, not the role shard, so every runner
    // process derives the same map.
    const implicitDeps = implicitProducerDependencies(formalQueue.units);

    for (const entry of entries) {
      const u = entry.unit;
      const formal = entry.formal;
      const normalizedRole = normalizePlanRole(u.role);
      const blockedBy = blockedByFailedDependencies(formal.dependsOn, unitOutcomes);
      // Only when no DECLARED edge already blocks — the declared message names
      // the plan's own field and is the one an operator should act on.
      const producerBlockedBy = blockedBy.length > 0
        ? []
        : blockedByFailedDependencies(implicitDeps.get(formal.id), unitOutcomes);
      if (blockedBy.length > 0 || producerBlockedBy.length > 0) {
        const error = blockedBy.length > 0
          ? `skipped: dependency ${blockedBy.map((d) => `\`${d}\``).join(', ')} did not land, so this unit's prerequisites are missing`
          : `skipped: producer ${producerBlockedBy.map((d) => `\`${d}\``).join(', ')} did not land, so the exports this \`${formal.kind || 'consumer'}\` unit builds against were rolled back with that unit's diff. The queue declared no \`depends:\` edge for this pair — add one so the plan states the order it already relies on`;
        if (runId) {
          recordOpenCodeUnitStatus(cwd, runId, {
            id: formal.id,
            role: formal.role,
            status: 'skipped',
            action: blockedBy.length > 0 ? 'skipped-dependency-failed' : 'skipped-producer-failed',
            failureKind: 'skipped',
            error,
            touched: [],
            allowedFiles: formal.allowedFiles,
            assignmentHash: formalQueue.assignmentHash,
          });
        }
        unitOutcomes.set(formal.id, 'skipped');
        units.push({ id: formal.id, role: u.role, task: u.task, action: 'skipped', status: 'skipped', touched: [], failureKind: 'skipped', error });
        processedByRole.set(normalizedRole, (processedByRole.get(normalizedRole) || 0) + 1);
        continue;
      }
      const unitPolicyViolations = [
        ...(rejectAll ? policyReport.violations : (policyReport.byUnitId.get(formal.id) || [])),
      ];
      const i18nPolicyError = normalizedI18n.errors.get(u.id || `position-${entry.index + 1}`);
      if (i18nPolicyError) unitPolicyViolations.push(i18nPolicyError);
      if (unitPolicyViolations.length > 0) {
        const error = unitPolicyViolations.join('; ');
        if (runId) {
          recordOpenCodeUnitStatus(cwd, runId, {
            id: formal.id,
            role: formal.role,
            status: 'rejected_policy',
            action: 'failed',
            failureKind: 'diff-rejected',
            error,
            touched: [],
            allowedFiles: formal.allowedFiles,
            assignmentHash: formalQueue.assignmentHash,
          });
        }
        unitOutcomes.set(formal.id, 'rejected_policy');
        units.push({ id: formal.id, role: u.role, task: u.task, action: 'failed', status: 'rejected_policy', touched: [], failureKind: 'diff-rejected', error });
        processedByRole.set(normalizedRole, (processedByRole.get(normalizedRole) || 0) + 1);
        continue;
      }
      if (runId) {
        recordOpenCodeUnitStatus(cwd, runId, {
          id: formal.id,
          role: formal.role,
          status: 'running',
          action: 'running',
          touched: [],
          allowedFiles: formal.allowedFiles,
          assignmentHash: formalQueue.assignmentHash,
        });
        // Between-unit liveness on the shell path (no MCP watchdog exists
        // here): the delegate below is spawnSync, so this is the last moment
        // this process can prove the batch alive before going dark for the
        // unit's whole in-flight window.
        touchPlanBatchHeartbeat(cwd, runId);
      }
      const task = formal.allowedFiles.length > 0
        ? `${u.task}\n\nFiles/area: ${formal.allowedFiles.join(',')}`
        : u.task;
      let r: DelegateResult;
      try {
        r = delegate(cwd, {
          role: u.role,
          task,
          runId,
          model: opts.model,
          allowedFiles: u.files,
          unitId: formal.id,
          expectedAssignmentHash: formalQueue.assignmentHash,
        });
      } catch (err) {
        r = {
          ok: false,
          action: 'failed',
          digest: null,
          touched: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const failureKind = r.failureKind ?? classifyFailureKind(r.action, r.error);
      const status = statusFromDelegateAction(r.action, r.error);
      if (runId) {
        recordOpenCodeUnitStatus(cwd, runId, {
          id: formal.id,
          role: formal.role,
          status,
          action: r.action,
          model: r.model ?? null,
          failureKind: failureKind ?? null,
          error: r.error,
          touched: r.touched,
          allowedFiles: formal.allowedFiles,
          assignmentHash: formalQueue.assignmentHash,
        });
      }
      unitOutcomes.set(formal.id, status);
      if (r.ok) delegated += 1;
      units.push({ id: formal.id, role: u.role, task: u.task, action: r.action, status, touched: r.touched, ...(r.model ? { model: r.model } : {}), ...(failureKind ? { failureKind } : {}), error: r.error });
      processedByRole.set(normalizedRole, (processedByRole.get(normalizedRole) || 0) + 1);
    }
  } finally {
    if (runId) reconcileStaleRunningUnits(cwd, runId);
  }
  const summary = { total: entries.length, delegated, units };
  if (runId) {
    // Role shards (--roles) are merged and finalized by the MCP wrapper; only the
    // full-batch shell path writes terminal batch.json here.
    if (opts.roles && opts.roles.length > 0) {
      for (const [role, total] of totalByRole) {
        if ((processedByRole.get(role) || 0) >= total) markOpenCodePlanRoleCompleted(cwd, runId, role);
      }
    } else {
      finalizePlanBatch(cwd, runId, summary);
    }
  }
  return summary;
}

// CLI entry. Either:
//   --from-plan                         delegate every bounded unit in plan.md's queue
//   --role <r> (--task <t>|--task-file <p>)   delegate one explicit unit
// plus --run-id <id> [--model <provider/model>]. Prints a one-line JSON result.
