// src/shared/verification-contract-git.ts
// The entire git surface of the verification contract: project context,
// bounded changed-path discovery vs the immutable baseline, and changed-hunk
// evidence. Everything execFileSync('git', ...) lives here.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  canonicalTrafficOneContextLink,
  contextAliasHash,
  isScanSkippedPath,
  scanSkipPredicate,
  type ArchitectureBaselineV1,
  type CompiledArchitectureV1,
} from '../architecture-contract';
import { sha256 } from '../text';

import {
  VERIFICATION_SCAN_MAX_FILES,
  type ChangedPathSnapshot,
} from './types';

const GIT_OBJECT_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export function normalizeRel(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

interface GitProjectContext {
  worktreeRoot: string;
  projectPrefix: string;
}

function gitProjectContext(projectRoot: string): { context?: GitProjectContext; reason?: string } {
  const absoluteProjectRoot = path.resolve(projectRoot);
  try {
    const projectStat = fs.lstatSync(absoluteProjectRoot);
    if (projectStat.isSymbolicLink()) {
      return { reason: 'Git project root is a symbolic link' };
    }
    if (!projectStat.isDirectory()) {
      return { reason: 'Git project root is not a directory' };
    }
    const worktreeOutput = execFileSync('git', [
      '-C', absoluteProjectRoot, 'rev-parse', '--show-toplevel',
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const prefixOutput = execFileSync('git', [
      '-C', absoluteProjectRoot, 'rev-parse', '--show-prefix',
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const worktreeRoot = worktreeOutput.replace(/\r?\n$/, '');
    const rawPrefix = prefixOutput.replace(/\r?\n$/, '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!worktreeRoot || /[\r\n\0]/.test(worktreeRoot) || /[\r\n\0]/.test(rawPrefix)) {
      return { reason: 'Git worktree location is ambiguous' };
    }
    const realWorktreeRoot = fs.realpathSync(worktreeRoot);
    const realProjectRoot = fs.realpathSync(absoluteProjectRoot);
    const relativeProject = path.relative(realWorktreeRoot, realProjectRoot).replace(/\\/g, '/');
    if (relativeProject === '..'
      || relativeProject.startsWith('../')
      || path.isAbsolute(relativeProject)) {
      return { reason: 'project root is outside the Git worktree' };
    }
    const projectPrefix = relativeProject.replace(/\/+$/, '');
    if ((rawPrefix && normalizeRel(rawPrefix) !== rawPrefix)
      || rawPrefix !== projectPrefix) {
      return { reason: 'Git project prefix is ambiguous' };
    }
    return { context: { worktreeRoot: realWorktreeRoot, projectPrefix } };
  } catch {
    return { reason: 'Git worktree context could not be resolved' };
  }
}

function gitPathForProjectPath(context: GitProjectContext, relPath: string): string | null {
  const normalized = normalizeRel(relPath);
  if (!normalized || normalized !== relPath || /[\r\n\0]/.test(normalized)) return null;
  return context.projectPrefix ? `${context.projectPrefix}/${normalized}` : normalized;
}

function projectPathFromGitPath(context: GitProjectContext, gitPath: string): string | null {
  const normalized = normalizeRel(gitPath);
  if (!normalized || normalized !== gitPath || /[\r\n\0]/.test(normalized)) return null;
  if (!context.projectPrefix) return normalized;
  const prefix = `${context.projectPrefix}/`;
  if (!normalized.startsWith(prefix)) return null;
  return normalizeRel(normalized.slice(prefix.length));
}

function nulDelimitedGitPaths(command: string[]): string[] {
  const output = execFileSync('git', command, {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (output.includes('\uFFFD')) throw new Error('Git path encoding is ambiguous');
  return output.split('\0').filter(Boolean);
}

export function projectPathInspectionIssue(projectRoot: string, relPath: string): string | null {
  const normalized = normalizeRel(relPath);
  if (!normalized || normalized !== relPath || /[\r\n\0]/.test(normalized)) {
    return `cannot inspect invalid project path ${relPath || '<empty>'}`;
  }
  let cursor = path.resolve(projectRoot);
  for (const segment of normalized.split('/')) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // Deleted paths are valid diff entries. ENOTDIR likewise means a later
      // path segment cannot exist and will be represented as deleted.
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      return `cannot inspect project path ${normalized}`;
    }
    if (stat.isSymbolicLink()) {
      const symbolic = normalizeRel(path.relative(projectRoot, cursor)) || normalized;
      // The canonical `CLAUDE.md` → `AGENTS.md` alias is materialization's own
      // output and is identity-tracked in the immutable baseline. Failing the
      // scan closed on it meant the plugin blocked its own `PLAN_READY`.
      if (canonicalTrafficOneContextLink(projectRoot, cursor, symbolic)) continue;
      return `symbolic link makes verification scan incomplete: ${symbolic}`;
    }
  }
  return null;
}

function boundedGitPaths(projectRoot: string, baselineHash: string): ChangedPathSnapshot {
  if (!GIT_OBJECT_ID_RE.test(baselineHash)) {
    return { paths: [], complete: false, reason: 'Git baseline identity is invalid' };
  }
  const resolved = gitProjectContext(projectRoot);
  if (!resolved.context) {
    return { paths: [], complete: false, reason: resolved.reason || 'Git worktree context could not be resolved' };
  }
  const { context } = resolved;
  const projectPathspec = context.projectPrefix || '.';
  try {
    const tracked = nulDelimitedGitPaths([
      '-C', context.worktreeRoot, 'diff', '--name-only', '-z',
      '--diff-filter=ACDMRTUXB', baselineHash, '--', projectPathspec,
    ]);
    const untracked = nulDelimitedGitPaths([
      '-C', context.worktreeRoot, 'ls-files', '--others', '--exclude-standard',
      '-z', '--', projectPathspec,
    ]);
    const raw = [...tracked, ...untracked];
    if (raw.length > VERIFICATION_SCAN_MAX_FILES) {
      return { paths: [], complete: false, reason: `diff exceeds ${VERIFICATION_SCAN_MAX_FILES} files` };
    }
    const paths: string[] = [];
    for (const item of raw) {
      const normalized = projectPathFromGitPath(context, item);
      if (!normalized) {
        return {
          paths,
          complete: false,
          reason: `Git diff returned an ambiguous or outside-project path`,
        };
      }
      if (isScanSkippedPath(normalized)) continue;
      const issue = projectPathInspectionIssue(projectRoot, normalized);
      if (issue) return { paths, complete: false, reason: issue };
      paths.push(normalized);
    }
    return { paths: unique(paths), complete: true };
  } catch {
    return { paths: [], complete: false, reason: 'git baseline diff could not be completed' };
  }
}

function walkCurrentFiles(projectRoot: string, roots: string[]): ChangedPathSnapshot {
  const files: string[] = [];
  const seen = new Set<string>();
  // Same per-scan predicate the immutable capture uses, so a gitignored path is
  // invisible to BOTH sides of a file-manifest comparison.
  const skipped = scanSkipPredicate(projectRoot);
  const stack = roots.map((root) => path.resolve(projectRoot, root));
  while (stack.length > 0) {
    const current = stack.pop()!;
    let real: string;
    try { real = fs.realpathSync(current); } catch {
      return {
        paths: files,
        complete: false,
        reason: `cannot resolve ${path.relative(projectRoot, current) || '.'}`,
      };
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch {
      return { paths: files, complete: false, reason: `cannot read ${path.relative(projectRoot, current)}` };
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const rel = normalizeRel(path.relative(projectRoot, absolute));
      if (!rel || skipped(rel)) continue;
      if (entry.isSymbolicLink()) {
        // Same canonical alias exception as the immutable baseline, which keeps
        // a `symbolic-link:<target>` identity row for it (see fileHash below).
        if (canonicalTrafficOneContextLink(projectRoot, absolute, rel)) {
          if (files.length >= VERIFICATION_SCAN_MAX_FILES) {
            return { paths: files, complete: false, reason: `source scan exceeds ${VERIFICATION_SCAN_MAX_FILES} files` };
          }
          files.push(rel);
          continue;
        }
        return {
          paths: files,
          complete: false,
          reason: `symbolic link makes verification scan incomplete: ${rel}`,
        };
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      // The non-Git baseline snapshots the whole project (subject to the shared
      // scan-skip predicate),
      // so the comparison must use the identical scope. Restricting this side
      // to source extensions or architecture roots invents deletions and misses
      // new test/config/build-input files outside those roots.
      if (!entry.isFile()) continue;
      if (files.length >= VERIFICATION_SCAN_MAX_FILES) {
        return { paths: files, complete: false, reason: `source scan exceeds ${VERIFICATION_SCAN_MAX_FILES} files` };
      }
      files.push(rel);
    }
  }
  return { paths: unique(files), complete: true };
}

export function fileHash(projectRoot: string, relPath: string): string {
  const filePath = path.join(projectRoot, relPath);
  // Mirror the immutable baseline's identity row for the canonical context
  // alias — hashing the LINK TARGET's bytes here would report `CLAUDE.md` as
  // changed on every single scan.
  const aliasTarget = canonicalTrafficOneContextLink(projectRoot, filePath, relPath);
  if (aliasTarget) return contextAliasHash(aliasTarget);
  try { return sha256(fs.readFileSync(filePath).toString('base64')); } catch { return '<deleted>'; }
}

export function changedPathsFromImmutableBaseline(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
): ChangedPathSnapshot {
  if (baseline.kind === 'git-head' && baseline.identity.startsWith('git:')) {
    return boundedGitPaths(projectRoot, baseline.identity.slice(4));
  }
  const current = walkCurrentFiles(projectRoot, ['.']);
  if (!current.complete) return current;
  const before = new Map((baseline.files || []).map((entry) => [entry.path, entry.hash]));
  const after = new Map(current.paths.map((file) => [file, fileHash(projectRoot, file)]));
  const changed = new Set<string>();
  for (const [file, hash] of before) {
    if (after.get(file) !== hash) changed.add(file);
  }
  for (const [file, hash] of after) {
    if (before.get(file) !== hash) changed.add(file);
  }
  return { paths: [...changed].sort(), complete: true };
}

export function changedPathsFromBaseline(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
): ChangedPathSnapshot {
  return changedPathsFromImmutableBaseline(projectRoot, architecture.baseline);
}

export function safeRead(projectRoot: string, relPath: string): string {
  try { return fs.readFileSync(path.join(projectRoot, relPath), 'utf8').slice(0, 512_000); } catch { return ''; }
}

export interface ChangedHunkEvidence {
  available: boolean;
  before: string;
  after: string;
  changedText: string;
  reason?: string;
}

export function gitTextAtBaseline(
  projectRoot: string,
  baselineHash: string,
  relPath: string,
): { exists: boolean; text: string; readable: boolean } {
  if (!GIT_OBJECT_ID_RE.test(baselineHash)) {
    return { exists: false, text: '', readable: false };
  }
  const resolved = gitProjectContext(projectRoot);
  const gitPath = resolved.context
    ? gitPathForProjectPath(resolved.context, relPath)
    : null;
  if (!resolved.context || !gitPath) {
    return { exists: false, text: '', readable: false };
  }
  try {
    const text = execFileSync('git', [
      '-C', resolved.context.worktreeRoot, 'show', `${baselineHash}:${gitPath}`,
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { exists: true, text: text.slice(0, 512_000), readable: true };
  } catch {
    try {
      execFileSync('git', [
        '-C', resolved.context.worktreeRoot, 'cat-file', '-e', `${baselineHash}:${gitPath}`,
      ], {
        timeout: 3_000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return { exists: true, text: '', readable: false };
    } catch {
      return { exists: false, text: '', readable: true };
    }
  }
}

function gitChangedText(
  projectRoot: string,
  baselineHash: string,
  relPath: string,
): string | null {
  if (!GIT_OBJECT_ID_RE.test(baselineHash)) return null;
  const resolved = gitProjectContext(projectRoot);
  const gitPath = resolved.context
    ? gitPathForProjectPath(resolved.context, relPath)
    : null;
  if (!resolved.context || !gitPath) return null;
  try {
    const diff = execFileSync('git', [
      '-C', resolved.context.worktreeRoot, 'diff', '--no-ext-diff', '--no-color', '--unified=0',
      baselineHash, '--', gitPath,
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return diff
      .split(/\r?\n/)
      .filter((line) => (
        (line.startsWith('+') && !line.startsWith('+++'))
        || (line.startsWith('-') && !line.startsWith('---'))
      ))
      .map((line) => line.slice(1))
      .join('\n')
      .slice(0, 512_000);
  } catch {
    return null;
  }
}

export function changedHunkEvidence(
  projectRoot: string,
  baseline: ArchitectureBaselineV1 | undefined,
  relPath: string,
): ChangedHunkEvidence {
  const after = safeRead(projectRoot, relPath);
  if (!baseline) {
    return {
      available: false,
      before: '',
      after,
      changedText: after,
      reason: 'immutable baseline content was not provided',
    };
  }
  if (baseline.kind === 'git-head' && baseline.identity.startsWith('git:')) {
    const baselineHash = baseline.identity.slice(4);
    const before = gitTextAtBaseline(projectRoot, baselineHash, relPath);
    if (!before.readable) {
      return {
        available: false,
        before: '',
        after,
        changedText: after,
        reason: 'baseline file is not readable as text',
      };
    }
    if (!before.exists) return { available: true, before: '', after, changedText: after };
    const changedText = gitChangedText(projectRoot, baselineHash, relPath);
    if (changedText === null) {
      return {
        available: false,
        before: before.text,
        after,
        changedText: after,
        reason: 'Git changed hunks could not be read',
      };
    }
    return { available: true, before: before.text, after, changedText };
  }
  const baselineFile = (baseline.files || []).find((entry) => entry.path === relPath);
  if (!baselineFile) return { available: true, before: '', after, changedText: after };
  // Manifest baselines retain hashes, not source bodies. They can prove that a
  // TSX file changed, but cannot distinguish handler-only edits from markup.
  return {
    available: false,
    before: '',
    after,
    changedText: after,
    reason: 'file-manifest baseline has no changed-hunk bodies',
  };
}
