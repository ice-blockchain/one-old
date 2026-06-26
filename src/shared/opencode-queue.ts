// src/shared/opencode-queue.ts
// Structured queue/status helpers for OpenCode delegation. The runner owns the
// actual model invocation; this module owns stable unit ids, queue policy, and
// per-run status files that let later gates and humans understand what happened.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { opencodeUnitTimeoutMs } from '../config/opencode-timeouts';
import type { PlanDelegationUnit } from './opencode-roles';
import { matchesPattern, normalizeRelPath } from './scope';

const T1_DIR = '.traffic' + '-one';
const UNIT_ID_RE = /^[a-zA-Z0-9._-]+$/;
const UNSAFE_ALLOWED_FILE_PATTERNS = [
  '.traffic-one/**',
  '**/.traffic-one/**',
  'node_modules/**',
  '**/node_modules/**',
  'dist/**',
  '**/dist/**',
  'build/**',
  '**/build/**',
  '.turbo/**',
  '**/.turbo/**',
  '.next/**',
  '**/.next/**',
  '.vite/**',
  '**/.vite/**',
  '.cache/**',
  '**/.cache/**',
  'coverage/**',
  '**/coverage/**',
  'playwright-report/**',
  '**/playwright-report/**',
  'test-results/**',
  '**/test-results/**',
  '**/*.tsbuildinfo',
  '*.tsbuildinfo',
] as const;

export interface OpenCodeQueueUnit {
  id: string;
  role: string;
  kind: string | null;
  allowedFiles: string[];
  task: string;
  dependsOn: string[];
}

export interface OpenCodeQueue {
  version: 1;
  runId: string;
  assignmentHash: string | null;
  queueHash: string;
  units: OpenCodeQueueUnit[];
}

export type OpenCodeUnitStatus =
  | 'queued'
  | 'running'
  | 'delegated'
  | 'failed'
  | 'no_changes'
  | 'skipped_no_units'
  | 'skipped'
  | 'rejected_policy'
  | 'abandoned'
  | 'fallback_required';

export interface OpenCodeUnitStatusEntry {
  id: string;
  role: string;
  status: OpenCodeUnitStatus;
  action?: string;
  model?: string | null;
  failureKind?: string | null;
  error?: string | null;
  touched?: string[];
  allowedFiles?: string[];
  assignmentHash?: string | null;
  fallback?: {
    status: 'paid_spawned';
    role: string;
    agentId?: string | null;
    digest?: string | null;
    recordedAt: string;
  };
  updatedAt: string;
  attempts?: Array<{
    status: OpenCodeUnitStatus;
    action?: string;
    model?: string | null;
    failureKind?: string | null;
    error?: string | null;
    touched?: string[];
    updatedAt: string;
  }>;
}

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
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  } catch {
    // best-effort diagnostics; never block delegation
  }
}

function readStatuses(cwd: string, runId: string): OpenCodeUnitStatusEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runDir(cwd, runId), 'opencode-units.json'), 'utf8')) as unknown;
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
    const parsed = JSON.parse(fs.readFileSync(path.join(runDir(cwd, runId), 'opencode-queue.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as OpenCodeQueue;
    if (rec.version !== 1 || !Array.isArray(rec.units)) return null;
    return rec;
  } catch {
    return null;
  }
}

export function recordOpenCodeUnitStatus(cwd: string, runId: string, entry: Omit<OpenCodeUnitStatusEntry, 'updatedAt'> & { updatedAt?: string }): void {
  if (!runId || !entry.id || !entry.role) return;
  try {
    const file = path.join(runDir(cwd, runId), 'opencode-units.json');
    const statuses = readStatuses(cwd, runId);
    const next: OpenCodeUnitStatusEntry = { ...entry, updatedAt: entry.updatedAt || new Date().toISOString() };
    const idx = statuses.findIndex((s) => s.id === next.id);
    const attempt = {
      status: next.status,
      action: next.action,
      model: next.model ?? null,
      failureKind: next.failureKind ?? null,
      error: next.error ?? null,
      touched: next.touched,
      updatedAt: next.updatedAt,
    };
    if (idx >= 0) {
      const prior = statuses[idx] as OpenCodeUnitStatusEntry;
      const attempts = [...(Array.isArray(prior.attempts) ? prior.attempts : []), attempt];
      const keepPriorSummary = statusPrecedence(prior.status) > statusPrecedence(next.status);
      statuses[idx] = keepPriorSummary
        ? { ...prior, attempts, updatedAt: next.updatedAt }
        : { ...prior, ...next, attempts };
    } else {
      statuses.push({ ...next, attempts: [attempt] });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(statuses, null, 2)}\n`, 'utf8');
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
    const file = path.join(runDir(cwd, runId), 'opencode-units.json');
    const statuses = readStatuses(cwd, runId);
    if (statuses.length === 0) return;
    const normalizedRole = normalizeOpenCodeRole(role);
    const recordedAt = new Date().toISOString();
    let changed = false;
    const next = statuses.map((status) => {
      if (status.role !== normalizedRole || status.status === 'delegated') return status;
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
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
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

function literalStem(pattern: string): string {
  const idx = pattern.search(/[*?[\]{}()!+@]/);
  const stem = idx >= 0 ? pattern.slice(0, idx) : pattern;
  return stem.replace(/\/+$/, '');
}

function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const aStem = literalStem(a);
  const bStem = literalStem(b);
  if (aStem && bStem && (aStem.startsWith(`${bStem}/`) || bStem.startsWith(`${aStem}/`))) return true;
  return matchesPattern(aStem || a, b) || matchesPattern(bStem || b, a);
}

function unitsOverlap(a: OpenCodeQueueUnit, b: OpenCodeQueueUnit): boolean {
  for (const ap of a.allowedFiles) {
    for (const bp of b.allowedFiles) {
      if (patternsOverlap(ap, bp)) return true;
    }
  }
  return false;
}

function mentionsTestWork(task: string): boolean {
  return /\b(unit[- ]?test(?:able|s)?|testable|testability|tests?|testing|vitest|playwright|specs?)\b/i.test(task);
}

function mentionsInlineDependencyField(task: string): boolean {
  return /(^|\s)(depends|depends_on|dependson):/i.test(task);
}

function stripNegatedDependencyPhrases(task: string): string {
  return task
    .replace(/\b(?:no|without)\s+(?:external\s+)?(?:dependency|dependencies|deps?)\b/gi, '')
    .replace(/\b(?:no|without)\s+(?:dependency|dependencies|deps?)\/version\s+(?:changes?|updates?|work|edits?)\b/gi, '')
    .replace(/\b(?:no|without)\s+(?:dependency|dependencies|deps?|package[- ]manager|lockfiles?)\s+(?:changes?|updates?|work|edits?|writes?)\b/gi, '');
}

function mentionsDependencyWork(unit: OpenCodeQueueUnit): boolean {
  const kind = unit.kind || '';
  const task = stripNegatedDependencyPhrases(unit.task || '');
  if (/\b(deps?|dependencies|package[- ]?manager|lockfiles?)\b/i.test(kind)) return true;
  if (unit.allowedFiles.some((allowed) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/i.test(allowed))) return true;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|dedupe|import|ci)\b/i.test(task)) return true;
  if (/\b(?:install|add|remove|upgrade|update|bump)\s+(?:a\s+|the\s+)?(?:dependency|dependencies|deps?|packages?)\b/i.test(task)) return true;
  if (/\b(?:write|modify|touch|regenerate|refresh|update|change)\s+(?:a\s+|the\s+)?(?:package[- ]manager\s+files?|lockfiles?)\b/i.test(task)) return true;
  if (/\b(?:package[- ]manager\s+files?|lockfiles?)\s+(?:changes?|updates?|writes?|edits?|work)\b/i.test(task)) return true;
  if (unit.allowedFiles.some((allowed) => /(^|\/)package\.json$/i.test(allowed))) {
    if (/\b(?:install|upgrade)\b/i.test(task)) return true;
    if (/\b(?:add|remove)\s+(?!(?:a\s+|the\s+|an\s+)?(?:scripts?|metadata|config|field|build|exports?|engines?|workspaces?)\b)\S+/i.test(task)) return true;
  }
  return false;
}

function allowsTestOrConfigPath(allowedFiles: string[]): boolean {
  return allowedFiles.some((allowed) => (
    /(^|\/)(tests?|e2e)\//i.test(allowed)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(allowed)
    || /(^|\/)(vitest|playwright|jest)\.config\.[cm]?[jt]s$/i.test(allowed)
  ));
}

export function openCodeQueuePolicyViolations(units: PlanDelegationUnit[]): string[] {
  return openCodeQueuePolicyReport(units).violations;
}

export interface OpenCodeQueuePolicyReport {
  violations: string[];
  byUnitId: Map<string, string[]>;
}

export function openCodeQueuePolicyReport(units: PlanDelegationUnit[]): OpenCodeQueuePolicyReport {
  const queue = buildOpenCodeQueue('', '', units);
  const violations: string[] = [];
  const byUnitId = new Map<string, string[]>();
  const idToIndex = new Map<string, number>();
  const add = (message: string, ...ids: Array<string | null | undefined>): void => {
    violations.push(message);
    for (const id of ids) {
      if (!id) continue;
      const existing = byUnitId.get(id) || [];
      existing.push(message);
      byUnitId.set(id, existing);
    }
  };

  for (let i = 0; i < queue.units.length; i++) {
    const unit = queue.units[i] as OpenCodeQueueUnit;
    const original = units[i] as PlanDelegationUnit | undefined;
    if (!original?.id || !UNIT_ID_RE.test(original.id)) {
      add(`OpenCode unit at position ${i + 1} needs a stable unique \`id\``, unit.id);
    }
    if (idToIndex.has(unit.id)) {
      add(`OpenCode unit id \`${unit.id}\` is duplicated; every queued unit needs a stable unique id`, unit.id);
    } else {
      idToIndex.set(unit.id, i);
    }
    if (unit.allowedFiles.length === 0) {
      add(`OpenCode unit \`${unit.id}\` has no parseable files allowlist`, unit.id);
    }
    if (mentionsDependencyWork(unit)) {
      add(`OpenCode unit \`${unit.id}\` appears to require dependency/package-manager work; route it to a paid subagent instead of OpenCode`, unit.id);
    }
    if (mentionsInlineDependencyField(unit.task)) {
      add(`OpenCode unit \`${unit.id}\` puts a dependency marker inside task text; add it as a pipe-delimited \`depends:\` field instead`, unit.id);
    }
    if (mentionsTestWork(unit.task) && !allowsTestOrConfigPath(unit.allowedFiles)) {
      add(`OpenCode unit \`${unit.id}\` mentions tests/testability but its files allowlist does not include exact test/spec/config paths; either add those paths explicitly or remove the test acceptance criteria`, unit.id);
    }
    for (const allowed of unit.allowedFiles) {
      if (/[{}]/.test(allowed)) {
        add(`OpenCode unit \`${unit.id}\` uses ambiguous brace/glob syntax in files allowlist \`${allowed}\`; list explicit paths/areas instead`, unit.id);
      }
      if (allowed === '*' || allowed === '**' || allowed === '**/*') {
        add(`OpenCode unit \`${unit.id}\` uses an overbroad files allowlist \`${allowed}\`; list explicit source paths/areas instead`, unit.id);
      }
      if (UNSAFE_ALLOWED_FILE_PATTERNS.some((pattern) => matchesPattern(allowed, pattern) || matchesPattern(literalStem(allowed) || allowed, pattern))) {
        add(`OpenCode unit \`${unit.id}\` allowlist includes generated/internal path \`${allowed}\``, unit.id);
      }
    }
  }

  for (let i = 0; i < queue.units.length; i++) {
    const unit = queue.units[i] as OpenCodeQueueUnit;
    for (const dep of unit.dependsOn) {
      const depIndex = idToIndex.get(dep);
      if (depIndex === undefined) {
        add(`OpenCode unit \`${unit.id}\` depends on unknown unit \`${dep}\``, unit.id);
      } else if (depIndex >= i) {
        add(`OpenCode unit \`${unit.id}\` depends on \`${dep}\`, but dependencies must appear earlier in the queue`, unit.id);
      }
    }
  }

  for (let i = 0; i < queue.units.length; i++) {
    for (let j = i + 1; j < queue.units.length; j++) {
      const a = queue.units[i] as OpenCodeQueueUnit;
      const b = queue.units[j] as OpenCodeQueueUnit;
      if (!unitsOverlap(a, b)) continue;
      const ordered = b.dependsOn.includes(a.id) || a.dependsOn.includes(b.id);
      if (!ordered) {
        add(`OpenCode units \`${a.id}\` and \`${b.id}\` have overlapping files/areas; add an explicit \`depends:\` edge or split the files`, a.id, b.id);
      }
    }
  }

  return { violations, byUnitId };
}

export function statusFromDelegateAction(action: string, error?: string | null): OpenCodeUnitStatus {
  if (action === 'delegated') return 'delegated';
  if (action === 'no-changes') return 'no_changes';
  if (action === 'skipped-no-units') return 'skipped_no_units';
  if (action === 'skipped') return 'skipped';
  if (action === 'abandoned') return 'abandoned';
  if (/outside .*allowlist|outside .*assignment scope|generated\/internal artifact|assignment scope changed/i.test(error || '')) {
    return 'rejected_policy';
  }
  return 'failed';
}
