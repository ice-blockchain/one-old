// src/shared/architecture-contract/baseline.ts
// The immutable baseline: git/file-manifest capture, skip rules, stray-
// artifact deletability, context-alias links, and snapshot/baseline IO.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  type CapabilityProfileV1,
} from '../capabilities';
import {
  AMBIGUOUS_SKIP_DIRS,
  AUTHORED_SOURCE_EXTENSIONS,
  SKIP_DIRS,
  SKIP_FILES,
  isInertScanPath,
} from '../../config/reporting';
import { readJson } from '../fsjson';
import { sha256 } from '../text';

import {
  ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION,
  ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION,
  ARCHITECTURE_SCAN_MAX_FILES,
  type ArchitectureBaselineV1,
  type ArchitectureRunBaselineV1,
  type ArchitectureRunSnapshotV1,
  type CompiledArchitectureV1,
} from './types';
import {
  MEMORY_DIR,
  contractHash,
  normalizeRelative,
  baselineContains,
} from './core';
import {
  moduleOutputVariants,
} from './naming';
import { readRegularBytesOrThrow, readRegularFileOrThrow } from '../bounded-read';

export const ARCHITECTURE_SCAN_BOUND_CODE = 'ARCHITECTURE_SCAN_BOUND' as const;

export class ArchitectureScanBoundError extends Error {
  readonly code = ARCHITECTURE_SCAN_BOUND_CODE;
  readonly count: number;

  constructor(count: number) {
    super(`architecture scan bound exceeded: ${count} source-surface files`);
    this.name = 'ArchitectureScanBoundError';
    this.count = count;
  }
}

export function isArchitectureScanBoundError(error: unknown): error is ArchitectureScanBoundError {
  return error instanceof ArchitectureScanBoundError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === ARCHITECTURE_SCAN_BOUND_CODE
      && typeof (error as { count?: unknown }).count === 'number'
    );
}

function listingPathspec(value: string): string | null {
  const trimmed = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('../') || trimmed.startsWith('/')) {
    return null;
  }
  if (trimmed.includes('..')) return null;
  return trimmed;
}

function workspaceAppRoots(profile: CapabilityProfileV1): string[] {
  const roots = new Set<string>();
  for (const candidate of [...profile.sourceRoots, ...profile.entrypoints]) {
    const match = /^(apps\/[^/]+)\//.exec(candidate.replace(/\\/g, '/'));
    if (match) roots.add(`${match[1]}/app`);
  }
  return [...roots];
}

/**
 * Trees (and the few exact files) compile listing asks Git for. Not the raw
 * commit: public assets, tracked vendor, and plugin JS stay off the list
 * unless they sit under a compiled root.
 */
export function compileListingPathspecs(profile: CapabilityProfileV1): string[] {
  const specs: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const normalized = listingPathspec(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    specs.push(normalized);
  };
  for (const root of profile.sourceRoots) add(root);
  for (const root of [
    ...profile.layerRoots.pages,
    ...profile.layerRoots.components,
    ...profile.layerRoots.features,
    ...profile.layerRoots.lib,
  ]) add(root);
  add('app');
  for (const root of workspaceAppRoots(profile)) add(root);
  add('internal');
  add('cmd');
  add('pkg');
  add('src');
  for (const entry of profile.entrypoints) {
    const parent = path.posix.dirname(entry.replace(/\\/g, '/'));
    if (parent && parent !== '.') add(parent);
  }
  add('package.json');
  add('*/settings.py');
  return specs;
}

function expandListingPathspecs(
  projectRoot: string,
  sha: string,
  prefix: string,
  requested: readonly string[],
): string[] {
  const concrete: string[] = [];
  let wantsSettings = false;
  for (const spec of requested) {
    if (spec === '*/settings.py' || spec === ':(glob)*/settings.py') {
      wantsSettings = true;
      continue;
    }
    concrete.push(spec);
  }
  if (!wantsSettings) return concrete.map((spec) => prefixGitPathspec(prefix, spec));
  let top = '';
  try {
    top = execFileSync('git', [
      '-C', projectRoot, 'ls-tree', '--name-only', sha,
      ...(prefix ? ['--', prefix] : []),
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    top = '';
  }
  const settings: string[] = [];
  for (const raw of top.split(/\r?\n/)) {
    const entry = raw.replace(/\\/g, '/');
    if (!entry) continue;
    const rel = prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
    if (!rel || rel.includes('/')) continue;
    settings.push(`${rel}/settings.py`);
  }
  return [...concrete, ...settings].map((spec) => prefixGitPathspec(prefix, spec));
}

function prefixGitPathspec(prefix: string, spec: string): string {
  if (!prefix) return spec;
  if (spec.startsWith(':(')) {
    const close = spec.indexOf(')');
    if (close < 0) return `${prefix}${spec}`;
    return `${spec.slice(0, close + 1)}${prefix}${spec.slice(close + 1)}`;
  }
  return `${prefix}${spec}`;
}

function countTowardScanBound(relativePath: string, leftoverFullWalk: boolean): boolean {
  if (leftoverFullWalk && isScanSkippedPath(relativePath)) return false;
  return !isInertScanPath(relativePath);
}

export function baselinePathSet(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
  pathspecs?: readonly string[],
): Set<string> {
  if (baseline.kind === 'file-manifest') {
    return new Set([
      ...(baseline.files || []).map((entry) => entry.path),
      ...(baseline.directories || []),
    ]);
  }
  if (!baseline.identity.startsWith('git:')) {
    throw new Error('immutable Git baseline identity is invalid');
  }
  const requested = (pathspecs || [])
    .map((spec) => spec.replace(/\\/g, '/').trim())
    .filter(Boolean);
  const leftoverFullWalk = requested.length === 0;
  let output: string;
  let prefix = '';
  try {
    prefix = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\\/g, '/');
    const gitPathspecs = leftoverFullWalk
      ? (prefix ? [prefix] : [])
      : expandListingPathspecs(projectRoot, baseline.identity.slice(4), prefix, requested);
    output = execFileSync('git', [
      '-C', projectRoot, 'ls-tree', '-r', '--name-only', baseline.identity.slice(4),
      ...(gitPathspecs.length > 0 ? ['--', ...gitPathspecs] : []),
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    if (isArchitectureScanBoundError(error)) throw error;
    throw new Error('immutable Git baseline tree cannot be read');
  }
  const files = output.split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => !prefix || entry.startsWith(prefix))
    .map((entry) => prefix ? entry.slice(prefix.length) : entry)
    .filter(Boolean);
  let counted = 0;
  const listed = new Set<string>();
  for (const file of files) {
    if (leftoverFullWalk && isScanSkippedPath(file)) continue;
    listed.add(file);
    if (countTowardScanBound(file, leftoverFullWalk)) {
      counted += 1;
      if (counted > ARCHITECTURE_SCAN_MAX_FILES) {
        throw new ArchitectureScanBoundError(counted);
      }
    }
  }
  return listed;
}


/**
 * Is `relPath` a stray by-product safe to delete outright — present on disk,
 * owned by nobody in the compiled contract, and absent from the immutable
 * baseline? A role that produced a file outside its allowlist otherwise cannot
 * remove it (observed 6co: `apps/web/public/icons/favicon.svg.png` was denied to
 * the frontend AND to the parent), so a deadlock only an exact `git clean`
 * escaped. Fail CLOSED: anything unreadable, tracked, compiled, or outside the
 * project is not deletable through this path.
 */
export function isDeletableStrayArtifact(
  projectRoot: string,
  relPath: string,
  architecture: CompiledArchitectureV1 | null,
): boolean {
  const normalized = normalizeRelative(relPath);
  if (!normalized || !architecture) return false;
  if (/(?:^|\/)(?:\.git|\.traffic-one)(?:\/|$)/.test(normalized)) return false;
  const absolute = path.join(projectRoot, normalized);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  // Never a compiled output: deleting one is a contract change, not cleanup.
  // Extension freedom: EVERY allowed variant of a module is a compiled output.
  const compiled = new Set([
    ...(architecture.scaffoldOutputs || []).map((output) => output.path),
    ...(architecture.modules || []).flatMap((module) => moduleOutputVariants(module)),
  ]);
  if (compiled.has(normalized)) return false;
  let baselinePaths: ReadonlySet<string>;
  try {
    baselinePaths = baselinePathSet(
      projectRoot,
      architecture.baseline,
      compileListingPathspecs(architecture.profile),
    );
  } catch {
    return false;
  }
  if (baselineContains(baselinePaths, normalized)) return false;
  // A Git baseline lists HEAD, not the index — a file staged after capture is
  // tracked and must not vanish through a cleanup carve-out.
  if (architecture.baseline.kind === 'git-head') {
    try {
      execFileSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', normalized], {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return false;
    } catch {
      // not tracked — the only branch that permits deletion
    }
  }
  return true;
}

function findGitDir(projectRoot: string): string | null {
  let cursor = path.resolve(projectRoot);
  while (true) {
    const dotGit = path.join(cursor, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(readRegularFileOrThrow(dotGit));
        if (match?.[1]) return path.resolve(cursor, match[1]);
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function gitHead(projectRoot: string): string | null {
  const gitDir = findGitDir(projectRoot);
  if (!gitDir) return null;
  try {
    const head = readRegularFileOrThrow(path.join(gitDir, 'HEAD')).trim();
    if (/^[a-f0-9]{40,64}$/i.test(head)) return head.toLowerCase();
    const ref = /^ref:\s+(.+)$/.exec(head)?.[1];
    if (!ref) return null;
    const direct = path.join(gitDir, ref);
    try {
      const value = readRegularFileOrThrow(direct).trim();
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
    } catch {
      const packed = readRegularFileOrThrow(path.join(gitDir, 'packed-refs'));
      const line = packed.split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
      const value = line?.split(' ')[0] || '';
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

// Package-manager and toolchain by-products of the MANDATORY workflow steps —
// not authored source. A lockfile appears the moment an implementer installs
// the dependency a completion gate itself demanded (observed 5co-codex: the
// format-parity gate required `prettier`, `pnpm install` wrote pnpm-lock.yaml,
// and the verification refresh then denied every subsequent `IMPLEMENTED` as
// "changed paths outside the frozen verification/WorkUnit authority" — a
// permanent deadlock on an otherwise green run; the tester's Playwright run
// added `test-results/.last-run.json` the same way and the canonical QA
// runner rejected the whole manifest). These files are excluded from BOTH the
// immutable baseline capture and every later scan, so they can never appear
// as unauthorized changed paths — keep the two sides in exact agreement.
//
// The NAME sets live in `config/reporting` (SKIP_DIRS / SKIP_FILES) so the code
// graph and both scan sides share one authority. Only glob-shaped artifacts a
// name set cannot express stay here.
const DERIVED_ARTIFACT_GLOB_RE = /(^|\/)[^/]*\.tsbuildinfo$/;

/**
 * True when `relativePath` must be invisible to baseline capture and to every
 * baseline-derived diff (verification refresh, QA evidence manifest). Shared by
 * `architecture-contract` (capture) and `verification-contract` (compare) so
 * the two scans can never disagree about a derived artifact.
 */
export function isScanSkippedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (DERIVED_ARTIFACT_GLOB_RE.test(`/${normalized}`)) return true;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  if (SKIP_FILES.has(segments[segments.length - 1]!)) return true;
  return segments.some((segment) => SKIP_DIRS.has(segment));
}

/**
 * Paths this project's own Git configuration already ignores, as a set that
 * also covers descendants of an ignored directory.
 *
 * The two scan sides disagreed without this. `boundedGitPaths` asks Git with
 * `--exclude-standard`, so a gitignored file is invisible on a `git-head`
 * baseline; the filesystem walks below knew only the static name sets, so the
 * SAME file was an unauthorized changed path on a `file-manifest` baseline.
 * Observed twice: `.claude/settings.local.json` (written by the plugin itself)
 * blocked all QA settlement, and a Laravel run captured 8,569 `vendor/**` files
 * that `.gitignore:1` already excluded.
 *
 * Returns null when the answer cannot be trusted — no work tree, Git
 * unavailable, or a degenerate result that would hide the whole project — and
 * callers then fall back to the static name sets alone.
 */
function gitPaths(projectRoot: string, args: string[]): string[] | null {
  let output: string;
  try {
    output = execFileSync('git', ['-C', projectRoot, 'ls-files', '-z', ...args], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  return output.split('\0')
    .map((raw) => raw.replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
}

function ignoredProjectPaths(projectRoot: string): Set<string> | null {
  const entries = gitPaths(projectRoot, ['--others', '--ignored', '--exclude-standard', '--directory']);
  if (!entries || entries.length === 0) return null;
  // Degenerate-rule guard, same shape as `wouldIgnoreAllSource` in codegraph:
  // a pattern broad enough to ignore everything (`*` in a fresh repo) would
  // hide every source file from BOTH scan sides, which is a worse failure than
  // the stray path this exists to skip. If nothing survives the rules, distrust
  // them entirely and fall back to the static name sets.
  const visible = gitPaths(projectRoot, ['--cached', '--others', '--exclude-standard']);
  if (!visible || visible.length === 0) return null;
  const ignored = new Set<string>();
  for (const entry of entries) {
    if (entry === '.' || entry === '/' || entry.startsWith('../')) return null;
    ignored.add(entry);
  }
  return ignored;
}

/**
 * Per-scan skip predicate: the shared static name sets plus this project's own
 * Git ignore rules. Build it ONCE per scan — it costs a single `git` call — and
 * use it for every entry so capture and compare stay byte-identical.
 */
export function scanSkipPredicate(projectRoot: string): (relativePath: string) => boolean {
  const ignored = ignoredProjectPaths(projectRoot);
  if (!ignored || ignored.size === 0) return isScanSkippedPath;
  return (relativePath: string): boolean => {
    if (isScanSkippedPath(relativePath)) return true;
    let probe = relativePath.replace(/\\/g, '/');
    for (;;) {
      if (ignored.has(probe)) return true;
      const cut = probe.lastIndexOf('/');
      if (cut < 0) return false;
      probe = probe.slice(0, cut);
    }
  };
}

function fileContentHash(fullPath: string): string | null {
  try { return sha256(readRegularBytesOrThrow(fullPath).toString('base64')); } catch { return null; }
}

function gitConfigValue(projectRoot: string, key: string): string | null {
  try {
    return execFileSync('git', ['-C', projectRoot, 'config', '--get', key], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * A digest of every ignore rule in force, or null when Git cannot answer.
 *
 * This pins the half of the skip authority the project can MOVE, and it is the
 * field `verification-contract/git.ts` said it needed. The previous compensation
 * keyed on an ignore-rule file appearing among the CHANGED PATHS, which a
 * `.gitignore` listing `.gitignore` walks straight through: git stops reporting
 * the file, the file-manifest walk stops seeing it, and the rule it added goes
 * unmentioned by both sides. Reading the rules directly cannot be defeated that
 * way, because a file that hides itself from git is still a file on disk.
 *
 * What is digested is the RULES, not their effect. Digesting the ignored SET —
 * `git ls-files --others --ignored` — would move the moment a build wrote its
 * first artifact, so it would report "the authority moved" on every run that
 * compiled anything and the fail-closed floor would be permanently on.
 *
 * The `.gitignore` files are found from Git's own two listings rather than by
 * walking: every directory holding a visible path, plus every directory holding
 * an ignored one, which together cover every rule file that can hide anything
 * reachable. A `.gitignore` inside a wholly ignored directory is not read, and
 * it cannot matter — everything below it is already ignored by the rule that
 * collapsed the parent.
 *
 * `.git/info/exclude` and `core.excludesFile` are included here. They were
 * disclosed as permanently unreportable when the authority was inferred from
 * the changed paths, which was true of THAT instrument and is not true of this
 * one: neither is a tracked file, and neither needs to be to be read.
 */
export function ignoreRuleDigest(projectRoot: string): string | null {
  const visible = gitPaths(projectRoot, ['--cached', '--others', '--exclude-standard']);
  if (!visible) return null;
  const ignored = gitPaths(projectRoot, ['--others', '--ignored', '--exclude-standard', '--directory']) || [];
  const directories = new Set<string>(['']);
  for (const entry of [...visible, ...ignored]) {
    for (let cut = entry.lastIndexOf('/'); cut > 0; cut = entry.lastIndexOf('/', cut - 1)) {
      directories.add(entry.slice(0, cut));
    }
  }
  const rows: string[] = [];
  for (const directory of [...directories].sort()) {
    const rel = directory ? `${directory}/.gitignore` : '.gitignore';
    const hash = fileContentHash(path.join(projectRoot, rel));
    if (hash) rows.push(`${rel}:${hash}`);
  }
  const gitDir = findGitDir(projectRoot);
  if (gitDir) {
    const hash = fileContentHash(path.join(gitDir, 'info', 'exclude'));
    if (hash) rows.push(`.git/info/exclude:${hash}`);
  }
  const configured = gitConfigValue(projectRoot, 'core.excludesFile');
  if (configured) {
    const resolved = configured.startsWith('~')
      ? path.join(os.homedir(), configured.slice(1))
      : path.resolve(projectRoot, configured);
    // An unreadable configured file is still a moved authority the moment the
    // setting itself appears or disappears, so the row is emitted either way.
    rows.push(`core.excludesFile:${fileContentHash(resolved) || 'unreadable'}`);
  }
  return contractHash({ ignoreRules: rows });
}

/**
 * Paths this project's own Git configuration makes visible that the STATIC name
 * sets hide anyway — authored code under a directory called `generated`,
 * `dist`, `out`, `build` or `coverage`.
 *
 * "Makes visible" is `--cached --others --exclude-standard`: TRACKED, plus
 * untracked-and-not-ignored. Not the index alone, and the second half is the
 * half that matters — the exploit below requires no commit, and this module's
 * own closure test plants its files without ever running `git add`. Narrowing
 * the probe to `--cached` would turn that test green while deleting the defence
 * it is named for.
 *
 * This is the other half of the skip authority, and it is the half no diff
 * could report before, because `isScanSkippedPath` is a compile-time constant
 * with no project input to test against. Git supplies the input. Five new
 * `.tsx` under `apps/web/generated/` are invisible to BOTH sides of every diff
 * — `boundedGitPaths` drops them at the name filter and the file-manifest walk
 * never lists them — so the changed set is EMPTY and reports `complete: true`.
 * Nothing in the run had to act for that: naming a directory `generated` is
 * enough.
 *
 * The narrowing is what keeps it quiet. A project that gitignores its build
 * output has nothing here, because git does not make those paths visible. Only
 * the ambiguous names are consulted (`node_modules` is never authored source
 * however it is tracked), only authored-code extensions count (a lockfile is a
 * SKIP_FILE, tracked on purpose, and a `test-results/.last-run.json` deadlocked
 * settlement once already), and the answer raises the truncated-scan floor
 * rather than adding changed paths, which is what keeps a project that commits
 * its `dist` out of the "changed paths outside the frozen authority" deadlock.
 *
 * It is quiet, NOT rare, and the difference was measured. `ensureProjectGitignore`
 * deliberately withholds build-output opinions from a repository with history
 * (its own test: "never imposes the build-output opinions on a repository with
 * history, whatever detectMode says"), so on an existing project this runtime
 * declines to add the `dist/` line and then meets whatever the run's own
 * `npm run build` leaves behind — measured on two `test:env --strict`
 * scenarios, where a Vite build wrote an un-ignored, untracked
 * `dist/assets/app-<hash>.js` and this function reported it, correctly.
 *
 * Which is why the CONSUMER decides what that costs. This function's job ends
 * at naming the file; a caller that turns the name into a total refusal is
 * refusing a run for something the run itself created, and
 * `currentVerificationSourceHash` no longer does (see
 * `SKIP_NAME_DISCLOSURE_MARKER`).
 */
export function nameSkippedProjectSource(projectRoot: string, limit = 3): string[] {
  const visible = gitPaths(projectRoot, ['--cached', '--others', '--exclude-standard']);
  if (!visible) return [];
  const found: string[] = [];
  for (const entry of visible) {
    if (found.length >= limit) break;
    if (hiddenByAmbiguousDirectoryName(entry)) found.push(entry);
  }
  return found;
}

/**
 * Source that THIS project's ignore rules currently hide, and that the static
 * skip names would still have treated as visible project source.
 *
 * Used when the ignore-rule digest moved after baseline capture. A digest
 * change alone is not proof of loss: a new-project scaffold that adds
 * `node_modules/` and `dist/` to `.gitignore` after PLAN_READY moves the
 * digest without hiding any live source, and treating that as fatal stranded
 * QA (`scan-incomplete`) on an otherwise green tester. The closure that MUST
 * stay fatal is hiding authored source, or silencing a `dist/assets/*.js`
 * name-disclosure by gitignoring the build tree after those files exist.
 */
export function ignoreRulesHideLiveSource(projectRoot: string, limit = 3): string[] {
  const ignored = gitPaths(projectRoot, ['--others', '--ignored', '--exclude-standard']);
  if (!ignored) return [];
  const found: string[] = [];
  for (const entry of ignored) {
    if (found.length >= limit) break;
    if (hiddenByAmbiguousDirectoryName(entry)) {
      found.push(entry);
      continue;
    }
    if (isScanSkippedPath(entry)) continue;
    if (authoredSourceFile(entry)) found.push(entry);
  }
  return found;
}

function authoredSourceFile(relativePath: string): boolean {
  const name = relativePath.replace(/\\/g, '/').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return AUTHORED_SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function hiddenByAmbiguousDirectoryName(relativePath: string): boolean {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length < 2) return false;
  const name = segments[segments.length - 1]!;
  if (SKIP_FILES.has(name)) return false;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || !AUTHORED_SOURCE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return false;
  const directories = segments.slice(0, -1);
  // A dependency or cache directory settles it on its own: nothing under
  // `node_modules` is this project's authored source, whatever git tracks.
  if (directories.some((segment) => SKIP_DIRS.has(segment) && !AMBIGUOUS_SKIP_DIRS.has(segment))) return false;
  return directories.some((segment) => AMBIGUOUS_SKIP_DIRS.has(segment));
}

const CONTEXT_ALIAS_PATH = 'CLAUDE.md';
const CONTEXT_ALIAS_TARGET = 'AGENTS.md';

/**
 * Root `AGENTS.md`/`CLAUDE.md` are runtime-MAINTAINED project context:
 * materialization rewrites them (rule kernel re-append) on every session, so a
 * content change there is the runtime's own doing, never implementation work a
 * role had to plan. They stay visible to the raw baseline scans (a rogue
 * symlink still fails closed), but every verification JUDGMENT — contract
 * identity, the refresh authority, QA source-hash extras — treats them as
 * legitimately changed. Observed 13cl: the frontend reported "AGENTS.md
 * restored to baseline — the gitnexus hook re-appends", i.e. the runtime was
 * fighting its own hook to satisfy the frozen-authority check.
 * Root-anchored on purpose: a nested AGENTS.md is ordinary project content.
 */
export function isRuntimeMaintainedContextPath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath);
  return normalized === CONTEXT_ALIAS_PATH || normalized === CONTEXT_ALIAS_TARGET;
}

/**
 * Identity row for the canonical context alias. Both the immutable baseline and
 * the verification diff hash it this way, so replacing the alias with a regular
 * file (or another link) still shows up as a change in either scan.
 */
export function contextAliasHash(target: string): string {
  return sha256(`symbolic-link:${target}`);
}

/**
 * The ONE symlink materialization creates in a project root: `CLAUDE.md` →
 * `AGENTS.md`. Returns the link target when `relativePath` is exactly that
 * alias, else null.
 *
 * Exported because every scan that walks project files has to agree about it.
 * The immutable baseline accepted the alias while the verification scan failed
 * closed on it, so the plugin's own materialized artifact denied `PLAN_READY`
 * with `STRUCT_SCAN_INCOMPLETE` (observed 1cu-cursor; the parent had to replace
 * the symlink with a copy by hand to get the run moving).
 */
export function canonicalTrafficOneContextLink(
  projectRoot: string,
  fullPath: string,
  relativePath: string,
): string | null {
  // Materialization owns exactly this root alias. Keep every other symlink
  // fail-closed: source links, nested aliases, absolute targets, and escapes
  // must never disappear from an immutable non-Git baseline.
  if (relativePath !== CONTEXT_ALIAS_PATH) return null;
  let linkTarget: string;
  try {
    linkTarget = fs.readlinkSync(fullPath);
  } catch {
    return null;
  }
  if (linkTarget !== CONTEXT_ALIAS_TARGET) return null;
  const expectedTarget = path.join(path.resolve(projectRoot), CONTEXT_ALIAS_TARGET);
  const resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);
  if (resolvedTarget !== expectedTarget) return null;
  try {
    const targetStat = fs.lstatSync(resolvedTarget);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return linkTarget;
}

function fileManifestBaseline(projectRoot: string, roots: string[]): ArchitectureBaselineV1 {
  const rows: Array<[string, string]> = [];
  const directories: string[] = [];
  const skipped = scanSkipPredicate(projectRoot);
  const stack = roots
    .map((root) => normalizeRelative(root))
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(projectRoot, root));
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      const rel = path.relative(projectRoot, dir).replace(/\\/g, '/') || '.';
      throw new Error(`baseline cannot read ${rel}`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (skipped(rel)) continue;
      if (entry.isSymbolicLink()) {
        const target = canonicalTrafficOneContextLink(projectRoot, full, rel);
        if (target) {
          if (!isInertScanPath(rel)) {
            scanned += 1;
            if (scanned > ARCHITECTURE_SCAN_MAX_FILES) {
              throw new ArchitectureScanBoundError(scanned);
            }
          }
          // The target file is hashed independently. This row additionally
          // makes replacing the canonical alias with another filesystem shape
          // visible in the immutable baseline identity.
          rows.push([rel, contextAliasHash(target)]);
          continue;
        }
        throw new Error(`baseline cannot include symbolic link ${rel}`);
      }
      if (entry.isDirectory()) {
        directories.push(rel);
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isInertScanPath(rel)) {
        scanned += 1;
        if (scanned > ARCHITECTURE_SCAN_MAX_FILES) {
          throw new ArchitectureScanBoundError(scanned);
        }
      }
      let bytes: Buffer;
      try { bytes = readRegularBytesOrThrow(full); } catch {
        throw new Error(`baseline cannot read ${rel}`);
      }
      rows.push([rel, sha256(bytes.toString('base64'))]);
    }
  }
  rows.sort(([a], [b]) => a.localeCompare(b));
  directories.sort((a, b) => a.localeCompare(b));
  const filesHash = contractHash({ files: rows, directories });
  return {
    kind: 'file-manifest',
    identity: `files:${filesHash}`,
    capturedAt: new Date().toISOString(),
    filesHash,
    fileCount: rows.length,
    files: rows.map(([filePath, hash]) => ({ path: filePath, hash })),
    directories,
  };
}

export function captureArchitectureBaseline(
  projectRoot: string,
  _profile: CapabilityProfileV1,
  capturedAt = new Date().toISOString(),
): ArchitectureBaselineV1 {
  // Pinned on BOTH kinds: the git branch asks git with `--exclude-standard` and
  // the file-manifest branch applies the same rules through `scanSkipPredicate`,
  // so the authority moves under either one.
  const ignoreRules = ignoreRuleDigest(projectRoot);
  const pinned = ignoreRules ? { ignoreRules } : {};
  const head = gitHead(projectRoot);
  if (head) return { kind: 'git-head', identity: `git:${head}`, capturedAt, ...pinned };
  // A non-Git baseline covers the project, not only the currently detected
  // source roots. Otherwise an agent could create a new root before contract
  // compilation and have it silently treated as pre-existing debt.
  const baseline = fileManifestBaseline(projectRoot, ['.']);
  return { ...baseline, capturedAt, ...pinned };
}

export function architectureRunSnapshotPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'capability-v1.json');
}

export function architectureRunBaselinePath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'baseline-v1.json');
}

export function readArchitectureRunSnapshot(
  projectRoot: string,
  runId: string,
): ArchitectureRunSnapshotV1 | null {
  const raw = readJson<ArchitectureRunSnapshotV1 | null>(
    architectureRunSnapshotPath(projectRoot, runId),
    null,
  );
  if (!raw
    || raw.schemaVersion !== ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION
    || raw.runId !== runId) return null;
  const { snapshotHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}

export function readArchitectureRunBaseline(
  projectRoot: string,
  runId: string,
): ArchitectureRunBaselineV1 | null {
  const raw = readJson<ArchitectureRunBaselineV1 | null>(
    architectureRunBaselinePath(projectRoot, runId),
    null,
  );
  if (!raw
    || raw.schemaVersion !== ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION
    || raw.runId !== runId) return null;
  const { baselineHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}
