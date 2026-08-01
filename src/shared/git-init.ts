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
import { isNonProjectRoot } from './authoring-root';

function git(root: string, args: readonly string[]): { code: number; stdout: string } {
  const r = exec.run('git', args, { cwd: root });
  return { code: r.code, stdout: r.stdout || '' };
}

/** True iff this repo has no `origin` remote configured. */
function hasNoOriginRemote(root: string): boolean {
  return !git(root, ['remote']).stdout.split('\n').some((line) => line.trim() === 'origin');
}

/**
 * Give a remote-less repo a local `refs/remotes/origin/HEAD`.
 *
 * Some hosts inject a startup preamble into every spawned subagent that shells
 * out to `git diff --name-only origin/HEAD...` — Claude's built-in
 * `security-review` skill, which collides by name with the one this plugin ships
 * and which the reviewer role lists. On a Traffic One scaffold there is a repo
 * and a commit but never a remote, so that command exits non-zero and the host
 * kills the spawn BEFORE the agent produces a transcript: observed 18cl, where
 * the reviewer died twice and the run finished through a generic-worker
 * fallback. The failure is deterministic on every greenfield run.
 *
 * The orchestrator skill has carried a manual recovery recipe for this since
 * 1.0.4x, and 18cl is the measurement that a recipe is the wrong shape: the
 * agent read `fatal: ambiguous argument 'origin/HEAD...'` as "not a git
 * repository", concluded the recipe did not apply, and worked around it. A
 * condition this deterministic belongs to the runtime, not to a paragraph the
 * model has to match against an error string.
 *
 * Strictly guarded: a repo with a REAL `origin` is git's to manage and is never
 * touched, an existing ref is never overwritten, and every failure is swallowed.
 * Returns true iff it wrote the ref.
 */
export function ensureOriginHeadRef(root: string): boolean {
  try {
    if (!root || isNonProjectRoot(root)) return false;
    if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return false;
    if (!hasNoOriginRemote(root)) return false;
    if (git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD']).code === 0) return false;
    const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
    if (!head) return false;
    return git(root, ['update-ref', 'refs/remotes/origin/HEAD', head]).code === 0;
  } catch {
    return false;
  }
}

/**
 * Remove the ref `ensureOriginHeadRef` created, so a settled run leaves the
 * user's repo as it found it. The no-remote test is the ownership proof: once a
 * real `origin` exists the ref is git's, and this returns without touching it.
 */
export function removeOriginHeadRef(root: string): boolean {
  try {
    if (!root || isNonProjectRoot(root)) return false;
    if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') return false;
    if (!hasNoOriginRemote(root)) return false;
    if (git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD']).code !== 0) return false;
    return git(root, ['update-ref', '-d', 'refs/remotes/origin/HEAD']).code === 0;
  } catch {
    return false;
  }
}

// Returns true iff it created the initial commit. Best-effort — never throws.
// opts.initIfNeeded: when the path is NOT a git work tree yet, `git init` it first.
// Reserved for the new-project scaffold path (the user consented to Traffic One
// managing git via the build-time commit) — OpenCode delegation needs a repo+HEAD to
// sandbox, and a fresh scaffold may not be a repo at all. Off by default so the other
// callers never silently `git init` an intentionally un-versioned project.
export function ensureInitialCommit(root: string, opts: { initIfNeeded?: boolean } = {}): boolean {
  try {
    if (!root || isNonProjectRoot(root)) return false;
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
