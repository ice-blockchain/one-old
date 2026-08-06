// src/gen/lib/build-provenance.ts
// The identity stamp emitted into BOTH generated subtrees: dist/ (content —
// written by `npm run gen`) and dist/scripts/ (runtime — written by `npm run
// build`). A production plugin root is not one atomic artifact: the two
// subtrees are produced by two separate processes that can be run at
// different times against different checkouts. When they disagree — an old
// install's scripts/ mixed with a freshly-gen'd content tree, or vice versa —
// new gate logic silently runs against old prose/binaries (or the reverse).
//
// This is deliberately NOT a content-hash-vs-runtime-hash comparison: content
// and runtime are different bytes by construction (rules/**.md vs
// scripts/**.js), so hashing each subtree and comparing the two hashes would
// fire on every healthy install. Instead both copies carry the SAME identity,
// computed the same way from the same inputs — a healthy pair is
// byte-identical; a stale pair visibly disagrees.

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface BuildProvenance {
  readonly schema: 1;
  readonly gitSha: string | null;
  readonly sourceHash: string;
}

const GIT_HASH_PATTERN = /^[0-9a-f]{40}$/;

// No shell, no string interpolation into a command line — spawnSync with an
// argv array cannot be shell-injected. An installed plugin has no .git at
// all; git absent, a non-repo cwd, or any other failure all fall through to
// `null` rather than a fabricated value, which is the whole point: pretending
// to have a SHA would defeat the diagnostic this file exists for.
function runGit(sourceRoot: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync('git', args as string[], {
      cwd: sourceRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
    const value = result.status === 0 ? result.stdout.trim() : '';
    return GIT_HASH_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function resolveGitSha(sourceRoot: string): string | null {
  return runGit(sourceRoot, ['rev-parse', 'HEAD']);
}

// Same argv-array, no-shell discipline as runGit, for output that is not a
// hash. `null` means "git could not answer" (git absent, no .git, a non-repo
// cwd, any non-zero exit) — never "clean".
function runGitText(sourceRoot: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync('git', args as string[], {
      cwd: sourceRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
    return result.status === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

// True only when git POSITIVELY reports an unmodified working tree. Anything
// else is false, because HEAD's tree object may stand in for the working tree
// only where git has confirmed the two are the same bytes.
function workingTreeIsClean(sourceRoot: string): boolean {
  const status = runGitText(sourceRoot, ['status', '--porcelain']);
  return status !== null && status.trim() === '';
}

function listFilesSorted(dir: string, baseDir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesSorted(abs, baseDir));
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

// Hash every file under <sourceRoot>/src directly. This is the only thing
// that can tell two DIRTY checkouts apart, so it is what a dirty tree gets.
// It is deterministic as long as no source file changes between the two
// invocations — and when one does change between `gen` and `build`, the two
// subtrees really were produced from different sources, which is precisely
// the disagreement this stamp exists to surface.
function hashSourceTree(sourceRoot: string): string {
  const srcDir = path.join(sourceRoot, 'src');
  const hash = createHash('sha256');
  for (const rel of listFilesSorted(srcDir, sourceRoot)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(sourceRoot, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// The deterministic hash of the inputs THIS build actually read.
//
// `git rev-parse HEAD^{tree}` is the content-addressed hash of every tracked
// file at the last COMMIT — cheap, already maintained by git, and stable
// across the concurrent uncommitted edits that would otherwise make two
// build-provenance.json copies emitted moments apart disagree for no real
// reason. But it describes the commit, not the checkout: on its own it made
// `sourceHash` a second spelling of `gitSha` (both derived from HEAD), so two
// dists built from checkouts differing by a hundred uncommitted files carried
// identical values in both fields. A maintainer mid-work always has
// uncommitted changes, so the one case this stamp provably could not detect
// was the common one.
//
// So the tree object is used only where git has confirmed it IS the working
// tree. A dirty checkout — and any checkout git cannot vouch for, including
// one with no `.git` at all (a shallow export, an installed plugin) — hashes
// the working tree directly.
function computeSourceHash(sourceRoot: string): string {
  if (workingTreeIsClean(sourceRoot)) {
    const committedTree = runGit(sourceRoot, ['rev-parse', 'HEAD^{tree}']);
    if (committedTree) return committedTree;
  }
  return hashSourceTree(sourceRoot);
}

export function buildProvenance(sourceRoot: string): BuildProvenance {
  return {
    schema: 1,
    gitSha: resolveGitSha(sourceRoot),
    sourceHash: computeSourceHash(sourceRoot),
  };
}
