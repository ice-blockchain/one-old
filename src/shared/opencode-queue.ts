// src/shared/opencode-queue.ts
// Structured queue/status helpers for OpenCode delegation. The runner owns the
// actual model invocation; this module owns stable unit ids, queue policy, and
// per-run status files that let later gates and humans understand what happened.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { opencodeUnitTimeoutMs } from '../config/opencode-timeouts';
import { writeJson } from './fsjson';
import type { PlanDelegationUnit } from './opencode-roles';
import { matchesPattern, matchesScope, normalizeRelPath, type AssignedScope } from './scope';
import { withProjectStateLock } from './state/project-state-lock';

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
    writeJson(file, queue);
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
    withProjectStateLock(cwd, () => {
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

function literalStem(pattern: string): string {
  const idx = pattern.search(/[*?[\]{}()!+@]/);
  const stem = idx >= 0 ? pattern.slice(0, idx) : pattern;
  return stem.replace(/\/+$/, '');
}

/**
 * Allowlist entries the delegated-diff validator can never accept: generated
 * output and `.traffic-one/**`. The plan-queue validator has always rejected
 * these up front; the ad-hoc `opencode_delegate` path did not, so the same
 * entry was only discovered AFTER the model finished — the whole diff is then
 * discarded (observed 1cu-cursor: `.traffic-one/digests/<run>/backend.md` in
 * the allowlist burned four delegations and produced zero files).
 */
export function unsafeAllowedFilePatterns(allowedFiles: readonly string[]): string[] {
  return allowedFiles.filter((allowed) => UNSAFE_ALLOWED_FILE_PATTERNS.some(
    (pattern) => matchesPattern(allowed, pattern) || matchesPattern(literalStem(allowed) || allowed, pattern),
  ));
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
    .replace(/\b(?:no|without)\s+(?:dependency|dependencies|deps?|package[- ]manager|lockfiles?)\s+(?:changes?|updates?|work|edits?|writes?)\b/gi, '')
    // Verb-phrase negations: "do not add packages", "don't install anything",
    // "never bump dependencies", "avoid touching package.json". The clause is
    // stripped up to the next sentence/clause boundary so an affirmative
    // instruction later in the task ("… then run pnpm install X") survives.
    // Over-stripping only relaxes THIS unsafe-unit heuristic (8c: a negated
    // draft phrase still routed a pure-helpers unit off OpenCode).
    .replace(/\b(?:do\s+not|don'?t|never|avoid|without|not\s+to)\s+(?:add(?:ing)?|install(?:ing)?|remov(?:e|ing)|upgrad(?:e|ing)|updat(?:e|ing)|bump(?:ing)?|touch(?:ing)?|modify(?:ing)?|chang(?:e|ing)|edit(?:ing)?)\s+[^.;,\n]*/gi, '')
    // Reversed noun negations: "no changes to package.json", "without edits to
    // lockfiles" — the earlier patterns only cover "<neg> <noun> <change-word>".
    .replace(/\b(?:no|without|zero)\s+(?:changes?|updates?|edits?|writes?|modifications?)\s+to\s+[^.;,\n]*/gi, '');
}

function isDocumentationPath(p: string): boolean {
  const stem = literalStem(p) || p;
  return /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(stem)
    || /(^|\/)(readme|changelog|contributing|authors|notice|license)(\.[^/]*)?$/i.test(stem)
    || /(^|\/)docs?(\/|$)/i.test(stem);
}

// A docs-only unit (README/CHANGELOG/docs/**) cannot perform dependency work —
// its file allowlist is enforced downstream. Describing `npm install` steps in
// prose is documentation, not package-manager work (the readme-draft unit was
// falsely routed off OpenCode for documenting install commands).
function isDocsOnlyUnit(unit: OpenCodeQueueUnit): boolean {
  return unit.allowedFiles.length > 0 && unit.allowedFiles.every(isDocumentationPath);
}

function mentionsDependencyWork(unit: OpenCodeQueueUnit): boolean {
  if (isDocsOnlyUnit(unit)) return false;
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

export function openCodeQueuePolicyViolations(
  units: PlanDelegationUnit[],
  options: OpenCodeQueuePolicyOptions = {},
): string[] {
  return openCodeQueuePolicyReport(units, options).violations;
}

export interface OpenCodeQueuePolicyReport {
  violations: string[];
  byUnitId: Map<string, string[]>;
}

export interface OpenCodeQueuePolicyOptions {
  /**
   * Per-role write assignments for the run (`runs/<runId>/assignments.json`).
   * Omitted → the scope cross-check is skipped (the plan can be authored before
   * the manifest exists); the runtime diff check still fails closed.
   */
  assignments?: ReadonlyArray<{ role: string; scope: AssignedScope }>;
}

// A glob cannot be compared against a scope pattern without false positives, so
// only LITERAL allowlist entries take part in the scope cross-check.
const GLOB_META_RE = /[*?[\]{}()!+@]/;

export function openCodeQueuePolicyReport(
  units: PlanDelegationUnit[],
  options: OpenCodeQueuePolicyOptions = {},
): OpenCodeQueuePolicyReport {
  const queue = buildOpenCodeQueue('', '', units);
  const violations: string[] = [];
  const byUnitId = new Map<string, string[]>();
  const idToIndex = new Map<string, number>();
  const scopesByRole = new Map<string, AssignedScope[]>();
  for (const assignment of options.assignments || []) {
    if (!assignment?.role || !assignment.scope) continue;
    const role = normalizeOpenCodeRole(assignment.role);
    scopesByRole.set(role, [...(scopesByRole.get(role) || []), assignment.scope]);
  }
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
    // Docs-only units document commands rather than perform them (same rationale
    // as the dependency exemption above): a CONTRIBUTING.md draft saying "run
    // `pnpm test` before a PR" is prose, not test work — its allowlist already
    // confines it to documentation files (observed false-deny on a root-docs unit).
    if (!isDocsOnlyUnit(unit) && mentionsTestWork(unit.task) && !allowsTestOrConfigPath(unit.allowedFiles)) {
      add(`OpenCode unit \`${unit.id}\` mentions tests/testability but its files allowlist does not include exact test/spec/config paths; either add those paths explicitly or remove the test acceptance criteria`, unit.id);
    }
    for (const allowed of unit.allowedFiles) {
      if (/[{}]/.test(allowed)) {
        add(`OpenCode unit \`${unit.id}\` uses ambiguous brace/glob syntax in files allowlist \`${allowed}\`; list explicit paths/areas instead`, unit.id);
      }
      if (allowed === '*' || allowed === '**' || allowed === '**/*') {
        add(`OpenCode unit \`${unit.id}\` uses an overbroad files allowlist \`${allowed}\`; list explicit source paths/areas instead`, unit.id);
      }
      if (unsafeAllowedFilePatterns([allowed]).length > 0) {
        add(`OpenCode unit \`${unit.id}\` allowlist includes generated/internal path \`${allowed}\``, unit.id);
      }
    }
    // A unit's declared files must be writable BY ITS OWN ROLE. validateDelegatedDiff
    // already fails closed on this, but only AFTER the model ran: observed 17c, unit
    // `seo-public-assets` (role frontend) listed `.env.example`, which the same
    // architect's assignments.json gives to backend — a full delegation burned, and the
    // three in-scope files it did produce were rolled back with the rejected patch.
    const roleScopes = scopesByRole.get(normalizeOpenCodeRole(unit.role)) || [];
    if (roleScopes.length > 0) {
      const outside = unit.allowedFiles.filter((allowed) => !GLOB_META_RE.test(allowed)
        && !roleScopes.some((scope) => matchesScope(allowed, scope)));
      if (outside.length > 0) {
        // Remediation must be something the reader is ALLOWED to do: the same
        // gate that emits this denies the architect any write to assignments.json
        // ("do not scaffold assignments"), and runtime rehashes it anyway — so
        // "widen assignments.json" sent the architect down a path that can only
        // fail (observed 1cu-cursor: it dropped the units instead, halving the
        // delegation queue). Ownership comes from the module declaration.
        add(`OpenCode unit \`${unit.id}\` (role ${unit.role}) lists file(s) outside ${unit.role}'s assignment scope: ${outside.join(', ')}; move them into a unit whose role owns them, or drop them from the queue. \`runs/<runId>/assignments.json\` is runtime-owned and compiled from your ArchitectureInputV1 modules — declare the module under the owning role instead of editing that file.`, unit.id);
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

// A unit whose declared `depends:` predecessor ended in one of these has no
// prerequisites on disk: running it burns a full delegation to fail the same way
// (17c: a tester unit spent 303s trying to CREATE the package its dependency
// never produced). `no_changes` and `skipped` are NOT blocking — the dependency
// simply had nothing to do.
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
  if (action === 'skipped' || action === 'skipped-dependency-failed') return 'skipped';
  if (action === 'abandoned') return 'abandoned';
  if (/outside .*allowlist|outside .*assignment scope|generated\/internal artifact|assignment scope changed/i.test(error || '')) {
    return 'rejected_policy';
  }
  return 'failed';
}
