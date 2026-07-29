// src/modules/agent-model/gate-opencode-first.ts
// The OpenCode-first phase of agentModelGate, extracted verbatim: the plan-
// batch gate and the at-most-once per-role delegate deny (no-deadlock
// invariant documented inline). Returns a deny or null to continue.

import * as path from 'path';
import { context, deny } from '../../core/result';
import { recordOpenCodeFallback } from '../../shared/opencode-queue';
import {
  markOpenCodeGateDenied,
  openCodeGateDenied,
  openCodePlanBatchComplete,
  openCodePlanRoleCompleted,
  openCodeRoleAttempted,
  pendingOpenCodePlanRoles,
  roleHasQueuedUnits,
  shouldBlockImplementerForPlanBatch,
  shouldRunRoleOnOpenCode,
} from '../../shared/opencode-roles';
import {
  ensureCurrentRunId,
  ensureRunAgentClaim,
  isMaintenancePhase,
} from '../../shared/state';
import { buildOpenCodePlanBatchDenyContext } from '../../shared/opencode-plan/directive';
import {
  block,
  isPlanBatchGatedRole,
} from './handler-prose';
import type { HookResult } from '../../core/types';
import type { GateContext } from './gate-context';

export function openCodeFirstGates(g: GateContext): HookResult | null {
  const { ctx, cwd, state, role, spawnRunId } = g;
  // New-project Phase 2 invariant: if the architect queued a Step-0
  // `opencode_delegate_from_plan` batch, no implementer may start until that
  // batch has reached a TERMINAL result for every queued role. The older
  // per-role gate below only covers roles configured to run on OpenCode
  // (frontend/tester/quick-fix by default), which let backend start while
  // frontend was blocked. This batch gate catches both implementers first.
  if (isPlanBatchGatedRole(role) && shouldBlockImplementerForPlanBatch(cwd, spawnRunId, state, ctx.host)) {
    const pendingPlanRoles = pendingOpenCodePlanRoles(cwd, spawnRunId, state, ctx.host);
    if (pendingPlanRoles.length > 0) {
      const denyContext = buildOpenCodePlanBatchDenyContext(cwd, spawnRunId, pendingPlanRoles);
      return deny(block('opencode-plan-batch-required', {
        ROLE: role,
        RUN_ID: spawnRunId,
        PROJECT_ROOT: cwd,
        QUEUED_ROLES: pendingPlanRoles.join(', '),
      }), denyContext ? { context: denyContext } : {});
    }
  }

  // OpenCode role delegation (all modes, paid hosts only): a configured role MUST run
  // on OpenCode first when delegation is enabled. Deny its paid spawn until
  // OpenCode has actually reached the CLI for this role in the current run — the
  // runner writes a per-run attempt marker at that point, after which the
  // fallback spawn is allowed. The marker is scoped by currentRunId; mint one
  // when absent so existing-codebase runs (and fresh/interrupted sessions that
  // skipped the orchestrator's Phase 0) still enforce — ensureRunAgentClaim
  // below is reached only on the new-project path. A freshly minted run id has
  // no marker yet, so this denies once (when the role has queued work) before
  // allowing the fallback.
  //
  // NO-DEADLOCK INVARIANT: the gate denies a (runId, role) at most ONCE. If the
  // opencode_delegate tool call can't complete for any reason (tool not yet
  // loaded, transient error), the attempt marker may never be written; without
  // the deny marker the delegate path AND the spawn path would both be blocked
  // forever. After one deny the next spawn attempt goes through as the fallback.
  // …force OpenCode-first only when there is actually work for it: EITHER the
  // architect QUEUED bounded units for this role (build phase — from-plan delivers
  // them → attempt marker → this gate clears) OR we are in MAINTENANCE (no plan queue,
  // but small single-role fixes are delegated ad hoc). A BUILD-phase forced role with
  // NOTHING queued has no batch work, so denying its paid spawn would TRAP it (the
  // batch can never mark it attempted) — let it proceed to the paid implementer.
  if (shouldRunRoleOnOpenCode(role, state, ctx.host)) {
    const runId = ensureCurrentRunId(cwd, state);
    if (runId && (roleHasQueuedUnits(cwd, role, runId) || isMaintenancePhase(state))
      && !openCodeRoleAttempted(cwd, runId, role)
      && !openCodePlanRoleCompleted(cwd, runId, role)
      && !openCodePlanBatchComplete(cwd, runId)
      && !openCodeGateDenied(cwd, runId, role)) {
      markOpenCodeGateDenied(cwd, runId, role);
      return deny(block('opencode-role-delegate', { ROLE: role, RUN_ID: runId, PROJECT_ROOT: cwd }));
    }
  }
  if (shouldRunRoleOnOpenCode(role, state, ctx.host) && spawnRunId
    && (openCodeGateDenied(cwd, spawnRunId, role)
      || openCodeRoleAttempted(cwd, spawnRunId, role)
      || openCodePlanRoleCompleted(cwd, spawnRunId, role)
      || openCodePlanBatchComplete(cwd, spawnRunId))) {
    recordOpenCodeFallback(cwd, spawnRunId, role, { status: 'paid_spawned' });
  }
  return null;
}
