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

/**
 * Bound for the READ-ONLY git probes below.
 *
 * BORROWED: 3_000 ms is the bound this repo already puts on a git read reached
 * from a hook, at twelve sites across shared/verification-contract/git.ts,
 * shared/architecture-contract/baseline.ts and shared/maintenance/fallback.ts.
 * Measured headroom on the probes it is applied to here: the slowest was 13.00
 * ms, on a synthetic 3000-file tree — 230x inside the bound. The WRITES
 * (`init`, `add -A`, `commit`, `update-ref`) deliberately keep exec.ts's
 * EXEC_DEFAULT_TIMEOUT_MS instead, because their cost scales with the tree
 * (measured: `git add -A` at 0.463 ms/file, 1405.22 ms at 3000 files) and 3 s
 * would start refusing legitimate scaffolds somewhere past 6,000 files.
 */
const GIT_PROBE_TIMEOUT_MS = 3_000;

function git(root: string, args: readonly string[]): { code: number; stdout: string } {
  const r = exec.run('git', args, { cwd: root });
  return { code: r.code, stdout: r.stdout || '' };
}

/**
 * A read-only probe whose ANSWER is distinguishable from its failure.
 *
 * Every caller below branches on `code === 0` vs `!== 0`, and for these
 * commands a non-zero exit is a real answer ("no such ref", "not a work
 * tree"). `exec.run` reports a timeout, a kill and a missing binary as `code:
 * 1` too, which is the same value `git rev-parse --verify --quiet HEAD` returns
 * to mean "this repo has no commits" — so a git that hung would have read as a
 * HEAD-less repo and this file would have gone on to `git add -A` and commit.
 * `runResult` is what makes those separable: `exited` carries an answer,
 * anything else carries none.
 */
function gitProbe(root: string, args: readonly string[]): { answered: boolean; code: number; stdout: string } {
  const outcome = exec.runResult('git', args, { cwd: root, timeoutMs: GIT_PROBE_TIMEOUT_MS });
  return outcome.kind === 'exited'
    ? { answered: true, code: outcome.code, stdout: outcome.stdout || '' }
    : { answered: false, code: 1, stdout: '' };
}

/** True iff this repo has no `origin` remote configured, and we could tell. */
function hasNoOriginRemote(root: string): boolean {
  const probe = gitProbe(root, ['remote']);
  if (!probe.answered) return false;
  return !probe.stdout.split('\n').some((line) => line.trim() === 'origin');
}

/** True iff `root` is the top of a git work tree, and we could tell. */
function isWorkTree(root: string): boolean {
  const probe = gitProbe(root, ['rev-parse', '--is-inside-work-tree']);
  return probe.answered && probe.stdout.trim() === 'true';
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
    if (!isWorkTree(root)) return false;
    if (!hasNoOriginRemote(root)) return false;
    const existing = gitProbe(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD']);
    if (!existing.answered || existing.code === 0) return false;
    const head = gitProbe(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!head.answered || !head.stdout.trim()) return false;
    return git(root, ['update-ref', 'refs/remotes/origin/HEAD', head.stdout.trim()]).code === 0;
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
    if (!isWorkTree(root)) return false;
    if (!hasNoOriginRemote(root)) return false;
    const existing = gitProbe(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD']);
    if (!existing.answered || existing.code !== 0) return false;
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
    if (!isWorkTree(root)) {
      if (!opts.initIfNeeded || git(root, ['init', '-q']).code !== 0) return false;
      if (!isWorkTree(root)) return false;
    }
    // …with NO commits yet (a repo with history is never touched). A probe that
    // did not ANSWER must not be read as "no commits": that is the reading that
    // would commit on top of a repo whose history we simply failed to see.
    const head = gitProbe(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!head.answered || head.code === 0) return false;
    if (git(root, ['add', '-A']).code !== 0) return false;
    // Nothing staged (empty repo / everything gitignored) → no empty commit.
    const staged = gitProbe(root, ['diff', '--cached', '--name-only']);
    if (!staged.answered || !staged.stdout.trim()) return false;
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
