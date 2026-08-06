// src/shared/opencode-roles-plan-units.ts
// Role gating and plan-text parsing for OpenCode delegation: which roles
// delegate, the machine-readable plan block, and per-run queue roles.

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_OPENCODE_DELEGATE_ROLES } from '../../config/opencode-delegation';
import { detectHost } from '../host';
import { hostFlags } from '../host/capability-flags';
import { canonicalHost } from '../model-tiers';
import { obj } from '../obj';

export type Rec = Record<string, unknown>;
export const OPENCODE_PLAN_MIN_UNITS = 3;

export type OpenCodePlanBatchOutcome = 'running' | 'success' | 'failed' | 'partial' | 'abandoned';

export interface OpenCodePlanBatchState {
  version: 1;
  outcome: OpenCodePlanBatchOutcome;
  startedAt: string;
  finishedAt?: string;
  rolesCompleted: string[];
  error?: string | null;
  /** Hash of runs/<runId>/assignments.json the batch ran against. A replan
   * republishes assignments, so a terminal batch bound to the OLD hash is
   * superseded — Step-0 must run again on the fresh queue (observed 4cu: the
   * once-per-run batch kept returning the pre-replan rejection). */
  assignmentHash?: string | null;
}

export const TERMINAL_BATCH_OUTCOMES = new Set<OpenCodePlanBatchOutcome>(['success', 'failed', 'partial', 'abandoned']);

export { type PlanDelegationUnit } from '../opencode-plan/unit-types';
import { type PlanDelegationUnit } from '../opencode-plan/unit-types';

// The configured roles, sanitized. Falls back to the default array when unset or
// malformed, so a typo can't silently disable delegation.
export function openCodeDelegateRoles(state: unknown): string[] {
  const oc = obj(obj(state)?.openCode);
  const raw = oc?.delegateRoles;
  if (Array.isArray(raw)) {
    const cleaned = raw.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim());
    return cleaned.length > 0 ? cleaned : [];
  }
  return [...DEFAULT_OPENCODE_DELEGATE_ROLES];
}

// Is OpenCode delegation enabled at all? (CLI presence is checked by the runner,
// which falls back gracefully; eligibility for the gate is just the opt-in.)
export function openCodeEnabled(state: unknown): boolean {
  return obj(obj(state)?.openCode)?.enabled === true;
}

/** Opt-in (default OFF): let paid implementers SPAWN while the Step-0 batch is
 *  still running — write-time file reservations become the only serializer.
 *  Flip only after an e2e validates the reservations live. */
export function openCodeParallelImplementers(state: unknown): boolean {
  return obj(obj(state)?.openCode)?.parallelImplementers === true;
}

// Should this role run on OpenCode rather than a paid subagent? Delegation is a
// paid-host feature: paid hosts may offload to OpenCode, but OpenCode/Kilo hosts
// must not self-delegate or spawn the worker recursively.
export function shouldRunRoleOnOpenCode(role: string, state: unknown, host: unknown = detectHost()): boolean {
  const h = canonicalHost(host);
  if (hostFlags(h).opencodeSelfHosted) return false;
  if (!role || !openCodeEnabled(state)) return false;
  return openCodeDelegateRoles(state).includes(role);
}

// The distinct roles the architect QUEUED bounded OpenCode units for in plan.md's
// `opencode-delegate` block — normalized (senior- stripped, deduped, first-seen
// order), empty on any read/parse problem. Single source shared by the from-plan
// runner (which delegates these) and the spawn gate (roleHasQueuedUnits below).
export function parsePlanDelegationUnits(plan: string): PlanDelegationUnit[] {
  const start = plan.indexOf('opencode-delegate:start');
  const end = plan.indexOf('opencode-delegate:end');
  if (start < 0 || end < 0 || end < start) return [];
  const units: PlanDelegationUnit[] = [];
  for (const line of plan.slice(start, end).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const fields: Record<string, string> = {};
    for (const part of trimmed.slice(2).split('|')) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim().toLowerCase();
      const value = part.slice(idx + 1).trim();
      if (key) fields[key] = value;
    }
    const roleRaw = fields.role || '';
    const role = /^[a-z][a-z-]*$/i.test(roleRaw) ? normalizeAttemptRole(roleRaw.toLowerCase()) : '';
    if (!role || !fields.files || !fields.task) continue;
    const id = /^[a-zA-Z0-9._-]+$/.test(fields.id || '') ? fields.id : '';
    const kind = /^[a-zA-Z0-9._-]+$/.test(fields.kind || '') ? fields.kind : '';
    const dependsRaw = fields.depends || fields.dependson || fields.depends_on || '';
    const dependsOn = dependsRaw
      .split(/[, ]+/)
      .map((v) => v.trim())
      .filter((v) => /^[a-zA-Z0-9._-]+$/.test(v));
    units.push({
      ...(id ? { id } : {}),
      role,
      files: fields.files,
      task: fields.task,
      ...(kind ? { kind } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
    });
  }
  return units;
}

export function parsePlanDelegationBlock(plan: string): { roles: string[]; unitCount: number } {
  const units = parsePlanDelegationUnits(plan);
  const roles: string[] = [];
  for (const unit of units) {
    const role = unit.role;
    if (role && !roles.includes(role)) roles.push(role);
  }
  return { roles, unitCount: units.length };
}

export function planDelegationQueueRoles(cwd: string): string[] {
  let plan = '';
  try { plan = fs.readFileSync(path.join(cwd, '.traffic-one', 'plan.md'), 'utf8'); } catch { return []; }
  return parsePlanDelegationBlock(plan).roles;
}

function runScopedQueueRoles(cwd: string, runId: string): string[] | null {
  if (!runId) return null;
  const trafficDir = '.traffic' + '-one';
  const file = path.join(cwd, trafficDir, 'runs', runId, 'opencode-queue.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Rec;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.units)) return [];
    if (typeof parsed.runId === 'string' && parsed.runId && parsed.runId !== runId) return [];
    const roles: string[] = [];
    for (const unit of parsed.units) {
      const rec = obj(unit);
      const role = typeof rec?.role === 'string' ? normalizeAttemptRole(rec.role) : '';
      if (role && !roles.includes(role)) roles.push(role);
    }
    return roles;
  } catch {
    return [];
  }
}

export function planDelegationQueueRolesForRun(cwd: string, runId: string): string[] {
  const scoped = runScopedQueueRoles(cwd, runId);
  return scoped ?? planDelegationQueueRoles(cwd);
}

/** Count bounded OpenCode units in a plan body (for plan-write gates). */
export function planDelegationUnitCount(planText: string): number {
  return parsePlanDelegationBlock(planText).unitCount;
}

// True when the architect queued at least one bounded OpenCode unit for `role`. The
// spawn gate uses this to AVOID trapping a forced-delegate role with NOTHING queued:
// from-plan can't deliver work that was never queued, so denying its paid spawn would
// stall the role forever. Roles WITH queued units stay gated (deny until from-plan
// delivers → marks attempted → the gate clears and the paid implementer proceeds).
export function roleHasQueuedUnits(cwd: string, role: string, runId = ''): boolean {
  if (!role) return false;
  const roles = runId ? planDelegationQueueRolesForRun(cwd, runId) : planDelegationQueueRoles(cwd);
  return roles.includes(normalizeAttemptRole(role));
}


export function normalizeAttemptRole(role: string): string {
  const stripped = /^senior-(.+)$/.exec(role);
  const base = stripped && stripped[1] ? stripped[1] : role;
  return base.replace(/[^a-zA-Z0-9_-]/g, '_');
}
