// src/shared/greenfield-evidence.ts
// "Is this project greenfield?" answered from the FILESYSTEM, in one place.
//
// `state.mode === 'new-project'` is a guess: `detectMode` fills it by counting
// files whose extension is in `SOURCE_EXTS`, so a 3-file Terraform stack, a dbt
// project, a docs site, an Elixir app and a 4-file published library with a
// COMMITTED `dist/` all read `new-project` (measured: seven shapes at 3–5
// files). Any consequential action taken on the strength of that guess is taken
// against somebody's real repository, so the guess gets a VETO with facts in it.
//
// Extracted from the `.gitignore` overreach fix in
// architecture-contract/scaffold-content.ts — which solved it first and still
// uses these — for the same reason shared/fs-nofollow.ts was: a second consumer
// appeared, and two copies of a predicate whose whole value is being
// conservative in the same way everywhere is exactly the drift that turns one
// of them back into a guess.
//
// Filesystem-only, no subprocess: this runs inside every hook, and the answer
// is one a git dir already holds verbatim.

import * as fs from 'fs';
import * as path from 'path';

// Git's own upward search for the repository that owns `projectRoot`: either the
// git dir we can inspect, or `unresolvable` — a `.git` that is plainly there and
// whose contents we cannot reach.
//
// It walks UP because a project root is very often a tracked SUBDIRECTORY of a
// repository: `bigrepo/web` of a published library whose `dist/` is committed
// and whose only `.gitignore` sits at the repo root has no `.git` of its own, so
// a root-only check reads exactly the dangerous shape as greenfield.
function resolveGitDir(projectRoot: string): string | null | 'unresolvable' {
  let cursor = path.resolve(projectRoot);
  for (;;) {
    const dotGit = path.join(cursor, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      // A worktree/submodule pointer file. Only git writes one, and neither a
      // linked worktree nor a submodule checkout can exist without commits — so
      // a pointer we cannot follow is a repository whose history is real and
      // simply out of reach, never an empty directory.
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
        return pointer ? path.resolve(cursor, pointer) : 'unresolvable';
      }
      return 'unresolvable'; // a socket/device at `.git`: unknowable, not absent
    } catch {
      // Absent, or not readable from here — keep walking.
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

// A LINKED worktree's git dir holds only its own HEAD; `refs/` live in the
// common dir it points at, so without this a worktree reads as ref-less.
function gitRefsRoot(gitDir: string): string {
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (commonDir) return path.resolve(gitDir, commonDir);
  } catch {
    // An ordinary git dir owns its own refs.
  }
  return gitDir;
}

// Any ref at all, loose or packed. Reached only when HEAD names a branch that
// does not exist yet, which is true both of a virgin repo (no refs anywhere)
// and of a repo mid-`checkout -b` on top of real history (refs elsewhere).
function hasAnyRef(refsRoot: string): boolean {
  try {
    const packed = fs.readFileSync(path.join(refsRoot, 'packed-refs'), 'utf8');
    if (packed.split(/\r?\n/).some((line) => /^[0-9a-f]{7,64}\s+\S/i.test(line))) return true;
  } catch {
    // No packed-refs file: loose refs are the only remaining evidence.
  }
  const walk = (dir: string, depth: number): boolean => {
    if (depth > 8) return false; // refs/ is shallow; this only bounds a symlink loop
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some((entry) => (entry.isDirectory()
      ? walk(path.join(dir, entry.name), depth + 1)
      : entry.isFile()));
  };
  return walk(path.join(refsRoot, 'refs'), 0);
}

/**
 * True when the repository that owns `projectRoot` has at least one commit.
 *
 * Read straight off the filesystem instead of through `git`: this answers a
 * question `HEAD` plus `refs/` already hold verbatim, and it runs inside every
 * hook — a subprocess per SessionStart is not a price worth paying for it.
 *
 * Fails toward TRUE. A git dir we cannot parse is a repository whose history we
 * cannot rule out, and the entire point of this predicate is that only positive
 * evidence may widen a block.
 */
export function hasCommittedHistory(projectRoot: string): boolean {
  const gitDir = resolveGitDir(projectRoot);
  if (gitDir === null) return false;
  if (gitDir === 'unresolvable') return true;
  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    // `git init` writes HEAD before anything else, and `git status` calls a
    // `.git` without one "not a git repository" — so this is a bare marker
    // directory, not a repo, and nothing is committed.
    return false;
  }
  if (/^[0-9a-f]{7,64}$/i.test(head)) return true; // a detached HEAD IS a commit
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return true; // a HEAD we cannot read: assume history
  const refsRoot = gitRefsRoot(gitDir);
  if (fs.existsSync(path.join(refsRoot, ref))) return true;
  return hasAnyRef(refsRoot);
}

/**
 * THE RULE — a project is greenfield when it has no `.gitignore` content AND
 * the repository that owns it has no commits. Both arms are facts on disk.
 *
 * Nothing here consults `state.mode`, `detectMode`, `SOURCE_EXTS` or a file
 * count, because every one of those answers `new-project` for a Terraform
 * stack, a dbt project, a docs site, an Elixir app, a shell-tooling repo, a
 * 3-file Go module with a COMMITTED `vendor/` and a 4-file published library
 * with a COMMITTED `dist/` — `detectMode` classifies by counting files whose
 * extension is in `SOURCE_EXTS`, and that list holds none of `.tf`, `.sql`,
 * `.md`, `.yml`, `.sh`, `.ex`, `.exs`, `.scala`, `.hs`, `.lua`, … (measured:
 * all seven shapes read `new-project` at 3–5 files).
 *
 * Why THESE two arms: they are the two ways a project can already have said
 * something about what git must ignore. A `.gitignore` is the statement itself.
 * A commit is the thing an ignore rule can silently shadow — git never untracks
 * what is already committed, so adding `vendor/` to a Go repo that commits
 * `go mod vendor` output breaks nothing on the day it happens and then drops
 * the NEXT new file under it, on the next clone, with no error anywhere near
 * Traffic One. Neither arm can be produced by a misclassification, and both
 * fail toward "not greenfield" when they cannot be read.
 *
 * A freshly `git init`-ed empty directory has a `.git` and no commits, and is
 * genuinely greenfield: that is why the arm is "no commits", not "no `.git`".
 *
 * `existingGitignore` must be the bytes the PROJECT wrote. Traffic One's own
 * managed region does not count as the project having stated anything, and any
 * caller that runs after materialization has to strip it (see
 * `projectOwnedGitignore`) or this predicate answers "not greenfield" for every
 * project Traffic One has already converged — including the genuinely
 * greenfield ones.
 */
export function greenfieldEvidence(projectRoot: string, existingGitignore: string): boolean {
  return existingGitignore.trim().length === 0 && !hasCommittedHistory(projectRoot);
}
