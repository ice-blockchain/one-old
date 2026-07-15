// src/shared/opencode-roles.ts
// Role-based OpenCode delegation: which senior subagent roles run on the free
// OpenCode agent instead of a paid subagent. Single source of truth for reading
// the configurable `openCode.delegateRoles` array + the per-run markers the
// spawn gate uses to enforce plan-batch-first and then allow a fallback spawn
// after OpenCode declines.

import * as fs from 'fs';
import * as path from 'path';

import { DEFAULT_OPENCODE_DELEGATE_ROLES } from '../config/opencode-delegation';
import { opencodeAssignmentHash, readOpenCodeQueue, readOpenCodeUnitStatuses } from './opencode-queue';
import { detectHost } from './host';
import { canonicalHost } from './model-tiers';
import { openCodeDelegationActive } from './performance';
import { obj } from './obj';

type Rec = Record<string, unknown>;
export const OPENCODE_PLAN_MIN_UNITS = 3;

export type OpenCodePlanBatchOutcome = 'running' | 'success' | 'failed' | 'partial' | 'abandoned';

export interface OpenCodePlanBatchState {
  version: 1;
  outcome: OpenCodePlanBatchOutcome;
  startedAt: string;
  finishedAt?: string;
  rolesCompleted: string[];
  error?: string | null;
}

const TERMINAL_BATCH_OUTCOMES = new Set<OpenCodePlanBatchOutcome>(['success', 'failed', 'partial', 'abandoned']);

export interface PlanDelegationUnit {
  id?: string;
  role: string;
  files: string;
  task: string;
  kind?: string;
  dependsOn?: string[];
}

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

// Should this role run on OpenCode rather than a paid subagent? Delegation is a
// paid-host feature: paid hosts may offload to OpenCode, but OpenCode/Kilo hosts
// must not self-delegate or spawn the worker recursively.
export function shouldRunRoleOnOpenCode(role: string, state: unknown, host: unknown = detectHost()): boolean {
  const h = canonicalHost(host);
  if (h === 'opencode' || h === 'kilo') return false;
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

function planBatchDir(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-plan-batch');
}

function planBatchCompletePath(cwd: string, runId: string): string {
  return path.join(planBatchDir(cwd, runId), 'COMPLETE');
}

function planBatchJsonPath(cwd: string, runId: string): string {
  return path.join(planBatchDir(cwd, runId), 'batch.json');
}

function planBatchMarkerPath(cwd: string, runId: string, role: string): string {
  return path.join(planBatchDir(cwd, runId), normalizeAttemptRole(role));
}

function atomicWriteJson(filePath: string, data: unknown): void {
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
    return {
      version: 1,
      outcome,
      startedAt,
      ...(typeof rec.finishedAt === 'string' ? { finishedAt: rec.finishedAt } : {}),
      rolesCompleted,
      ...(rec.error != null ? { error: String(rec.error) } : {}),
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

// The senior-architect writes a run-scoped `runs/<runId>/assignments.json` on
// every architect run (a new-project scaffold OR a complex maintenance build it
// was spawned for). Its presence is our proof that plan.md's `opencode-delegate`
// block is FRESH for THIS run — not the durable block left over from a previous
// build. `opencodeAssignmentHash` reads exactly that file and is null when it is
// absent, so small/triage maintenance runs (which never invoke the architect)
// never look fresh. Requiring it also makes `expectedAssignmentHash` non-null,
// re-activating the runner's stale-diff guard.
export function hasFreshArchitectQueueForRun(cwd: string, runId: string): boolean {
  return Boolean(runId) && opencodeAssignmentHash(cwd, runId) !== null;
}

// Plan-batch delegation applies to new-project builds AND to complex maintenance
// builds that re-entered the architect THIS run. Small maintenance work (triage
// → direct-to-implementer, no fresh architect queue) stays on the per-role
// `opencode_delegate` path and must NOT re-run a stale plan.md queue.
function planBatchPhaseEligible(cwd: string, runId: string, state: unknown): boolean {
  return obj(state)?.mode === 'new-project' || hasFreshArchitectQueueForRun(cwd, runId);
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
export function markOpenCodePlanRoleCompleted(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  const normalized = normalizeAttemptRole(role);
  try {
    const p = planBatchMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${normalized}\n`, 'utf8');
    const existing = readOpenCodePlanBatchState(cwd, runId);
    if (existing && !TERMINAL_BATCH_OUTCOMES.has(existing.outcome)) {
      const rolesCompleted = existing.rolesCompleted.includes(normalized)
        ? existing.rolesCompleted
        : [...existing.rolesCompleted, normalized];
      atomicWriteJson(planBatchJsonPath(cwd, runId), {
        ...existing,
        rolesCompleted,
      } satisfies OpenCodePlanBatchState);
    }
  } catch {
    // best-effort; a missing marker only keeps the fail-closed batch gate active
  }
}

export function openCodePlanRoleCompleted(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    const p = planBatchMarkerPath(cwd, runId, role);
    if (!fs.existsSync(p)) return false;
    const stat = fs.statSync(p);
    return stat.size > 0;
  } catch {
    return false;
  }
}

export function pendingOpenCodePlanRoles(cwd: string, runId: string, state: unknown, host: unknown = detectHost()): string[] {
  if (!runId || !openCodeDelegationActive(state, host)) return [];
  if (!planBatchPhaseEligible(cwd, runId, state)) return [];
  if (openCodePlanBatchComplete(cwd, runId)) return [];
  return planDelegationQueueRolesForRun(cwd, runId);
}

// Per-run marker that an OpenCode delegation reached the CLI for a role. The
// runner intentionally writes this only after setup/preconditions pass; sandbox
// worktree failures and host-policy rejections are not real OpenCode attempts.
// The spawn gate denies a configured role's paid spawn until this exists, then
// allows the fallback spawn once OpenCode has tried.
// Marker names are NORMALIZED (senior- prefix stripped) so the plan batch
// (queue role labels: "frontend") and the spawn gate (role ids:
// "senior-frontend") agree — observed live: the batch marked `frontend`, the
// gate checked `senior-frontend`, missed it, denied the paid spawn, and its
// deny pushed the orchestrator into a whole-role delegation that timed out.
function normalizeAttemptRole(role: string): string {
  const stripped = /^senior-(.+)$/.exec(role);
  const base = stripped && stripped[1] ? stripped[1] : role;
  return base.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function attemptMarkerPath(cwd: string, runId: string, role: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-attempts', normalizeAttemptRole(role));
}

// Legacy (pre-normalization) marker path — read-compat for runs written by
// older builds that used the raw role string.
function legacyAttemptMarkerPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-attempts', safe);
}

export function markOpenCodeRoleAttempted(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try {
    const p = attemptMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only means one extra (harmless) gate nudge
  }
}

export function openCodeRoleAttempted(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    return fs.existsSync(attemptMarkerPath(cwd, runId, role))
      || fs.existsSync(legacyAttemptMarkerPath(cwd, runId, role));
  } catch {
    return false;
  }
}

// Append a JSON line describing how the delegation attempt ended (model, action,
// error, duration). The 0-byte marker alone made failed delegations
// undiagnosable after the fact (observed live: an empty
// `opencode-attempts/senior-frontend` while the role silently fell back to a
// paid worker). Diagnostics land in a `.log` SIDECAR next to the marker — the
// marker file itself stays an existence-only flag written exclusively by
// markOpenCodeRoleAttempted (the spawn gate must not see pre-CLI environment
// failures as real attempts).
export function recordOpenCodeAttemptOutcome(
  cwd: string,
  runId: string,
  role: string,
  outcome: { action: string; model?: string | null; failureKind?: string | null; error?: string | null; durationMs?: number; touched?: number },
): void {
  if (!runId || !role) return;
  try {
    const p = `${attemptMarkerPath(cwd, runId, role)}.log`;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      action: outcome.action,
      model: outcome.model ?? null,
      failureKind: outcome.failureKind ?? null,
      error: outcome.error ? String(outcome.error).slice(0, 500) : null,
      durationMs: typeof outcome.durationMs === 'number' ? Math.round(outcome.durationMs) : undefined,
      touched: typeof outcome.touched === 'number' ? outcome.touched : undefined,
    });
    fs.appendFileSync(p, `${line}\n`, 'utf8');
  } catch {
    // best-effort diagnostics; never block the delegation result
  }
}

// Per-run marker that the GATE has already denied a paid spawn of this role
// once. The deny → delegate → re-spawn loop assumes the delegate tool CAN run;
// on Codex the host's safety reviewer can reject the opencode_delegate call
// ABOVE our code, so the runner's attempt marker is never written and a
// marker-only gate would deadlock (delegate blocked by the reviewer, spawn
// blocked by the gate). Host rejection is not an OpenCode attempt; it is a
// policy fallback. The gate therefore denies a (runId, role) at most ONCE: it
// records the denial here and lets the second spawn attempt through.
function denyMarkerPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-gate-denies', safe);
}

export function markOpenCodeGateDenied(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try {
    const p = denyMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only risks one extra deny, never a deadlock
  }
}

export function openCodeGateDenied(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    return fs.existsSync(denyMarkerPath(cwd, runId, role));
  } catch {
    return false;
  }
}
