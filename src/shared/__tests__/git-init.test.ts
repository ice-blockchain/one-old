import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { ensureInitialCommit } from '../git-init';

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
