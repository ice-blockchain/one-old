// src/runners/opencode/git-sandbox.ts
// Git sandbox primitives: bounded git exec, working-tree snapshots, staging
// excludes, worktree removal, and the atomic apply backup/restore pair.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnTool } from '../../shared/spawn-tool';

export function git(cwd: string, args: string[], timeout = 60_000, env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const r = spawnTool('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { status: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
}

// Snapshot the FULL working tree (tracked changes AND untracked files, minus
// .gitignore'd paths) into a throwaway dangling commit, without touching the
// user's index, stash list, or tree. `git stash create` is NOT enough here: it
// snapshots only TRACKED changes, so mid-build (when most new source is not
// yet committed) the sandbox worktree lacked those files entirely — OpenCode
// re-created them from scratch, the patch came back as "new file", plain apply
// collided with the real tree ("already exists in working directory") and the
// --3way fallback died with "does not exist in index" (untracked files have no
// index entry). Building the snapshot through a TEMPORARY index also puts the
// pre-image blobs in the object DB, so --3way has real ancestors when it IS
// needed. Falls back to plain HEAD on any failure (old behavior, still safe:
// worst case is the pre-fix sandbox). Exported for the regression test.
export function snapshotWorkingTree(cwd: string, headSha: string): string {
  // Clean tree (no staged/unstaged/untracked) → HEAD already IS the snapshot.
  const status = git(cwd, ['status', '--porcelain']);
  if (status.status === 0 && !status.stdout.trim()) return headSha;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oc-idx-'));
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: path.join(tmpDir, 'index'),
    // commit-tree needs an ident; don't depend on user.name/email being set.
    GIT_AUTHOR_NAME: 'traffic-one', GIT_AUTHOR_EMAIL: 'traffic-one@localhost',
    GIT_COMMITTER_NAME: 'traffic-one', GIT_COMMITTER_EMAIL: 'traffic-one@localhost',
  };
  try {
    if (git(cwd, ['read-tree', headSha], 60_000, env).status !== 0) return headSha;
    if (git(cwd, ['add', '-A'], 120_000, env).status !== 0) return headSha;
    const tree = git(cwd, ['write-tree'], 60_000, env);
    if (tree.status !== 0 || !tree.stdout.trim()) return headSha;
    const commit = git(cwd, ['commit-tree', tree.stdout.trim(), '-p', headSha, '-m', 'traffic-one opencode delegation snapshot'], 60_000, env);
    if (commit.status !== 0 || !commit.stdout.trim()) return headSha;
    return commit.stdout.trim();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}


// Pathspecs for staging the worktree diff: install artifacts must never ride a
// delegated diff (observed live: a free-model unit ran `npm install` in the
// sandbox and its diff carried a package-local node_modules/ plus a
// package-lock.json into a pnpm workspace). node_modules is always excluded; all
// lockfiles are excluded because OpenCode is not trusted to mutate dependency
// state. Exported for tests.
export function stageExcludePathspecs(wt: string): string[] {
  const excludes = [
    ':(exclude,glob)**/node_modules/**',
    ':(exclude)node_modules',
    // Build/cache/test-output artifacts are never legitimate delegated source.
    // A model may run installs/builds/tests inside the throwaway worktree; those
    // outputs must not ride the patch back to the real project.
    ':(exclude,glob)**/dist/**',
    ':(exclude,glob)dist/**',
    ':(exclude)dist',
    ':(exclude,glob)**/build/**',
    ':(exclude,glob)build/**',
    ':(exclude)build',
    ':(exclude,glob)**/.turbo/**',
    ':(exclude,glob).turbo/**',
    ':(exclude).turbo',
    ':(exclude,glob)**/.next/**',
    ':(exclude,glob).next/**',
    ':(exclude).next',
    ':(exclude,glob)**/.vite/**',
    ':(exclude,glob).vite/**',
    ':(exclude).vite',
    ':(exclude,glob)**/.cache/**',
    ':(exclude,glob).cache/**',
    ':(exclude).cache',
    ':(exclude,glob)**/coverage/**',
    ':(exclude,glob)coverage/**',
    ':(exclude)coverage',
    ':(exclude,glob)**/playwright-report/**',
    ':(exclude,glob)playwright-report/**',
    ':(exclude)playwright-report',
    ':(exclude,glob)**/test-results/**',
    ':(exclude,glob)test-results/**',
    ':(exclude)test-results',
    ':(exclude,glob)**/*.tsbuildinfo',
    ':(exclude,glob)*.tsbuildinfo',
  ];
  // ALL lockfiles are excluded unconditionally regardless of package manager — OpenCode
  // is never trusted to mutate dependency state, so a regenerated lockfile must never
  // ride a delegated diff back into the real project.
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    excludes.push(`:(exclude,glob)**/${lock}`, `:(exclude)${lock}`);
  }
  return excludes;
}

export function removeWorktree(cwd: string, parent: string, wt: string): void {
  try { git(cwd, ['worktree', 'remove', '--force', wt]); } catch { /* best-effort */ }
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export type ApplyTargetBackup = {
  rel: string;
  abs: string;
  existed: boolean;
  backupPath?: string;
  createdParentDirs: string[];
};

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseNulPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

export function parseNameStatusZ(stdout: string): string[] {
  const fields = parseNulPaths(stdout);
  const paths: string[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    const first = fields[i++];
    if (first) paths.push(first);
    if (/^[RC]/.test(status)) {
      const second = fields[i++];
      if (second) paths.push(second);
    }
  }
  return uniquePaths(paths);
}

export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function isInsideRoot(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

function resolveRepoPath(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs !== root && isInsideRoot(root, abs) ? abs : null;
}

function pathExists(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function copyPath(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return;
  }
  if (stat.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true, force: true });
    return;
  }
  fs.copyFileSync(src, dst);
}

export function backupApplyTargets(cwd: string, targetPaths: string[], parent: string): ApplyTargetBackup[] {
  const root = path.resolve(cwd);
  const backupRoot = path.join(parent, 'pre-apply-backup');
  const backups: ApplyTargetBackup[] = [];
  for (const rel of uniquePaths(targetPaths)) {
    const abs = resolveRepoPath(root, rel);
    if (!abs) throw new Error(`unsafe patch path: ${rel}`);

    const createdParentDirs: string[] = [];
    if (!pathExists(abs)) {
      for (let cur = path.dirname(abs); cur !== root && isInsideRoot(root, cur) && !pathExists(cur); cur = path.dirname(cur)) {
        createdParentDirs.push(cur);
      }
      backups.push({ rel, abs, existed: false, createdParentDirs });
      continue;
    }

    const backupPath = path.join(backupRoot, String(backups.length));
    copyPath(abs, backupPath);
    backups.push({ rel, abs, existed: true, backupPath, createdParentDirs });
  }
  return backups;
}

export function restoreApplyTargets(backups: ApplyTargetBackup[]): string | null {
  const errors: string[] = [];
  for (const backup of backups) {
    try {
      fs.rmSync(backup.abs, { recursive: true, force: true });
      if (backup.existed && backup.backupPath) {
        copyPath(backup.backupPath, backup.abs);
      } else {
        for (const dir of backup.createdParentDirs) {
          try { fs.rmdirSync(dir); } catch { /* non-empty or already gone */ }
        }
      }
    } catch (err) {
      errors.push(`${backup.rel}: ${formatError(err)}`);
    }
  }
  return errors.length ? errors.join('; ') : null;
}
