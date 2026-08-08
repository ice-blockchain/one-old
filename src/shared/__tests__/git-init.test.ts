import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { ensureInitialCommit, ensureOriginHeadRef, removeOriginHeadRef } from '../git-init';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-gitinit-')));
}
function git(cwd: string, args: string[]): string {
  // Identity injected per-call so these tests don't depend on global git config.
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

test('ensureInitialCommit: fresh git repo with no commits → creates the initial commit', () => {
  const dir = tmp();
  try {
    git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n', 'utf8');
    assert.equal(ensureInitialCommit(dir), true, 'commit created');
    assert.ok(git(dir, ['rev-parse', '--verify', 'HEAD']).trim().length >= 7, 'HEAD now resolves');
    assert.ok(git(dir, ['ls-files']).includes('index.ts'), 'the scaffold file is tracked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureInitialCommit: repo that already has commits → no-op (returns false, no new commit)', () => {
  const dir = tmp();
  try {
    git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n', 'utf8');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'first']);
    const before = git(dir, ['rev-list', '--count', 'HEAD']).trim();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n', 'utf8'); // uncommitted change present
    assert.equal(ensureInitialCommit(dir), false, 'a repo with history is left alone');
    assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).trim(), before, 'no extra commit created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureInitialCommit: non-git directory → no-op (returns false, no repo created)', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'x.ts'), 'export const x = 1;\n', 'utf8');
    assert.equal(ensureInitialCommit(dir), false);
    assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'never inits a repo on its own');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureInitialCommit: fresh repo with nothing to stage → no empty commit', () => {
  const dir = tmp();
  try {
    git(dir, ['init', '-q']);
    assert.equal(ensureInitialCommit(dir), false, 'nothing staged → no empty initial commit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureInitialCommit: initIfNeeded git-inits a non-git dir then commits (new-project scaffold path)', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'x.ts'), 'export const x = 1;\n', 'utf8');
    // Default: a non-git dir is left alone (never silently `git init`).
    assert.equal(ensureInitialCommit(dir), false, 'default leaves a non-git dir untouched');
    assert.equal(fs.existsSync(path.join(dir, '.git')), false);
    // Opt-in: initialize the repo and commit the scaffold.
    assert.equal(ensureInitialCommit(dir, { initIfNeeded: true }), true);
    assert.equal(fs.existsSync(path.join(dir, '.git')), true, 'repo initialized');
    assert.ok(git(dir, ['rev-parse', '--verify', 'HEAD']).trim().length >= 7, 'HEAD now resolves');
    assert.ok(git(dir, ['ls-files']).includes('x.ts'), 'the scaffold file is committed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureInitialCommit: never auto-commits the plugin authoring root', () => {
  const dir = tmp();
  try {
    git(dir, ['init', '-q']);
    // Authoring-root markers: package name "traffic-one" + src/gen/index.ts.
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'gen', 'index.ts'), '// gen\n', 'utf8');
    assert.equal(ensureInitialCommit(dir), false, 'the plugin repo is never auto-committed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A git that never answers must not be read AS an answer.
//
// `git rev-parse --verify --quiet HEAD` returns exit 1 to mean "this repo has no
// commits", and before exec.runResult existed a hung, killed or missing git came
// back as exit 1 too. Those are the same value with opposite consequences: the
// first is the precondition for committing, the second is a repo whose history we
// simply failed to see. exec.run also had no timeout at all, so the real
// pre-change behaviour of this path against a wedged git was to block the hook
// forever rather than to misread it.
//
// The shim answers the work-tree probe honestly and hangs only on the HEAD probe,
// so what is under test is the ONE call whose exit 1 is ambiguous.
test('ensureInitialCommit: a hung `git rev-parse HEAD` is not read as "no commits"', () => {
  const dir = tmp();
  const shimDir = tmp();
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shim = path.join(shimDir, 'git');
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'case "$*" in',
    // Long enough that only the bound can end it: GIT_PROBE_TIMEOUT_MS is 3 s.
    '  *"--verify --quiet HEAD"*) sleep 30 ;;',
    `  *) exec ${JSON.stringify(realGit)} "$@" ;;`,
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const path0 = process.env.PATH;
  try {
    git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, 'x.ts'), 'export {};\n', 'utf8');
    process.env.PATH = `${shimDir}${path.delimiter}${path0 ?? ''}`;

    const started = Date.now();
    const created = ensureInitialCommit(dir);
    const elapsed = Date.now() - started;
    process.env.PATH = path0;

    assert.equal(created, false, 'a probe that did not answer must not authorize a commit');
    // Bounded at all: without a timeout on exec this call does not return.
    assert.ok(elapsed < 30_000, `the probe was not bounded — ensureInitialCommit took ${elapsed} ms`);
    // And the tree is untouched, which is the consequence the boolean stands for.
    assert.throws(() => git(dir, ['rev-parse', '--verify', 'HEAD']), 'no commit was created');
    assert.equal(git(dir, ['diff', '--cached', '--name-only']).trim(), '', 'nothing was staged either');
  } finally {
    process.env.PATH = path0;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

// A host preamble that shells out to `git diff … origin/HEAD…` exits non-zero on
// a remote-less scaffold and the host kills the spawn before the agent produces
// a transcript (18cl: the reviewer died twice, the run finished through a
// generic-worker fallback). Deterministic on every greenfield run.
test('ensureOriginHeadRef: a remote-less repo gets the ref, and settlement takes it back', () => {
  const dir = tmp();
  try {
    git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, 'x.ts'), 'export {};\n', 'utf8');
    assert.equal(ensureInitialCommit(dir), true);

    // Reproduces the exact 18cl failure before the fix — note the message is
    // `ambiguous argument`, NOT "not a git repository": the agent misread it,
    // decided the documented recovery recipe did not apply, and worked around it.
    assert.throws(() => git(dir, ['diff', '--name-only', 'origin/HEAD...']), /ambiguous argument/);

    assert.equal(ensureOriginHeadRef(dir), true);
    assert.equal(
      git(dir, ['rev-parse', 'refs/remotes/origin/HEAD']).trim(),
      git(dir, ['rev-parse', 'HEAD']).trim(),
      'the ref points at the run-start commit',
    );
    // The command that killed the spawn now succeeds.
    assert.equal(git(dir, ['diff', '--name-only', 'origin/HEAD...']).trim(), '');
    // Idempotent: a second run neither rewrites nor reports a write.
    assert.equal(ensureOriginHeadRef(dir), false, 'an existing ref is never overwritten');

    assert.equal(removeOriginHeadRef(dir), true);
    assert.throws(() => git(dir, ['rev-parse', '--verify', 'refs/remotes/origin/HEAD']));
    assert.equal(removeOriginHeadRef(dir), false, 'removing what is not there is a no-op');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureOriginHeadRef: a repo with a REAL origin is never touched, in either direction', () => {
  const dir = tmp();
  const remote = tmp();
  try {
    git(remote, ['init', '-q', '--bare']);
    git(dir, ['init', '-q']);
    fs.writeFileSync(path.join(dir, 'x.ts'), 'export {};\n', 'utf8');
    assert.equal(ensureInitialCommit(dir), true);
    git(dir, ['remote', 'add', 'origin', remote]);

    // Writing is refused: once a remote exists the ref is git's to manage, and a
    // ref we invented would silently shadow the real upstream.
    assert.equal(ensureOriginHeadRef(dir), false, 'a real origin is never given a fabricated ref');
    assert.throws(() => git(dir, ['rev-parse', '--verify', 'refs/remotes/origin/HEAD']));

    // And deleting is refused too — the dangerous direction. A run that adopts a
    // repo which HAS an upstream must not remove that repo's own ref at
    // settlement, so ownership is re-proven at cleanup rather than remembered.
    git(dir, ['update-ref', 'refs/remotes/origin/HEAD', git(dir, ['rev-parse', 'HEAD']).trim()]);
    assert.equal(removeOriginHeadRef(dir), false, 'a real repo never loses its own ref to our cleanup');
    assert.ok(git(dir, ['rev-parse', '--verify', 'refs/remotes/origin/HEAD']).trim().length >= 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});
