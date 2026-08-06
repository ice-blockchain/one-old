import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildProvenance } from '../lib/build-provenance';

// Per-invocation `-c` overrides only: a throwaway fixture repo must not depend
// on (or touch) the machine's git identity or signing config.
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', [
    '-c', 'user.name=Traffic One Test',
    '-c', 'user.email=test@traffic-one.invalid',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function seedRepo(root: string, sourceText: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), sourceText, 'utf8');
  git(root, 'init', '--initial-branch=main');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'seed');
}

test('a clean checkout stamps git\'s own HEAD tree object', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-provenance-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedRepo(root, 'export const a = 1;\n');

  const stamp = buildProvenance(root);
  assert.equal(stamp.gitSha, git(root, 'rev-parse', 'HEAD'));
  assert.equal(stamp.sourceHash, git(root, 'rev-parse', 'HEAD^{tree}'));
});

// The defect this file exists to prevent: sourceHash was ALWAYS
// `HEAD^{tree}`, so it was a second spelling of gitSha. Two dists built from
// checkouts that differ by uncommitted work carried identical values in both
// fields — and a maintainer mid-work always has uncommitted work, so the one
// state this stamp provably could not describe was the everyday one.
test('uncommitted work changes sourceHash while gitSha stays on HEAD', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-provenance-dirty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedRepo(root, 'export const a = 1;\n');
  const clean = buildProvenance(root);

  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
  const dirty = buildProvenance(root);

  assert.equal(dirty.gitSha, clean.gitSha, 'gitSha still names the commit, by design');
  assert.notEqual(dirty.sourceHash, clean.sourceHash);
  assert.notEqual(dirty.sourceHash, git(root, 'rev-parse', 'HEAD^{tree}'));

  // An untracked source file counts too — it is source this build read.
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 3;\n', 'utf8');
  assert.notEqual(buildProvenance(root).sourceHash, dirty.sourceHash);
});

test('two checkouts at the same commit but different working trees do not collide', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-provenance-pair-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const left = path.join(parent, 'left');
  const right = path.join(parent, 'right');
  fs.mkdirSync(left);
  fs.mkdirSync(right);
  seedRepo(left, 'export const a = 1;\n');
  git(parent, 'clone', left, right);

  fs.writeFileSync(path.join(right, 'src', 'a.ts'), 'export const a = 99;\n', 'utf8');
  const leftStamp = buildProvenance(left);
  const rightStamp = buildProvenance(right);

  assert.equal(leftStamp.gitSha, rightStamp.gitSha, 'same commit');
  assert.notEqual(
    leftStamp.sourceHash,
    rightStamp.sourceHash,
    'the whole point: subtrees built against different checkouts must not stamp the same identity',
  );
});

test('a checkout with no git falls through to the working-tree hash, never a fabricated sha', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-provenance-nogit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');

  const stamp = buildProvenance(root);
  assert.equal(stamp.gitSha, null);
  assert.match(stamp.sourceHash, /^[0-9a-f]{64}$/);

  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');
  assert.notEqual(buildProvenance(root).sourceHash, stamp.sourceHash);
});

test('the same inputs stamp the same identity twice — gen and build must agree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-provenance-stable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  seedRepo(root, 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n', 'utf8');

  assert.deepEqual(buildProvenance(root), buildProvenance(root));
});
