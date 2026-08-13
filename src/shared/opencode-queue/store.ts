// src/shared/opencode-queue-store.ts
// Queue build/read/write plus the per-unit status ledger: terminal-write
// folding, fallback records, stale-running reconciliation, and dependency
// blocking.

import * as crypto from 'crypto';
import * as path from 'path';
import { opencodeUnitTimeoutMs, unitLivenessWindowMs } from '../../config/opencode-timeouts';
import { writeJson } from '../fsjson';
// Direct file import (not the opencode-roles barrel — that package imports
// this one): pid-verified apply latch for the liveness checks below.
import { openCodeApplyInProgress } from '../opencode-roles/apply-latch';
import type { PlanDelegationUnit } from '../opencode-plan/unit-types';
import {   normalizeRelPath } from '../scope';
import { withProjectStateLock } from '../state/project-state-lock';

import {
  OPENCODE_UNIT_ATTEMPT_CAP,
  OPENCODE_UNIT_ATTEMPT_ERROR_MAX,
  T1_DIR,
  UNIT_ID_RE,
  type OpenCodeQueue,
  type OpenCodeQueueUnit,
  type OpenCodeUnitStatus,
  type OpenCodeUnitStatusEntry,
} from './types';
import { readRegularFileOrThrow } from '../bounded-read';

function safePathSegment(value: string): string {
  return (value || 'run').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'run';
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, T1_DIR, 'runs', safePathSegment(runId));
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeOpenCodeRole(role: string): string {
  const m = /^senior-(.+)$/.exec(role.trim().toLowerCase());
  return m && m[1] ? m[1] : role.trim().toLowerCase();
}

export function parseAllowedFiles(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,;\n]+/)) {
    const rel = normalizeRelPath(raw.trim().replace(/^`+|`+$/g, ''));
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

export function opencodeAssignmentHash(cwd: string, runId: string): string | null {
  try {
    const file = path.join(runDir(cwd, runId), 'assignments.json');
    const parsed = JSON.parse(readRegularFileOrThrow(file)) as unknown;
    return sha256(stableJson(parsed));
  } catch {
    return null;
  }
}

function unitIdFrom(unit: PlanDelegationUnit, index: number): string {
  if (unit.id && UNIT_ID_RE.test(unit.id)) return unit.id;
  const role = normalizeOpenCodeRole(unit.role) || 'unit';
  const seed = stableJson({ role, files: unit.files, task: unit.task, index });
  return `${role}-${index + 1}-${sha256(seed).slice(0, 10)}`;
}

function toQueueUnit(unit: PlanDelegationUnit, index: number): OpenCodeQueueUnit {
  return {
    id: unitIdFrom(unit, index),
    role: normalizeOpenCodeRole(unit.role),
    kind: unit.kind || null,
    allowedFiles: parseAllowedFiles(unit.files),
    task: unit.task,
    dependsOn: [...(unit.dependsOn || [])],
  };
}

export function buildOpenCodeQueue(cwd: string, runId: string, units: PlanDelegationUnit[]): OpenCodeQueue {
  const queueUnits = units.map(toQueueUnit);
  const assignmentHash = runId ? opencodeAssignmentHash(cwd, runId) : null;
  const hashInput = queueUnits.map((u) => ({
    id: u.id,
    role: u.role,
    kind: u.kind,
    allowedFiles: u.allowedFiles,
    task: u.task,
    dependsOn: u.dependsOn,
  }));
  return {
    version: 1,
    runId,
    assignmentHash,
    queueHash: sha256(stableJson(hashInput)),
    units: queueUnits,
  };
}

export function writeOpenCodeQueue(cwd: string, queue: OpenCodeQueue): void {
  if (!queue.runId) return;
  try {
    const file = path.join(runDir(cwd, queue.runId), 'opencode-queue.json');
    writeJson(file, queue);
  } catch {
    // best-effort diagnostics; never block delegation
  }
}

function readStatuses(cwd: string, runId: string): OpenCodeUnitStatusEntry[] {
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(path.join(runDir(cwd, runId), 'opencode-units.json'))) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is OpenCodeUnitStatusEntry => Boolean(v && typeof v === 'object')) : [];
  } catch {
    return [];
  }
}

export function readOpenCodeUnitStatuses(cwd: string, runId: string): OpenCodeUnitStatusEntry[] {
  return readStatuses(cwd, runId);
}

export function readOpenCodeQueue(cwd: string, runId: string): OpenCodeQueue | null {
  if (!runId) return null;
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(path.join(runDir(cwd, runId), 'opencode-queue.json'))) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as OpenCodeQueue;
    if (rec.version !== 1 || !Array.isArray(rec.units)) return null;
    return rec;
  } catch {
    return null;
  }
}

// Refresh `updatedAt` on RUNNING units without touching anything else —
// notably WITHOUT appending an attempt row (the fold in recordOpenCodeUnitStatus
// deliberately excludes `running`, so a repeated status write would push a new
// row per tick and evict real retry history against the attempt cap). The MCP
// watchdog calls this each tick and the runner between model attempts; a
// once-written `updatedAt` is what batch liveness, the reservations, and the
// stale-running reconciler read.
//
// Role-SCOPED when a role is given: a delegation may only vouch for its OWN
// units. An unscoped touch let a live single-role delegation refresh rows a
// dead batch left `running` for OTHER roles, resurrecting the exact
// forever-wedge the liveness fix cures (adversarial review).
export function touchOpenCodeUnitRunning(cwd: string, runId: string, role?: string): void {
  if (!runId) return;
  try {
    const normalizedRole = role ? normalizeOpenCodeRole(role) : null;
    withProjectStateLock(cwd, () => {
      const file = path.join(runDir(cwd, runId), 'opencode-units.json');
      const statuses = readStatuses(cwd, runId);
      let touched = false;
      const now = new Date().toISOString();
      for (const entry of statuses) {
        if (entry.status !== 'running') continue;
        if (normalizedRole && entry.role !== normalizedRole) continue;
        entry.updatedAt = now;
        touched = true;
      }
      if (touched) writeJson(file, statuses);
    });
  } catch {
    // best-effort; a missed touch only narrows the liveness window
  }
}

export function recordOpenCodeUnitStatus(cwd: string, runId: string, entry: Omit<OpenCodeUnitStatusEntry, 'updatedAt'> & { updatedAt?: string }): void {
  if (!runId || !entry.id || !entry.role) return;
  try {
    withProjectStateLock(cwd, () => {
      const file = path.join(runDir(cwd, runId), 'opencode-units.json');
      const statuses = readStatuses(cwd, runId);
      const next: OpenCodeUnitStatusEntry = { ...entry, updatedAt: entry.updatedAt || new Date().toISOString() };
      const idx = statuses.findIndex((s) => s.id === next.id);
      const priorEntry = idx >= 0 ? statuses[idx] as OpenCodeUnitStatusEntry : null;
      const priorAttempts = Array.isArray(priorEntry?.attempts) ? priorEntry.attempts : [];
      const nextError = next.error ?? null;
      const truncatedError = nextError && nextError.length > OPENCODE_UNIT_ATTEMPT_ERROR_MAX
        ? `${nextError.slice(0, OPENCODE_UNIT_ATTEMPT_ERROR_MAX)}…`
        : nextError;
      // Dedupe against the entry-level error (kept in full) and the last
      // materialized attempt error, so an identical error repeated across N
      // retries is stored once, not N times — even after the materialized copy
      // ages out of the capped history.
      const lastMaterializedError = [...priorAttempts].reverse()
        .find((prior) => prior.error && prior.error !== '(unchanged)')?.error ?? null;
      const repeatedError = Boolean(nextError && (
        nextError === (priorEntry?.error ?? null)
        || truncatedError === lastMaterializedError
      ));
      const attempt = {
        status: next.status,
        action: next.action,
        model: next.model ?? null,
        failureKind: next.failureKind ?? null,
        error: repeatedError ? '(unchanged)' : truncatedError,
        updatedAt: next.updatedAt,
      };
      if (priorEntry) {
        // A unit reaches a terminal status ONCE. Two layers report it — the
        // delegate call itself and the batch that owns the unit — and batch
        // finalization can reconcile it a third time, so 6co recorded four
        // attempts for every one of its six successful units: `running`, the
        // same `delegated` twice 1-2 ms apart, then a `delegated` with
        // `model: null`. Against the 8-attempt cap that evicts the real retry
        // history of any unit that genuinely retried, and the last writer
        // erased the model. Fold a repeat of the SAME terminal transition into
        // the attempt already recorded, keeping whichever metadata is known.
        const previous = priorAttempts[priorAttempts.length - 1];
        const repeatsTerminal = Boolean(
          previous
          && previous.status === attempt.status
          && attempt.status !== 'queued'
          && attempt.status !== 'running'
          && (previous.action ?? null) === (attempt.action ?? null),
        );
        const attempts = repeatsTerminal
          ? [
              ...priorAttempts.slice(0, -1),
              {
                ...previous,
                ...attempt,
                model: attempt.model ?? previous!.model ?? null,
                failureKind: attempt.failureKind ?? previous!.failureKind ?? null,
                error: attempt.error ?? previous!.error ?? null,
                updatedAt: previous!.updatedAt,
              },
            ]
          : [...priorAttempts, attempt].slice(-OPENCODE_UNIT_ATTEMPT_CAP);
        const keepPriorSummary = statusPrecedence(priorEntry.status) > statusPrecedence(next.status);
        const merged = keepPriorSummary
          ? { ...priorEntry, attempts, updatedAt: next.updatedAt }
          : { ...priorEntry, ...next, attempts };
        statuses[idx] = repeatsTerminal
          // The reconciliation pass carries no model/timing; never let it blank
          // what the delegate already observed.
          ? { ...merged, model: next.model ?? priorEntry.model ?? null }
          : merged;
      } else {
        statuses.push({ ...next, attempts: [attempt] });
      }
      writeJson(file, statuses);
    });
  } catch {
    // best-effort diagnostics; never block delegation
  }
}

export function recordOpenCodeFallback(
  cwd: string,
  runId: string,
  role: string,
  fallback: { status: 'paid_spawned'; agentId?: string | null; digest?: string | null },
): void {
  if (!runId || !role) return;
  try {
    withProjectStateLock(cwd, () => {
      const file = path.join(runDir(cwd, runId), 'opencode-units.json');
      const statuses = readStatuses(cwd, runId);
      if (statuses.length === 0) return;
      const normalizedRole = normalizeOpenCodeRole(role);
      const recordedAt = new Date().toISOString();
      const nowMs = Date.now();
      const livenessMs = unitLivenessWindowMs();
      const latchLive = openCodeApplyInProgress(cwd, runId, nowMs);
      let changed = false;
      const next = statuses.map((status) => {
        if (status.role !== normalizedRole || status.status === 'delegated') return status;
        // A VERIFIABLY EXECUTING unit is not a fallback candidate: flipping a
        // live `running` row to fallback_required destroyed its file
        // reservation the instant a parallel-mode paid spawn went through —
        // the exact collision the reservation exists to prevent (adversarial
        // review). A dead `running` row (stale updatedAt, no latch) still
        // flips exactly as before.
        if (status.status === 'running') {
          const at = Date.parse(status.updatedAt || '');
          if (latchLive || (Number.isFinite(at) && nowMs - at < livenessMs)) return status;
        }
        changed = true;
        const nextStatus = statusPrecedence(status.status) < statusPrecedence('fallback_required')
          ? 'fallback_required'
          : status.status;
        return {
          ...status,
          status: nextStatus,
          fallback: {
            status: fallback.status,
            role,
            agentId: fallback.agentId ?? status.fallback?.agentId ?? null,
            digest: fallback.digest ?? status.fallback?.digest ?? null,
            recordedAt,
          },
          updatedAt: recordedAt,
        } satisfies OpenCodeUnitStatusEntry;
      });
      if (!changed) return;
      writeJson(file, next);
    });
  } catch {
    // best-effort diagnostics; never block fallback
  }
}

function statusPrecedence(status: OpenCodeUnitStatus): number {
  switch (status) {
    case 'delegated': return 50;
    case 'no_changes': return 40;
    case 'fallback_required': return 35;
    case 'rejected_policy': return 30;
    case 'failed':
    case 'abandoned': return 25;
    case 'skipped':
    case 'skipped_no_units': return 20;
    case 'running': return 10;
    case 'queued': return 0;
    default: return 0;
  }
}

export function reconcileStaleRunningUnits(
  cwd: string,
  runId: string,
  staleAfterMs: number = opencodeUnitTimeoutMs(),
): OpenCodeUnitStatusEntry[] {
  if (!runId) return [];
  const now = Date.now();
  const reconciled: OpenCodeUnitStatusEntry[] = [];
  for (const entry of readStatuses(cwd, runId)) {
    if (entry.status !== 'running') continue;
    const updated = Date.parse(entry.updatedAt);
    if (!Number.isFinite(updated) || now - updated < staleAfterMs) continue;
    const next: OpenCodeUnitStatusEntry = {
      ...entry,
      status: 'failed',
      action: 'failed',
      error: `OpenCode unit timed out after ${Math.round(staleAfterMs / 60_000)}+ minutes (stale running status reconciled)`,
      updatedAt: new Date().toISOString(),
    };
    recordOpenCodeUnitStatus(cwd, runId, next);
    reconciled.push(next);
  }
  return reconciled;
}

export function reconcileAllRunningUnits(
  cwd: string,
  runId: string,
  reason: string,
): OpenCodeUnitStatusEntry[] {
  if (!runId) return [];
  const reconciled: OpenCodeUnitStatusEntry[] = [];
  for (const entry of readStatuses(cwd, runId)) {
    if (entry.status !== 'running') continue;
    const next: OpenCodeUnitStatusEntry = {
      ...entry,
      status: 'failed',
      action: 'failed',
      error: reason,
      updatedAt: new Date().toISOString(),
    };
    recordOpenCodeUnitStatus(cwd, runId, next);
    reconciled.push(next);
  }
  return reconciled;
}

export function finalizeOpenCodeUnitsForBatch(cwd: string, runId: string, reason: string): void {
  reconcileStaleRunningUnits(cwd, runId);
  reconcileAllRunningUnits(cwd, runId, reason);
}

export function persistBatchUnitsToStatus(
  cwd: string,
  runId: string,
  units: ReadonlyArray<{ id?: string; role: string; action?: string; status?: string; touched?: string[]; error?: string | null }>,
): void {
  if (!runId) return;
  for (const unit of units) {
    if (!unit.id || !unit.role) continue;
    const action = unit.action || unit.status || 'failed';
    recordOpenCodeUnitStatus(cwd, runId, {
      id: unit.id,
      role: unit.role,
      status: statusFromDelegateAction(action, unit.error),
      action,
      error: unit.error ?? null,
      ...(Array.isArray(unit.touched) ? { touched: unit.touched } : {}),
    });
  }
}

export function hasRunningOpenCodeUnits(cwd: string, runId: string): boolean {
  return readOpenCodeUnitStatuses(cwd, runId).some((s) => s.status === 'running');
}

const DEPENDENCY_BLOCKING_STATUSES = new Set<OpenCodeUnitStatus>(['failed', 'rejected_policy', 'abandoned']);

/**
 * Ids among `dependsOn` that ended in a blocking state. `outcomes` is the merged
 * view of the persisted ledger and this batch's in-flight results, so a dependency
 * that ran in an EARLIER role shard (a different runner process) still counts.
 * Unknown/absent ids never block: ordering-only edges must keep running.
 */
export function blockedByFailedDependencies(
  dependsOn: readonly string[] | undefined,
  outcomes: ReadonlyMap<string, OpenCodeUnitStatus>,
): string[] {
  if (!dependsOn || dependsOn.length === 0) return [];
  return dependsOn.filter((id) => {
    const status = outcomes.get(id);
    return Boolean(status && DEPENDENCY_BLOCKING_STATUSES.has(status));
  });
}

export function statusFromDelegateAction(action: string, error?: string | null): OpenCodeUnitStatus {
  if (action === 'delegated') return 'delegated';
  if (action === 'no-changes') return 'no_changes';
  if (action === 'skipped-no-units') return 'skipped_no_units';
  if (action === 'skipped'
    || action === 'skipped-dependency-failed'
    || action === 'skipped-producer-failed') return 'skipped';
  if (action === 'abandoned') return 'abandoned';
  if (/outside .*allowlist|outside .*assignment scope|generated\/internal artifact|assignment scope changed/i.test(error || '')) {
    return 'rejected_policy';
  }
  return 'failed';
}
