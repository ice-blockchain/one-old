// src/shared/opencode-plan/retarget.ts
// Auto-retarget OpenCode queue `files:` entries that miss compiled ownership
// only because the architect invented a conventional kebab path for a module
// the compiler emits in PascalCase (or with a different extension in the
// allowed set).
//
// Observed 5cl-claude, then again as an end-user PLAN_READY: units listed
// `apps/web/src/components/ticket-status-badge.tsx` while ArchitectureInputV1
// compiled `TicketStatusBadge.tsx`. The plan.md write gate has no assignments
// yet, so kebab paths pass; PLAN_READY compiles candidate assignments and the
// scope cross-check denies. Hosts paint that PreToolUse deny as an agent
// Error. End users reinstall; they do not retarget the queue. The missing-block
// auto-fix in preserve.ts is the same doctrine: rewrite on disk at the
// PLAN_READY touchpoint so the deny never fires when the mapping is unique.
//
// Invented helpers with no compiled module (`src/lib/format.ts`, 4cl) still
// deny — uniqueness is required and generic stems (`index`, `page`, `layout`,
// `component`, `app`) never match. Same-directory and directory-suffix
// matches win when they are unique; a unique kebab stem across the role's
// module outputs is the fallback (the compiler may emit the component under
// `packages/ui/src` while the architect listed `apps/web/src/components/`).

import * as fs from 'fs';
import * as path from 'path';

import { readRegularFileResult } from '../bounded-read';
import { parseAllowedFiles, normalizeOpenCodeRole } from '../opencode-queue/store';
import { T1_DIR } from '../opencode-queue/types';
import { OPENCODE_PLAN_MIN_UNITS, parsePlanDelegationUnits } from '../opencode-roles/plan-units';
import { matchesScope, normalizeRelPath, type AssignedScope } from '../scope';
import type { PlanDelegationUnit } from './unit-types';

const START_MARKER = 'opencode-delegate:start';
const END_MARKER = 'opencode-delegate:end';
const GLOB_META_RE = /[*?[\]{}()!+@]/;
const GENERIC_STEMS = new Set(['index', 'page', 'layout', 'component', 'app']);
const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const COMPOUND_EXTS = ['.blade.php', '.test.ts', '.component.ts'] as const;

export interface CompiledModuleOutput {
  path: string;
  ownerRole: string;
}

export interface QueueFileRetarget {
  unitId: string;
  from: string;
  to: string;
}

export interface QueueRetargetOptions {
  assignments: ReadonlyArray<{ role: string; scope: AssignedScope }>;
  moduleOutputs: readonly CompiledModuleOutput[];
}

interface FileKey {
  dir: string;
  stem: string;
  ext: string;
  base: string;
}

function kebabStem(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function splitFile(rel: string): FileKey | null {
  const norm = normalizeRelPath(rel);
  if (!norm || GLOB_META_RE.test(norm)) return null;
  const base = path.posix.basename(norm);
  const dirRaw = path.posix.dirname(norm);
  const ext = COMPOUND_EXTS.find((candidate) => base.toLowerCase().endsWith(candidate))
    || path.posix.extname(base);
  if (!ext) return null;
  const stem = kebabStem(base.slice(0, -ext.length));
  if (!stem || GENERIC_STEMS.has(stem)) return null;
  return {
    dir: dirRaw === '.' ? '' : dirRaw,
    stem,
    ext: ext.toLowerCase(),
    base: ext ? base.slice(0, -ext.length) : base,
  };
}

function compatibleExt(invented: string, compiled: string): boolean {
  if (invented === compiled) return true;
  return SCRIPT_EXTS.has(invented) && SCRIPT_EXTS.has(compiled);
}

function dirCompatible(inventedDir: string, compiledDir: string): boolean {
  if (!inventedDir) return false;
  if (inventedDir === compiledDir) return true;
  return compiledDir.endsWith(`/${inventedDir}`) || inventedDir.endsWith(`/${compiledDir}`);
}

function outputBase(rel: string): string {
  const key = splitFile(rel);
  if (!key) return normalizeRelPath(rel);
  const dir = key.dir ? `${key.dir}/` : '';
  return `${dir}${key.base}`;
}

function findRetarget(
  allowed: string,
  role: string,
  options: QueueRetargetOptions,
): string | null {
  const invented = splitFile(allowed);
  if (!invented) return null;
  const roleName = normalizeOpenCodeRole(role);
  const roleScopes = options.assignments
    .filter((assignment) => normalizeOpenCodeRole(assignment.role) === roleName)
    .map((assignment) => assignment.scope);
  if (roleScopes.length === 0) return null;
  if (roleScopes.some((scope) => matchesScope(allowed, scope))) return null;

  const matches = options.moduleOutputs.flatMap((output) => {
    if (normalizeOpenCodeRole(output.ownerRole) !== roleName) return [];
    if (!roleScopes.some((scope) => matchesScope(output.path, scope))) return [];
    const compiled = splitFile(output.path);
    if (!compiled) return [];
    if (compiled.stem !== invented.stem) return [];
    if (!compatibleExt(invented.ext, compiled.ext)) return [];
    const score = invented.dir === compiled.dir
      ? 2
      : dirCompatible(invented.dir, compiled.dir)
        ? 1
        : 0;
    return [{ path: output.path, score }];
  });
  if (matches.length === 0) return null;
  const best = Math.max(...matches.map((match) => match.score));
  const top = matches.filter((match) => match.score === best).map((match) => match.path);
  const uniquePaths = [...new Set(top)];
  const exactExt = uniquePaths.filter((candidate) => splitFile(candidate)?.ext === invented.ext);
  const bases = new Set(uniquePaths.map(outputBase));
  if (bases.size !== 1) return null;
  return exactExt[0] || uniquePaths[0] || null;
}

/**
 * Pure half: rewrite out-of-scope `files:` entries that uniquely match a
 * compiled module output owned by the same role. Units that cannot be
 * retargeted are left as-is so the policy deny still names them.
 */
export function retargetPlanDelegationUnits(
  units: PlanDelegationUnit[],
  options: QueueRetargetOptions,
): { units: PlanDelegationUnit[]; retargets: QueueFileRetarget[] } {
  if (options.moduleOutputs.length === 0 || options.assignments.length === 0) {
    return { units, retargets: [] };
  }
  const retargets: QueueFileRetarget[] = [];
  const nextUnits = units.map((unit) => {
    const seen = new Set<string>();
    const files: string[] = [];
    for (const allowed of parseAllowedFiles(unit.files)) {
      const rewritten = findRetarget(allowed, unit.role, options) || allowed;
      if (seen.has(rewritten)) continue;
      seen.add(rewritten);
      files.push(rewritten);
      if (rewritten !== allowed) {
        retargets.push({ unitId: unit.id || '', from: allowed, to: rewritten });
      }
    }
    if (files.join(', ') === parseAllowedFiles(unit.files).join(', ')) return unit;
    return { ...unit, files: files.join(', ') };
  });
  return { units: nextUnits, retargets };
}

function serializeUnit(unit: PlanDelegationUnit): string {
  const field = (value: string): string => value.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ').trim();
  const fields: string[] = [];
  if (unit.id) fields.push(`id: ${field(unit.id)}`);
  fields.push(`role: ${field(unit.role)}`);
  if (unit.kind) fields.push(`kind: ${field(unit.kind)}`);
  fields.push(`files: ${field(parseAllowedFiles(unit.files).join(', '))}`);
  fields.push(`task: ${field(unit.task)}`);
  if (unit.dependsOn && unit.dependsOn.length > 0) {
    fields.push(`depends: ${field(unit.dependsOn.join(','))}`);
  }
  return `- ${fields.join(' | ')}`;
}

function reconstructBlock(units: PlanDelegationUnit[]): string | null {
  if (units.length < OPENCODE_PLAN_MIN_UNITS) return null;
  const block = [
    `<!-- ${START_MARKER} -->`,
    ...units.map(serializeUnit),
    `<!-- ${END_MARKER} -->`,
  ].join('\n');
  return parsePlanDelegationUnits(block).length >= OPENCODE_PLAN_MIN_UNITS ? block : null;
}

function replaceDelegateBlock(planText: string, block: string): string {
  const start = planText.indexOf(START_MARKER);
  const end = planText.indexOf(END_MARKER);
  if (start < 0 || end < start) return planText;
  const from = planText.lastIndexOf('\n', start) + 1;
  const endLineBreak = planText.indexOf('\n', end);
  const to = endLineBreak < 0 ? planText.length : endLineBreak;
  return `${planText.slice(0, from)}${block}${planText.slice(to)}`;
}

function planPath(cwd: string): string {
  return path.join(cwd, T1_DIR, 'plan.md');
}

/**
 * PLAN_READY half of the auto-fix: rewrite kebab (or extension-variant) queue
 * paths on disk to the unique compiled module output before the scope
 * cross-check runs. Returns the retargets that were persisted; empty means
 * the plan was left untouched (already in scope, ambiguous, or unreadable).
 */
export function retargetPlanOpenCodeQueueToCompiledOutputs(
  cwd: string,
  options: QueueRetargetOptions,
): QueueFileRetarget[] {
  const file = planPath(cwd);
  const read = readRegularFileResult(file);
  if (read.kind !== 'text') return [];
  const units = parsePlanDelegationUnits(read.text);
  if (units.length === 0) return [];
  const rewritten = retargetPlanDelegationUnits(units, options);
  if (rewritten.retargets.length === 0) return [];
  const block = reconstructBlock(rewritten.units);
  if (!block) return [];
  const next = replaceDelegateBlock(read.text, block);
  if (next === read.text) return [];
  try {
    fs.writeFileSync(file, next, 'utf8');
    return rewritten.retargets;
  } catch {
    return [];
  }
}
