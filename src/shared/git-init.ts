// src/shared/git-init.ts
// Give a freshly-scaffolded project its initial git commit once the main build is
// complete. OpenCode delegation sandboxes every change in a git worktree, which
// requires a git HEAD — a never-committed scaffold makes the worker decline with
// "No git HEAD to sandbox the delegation", so without this the free quick-fix
// delegation could NEVER run on a new project and every trivial edit fell back to a
// paid worker. Strictly guarded + idempotent: only a git work tree with zero commits
// is touched (a repo with history is left alone), never the plugin's own repo, and
// any failure is swallowed (it just leaves OpenCode to keep declining as before).

import { exec } from './exec';
import { isPluginAuthoringRoot } from './authoring-root';

function git(root: string, args: readonly string[]): { code: number; stdout: string } {
  const r = exec.run('git', args, { cwd: root });
  return { code: r.code, stdout: r.stdout || '' };
}

// Returns true iff it created the initial commit. Best-effort — never throws.
// opts.initIfNeeded: when the path is NOT a git work tree yet, `git init` it first.
// Reserved for the new-project scaffold path (the user consented to Traffic One
// managing git via the build-time commit) — OpenCode delegation needs a repo+HEAD to
// sandbox, and a fresh scaffold may not be a repo at all. Off by default so the other
// callers never silently `git init` an intentionally un-versioned project.
export function ensureInitialCommit(root: string, opts: { initIfNeeded?: boolean } = {}): boolean {
  try {
    if (!root || isPluginAuthoringRoot(root)) return false;
    // Must be the top of a git work tree…
    if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') {
      if (!opts.initIfNeeded || git(root, ['init', '-q']).code !== 0) return false;
      if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return false;
    }
    // …with NO commits yet (a repo with history is never touched).
    if (git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).code === 0) return false;
    if (git(root, ['add', '-A']).code !== 0) return false;
    // Nothing staged (empty repo / everything gitignored) → no empty commit.
    if (!git(root, ['diff', '--cached', '--name-only']).stdout.trim()) return false;
    // `-c` sets the identity for THIS commit only, so it works on a machine with no
    // global git config; `--no-verify` skips pre-commit hooks that could block/stall.
    const commit = git(root, [
      '-c', 'user.name=Traffic One',
      '-c', 'user.email=noreply@traffic.io',
      'commit', '--no-verify', '-m', 'Initial commit',
    ]);
    return commit.code === 0;
  } catch {
    return false;
  }
}
