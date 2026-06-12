import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { distRoot, runGen } from '../index';
import { GenRun } from '../lib/run';
import { emitManifests, emitMcp } from '../emit/manifests';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('runGen writes a generated plugin root and --check round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-plugin-'));
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.ok(write.written.length > 250, `expected generated plugin files, got ${write.written.length}`);
    assert.ok(fs.existsSync(path.join(dir, '.codex-plugin', 'plugin.json')));
    // The auth gate ships as the generated kernel rule; no static 00- seed copy.
    assert.ok(!fs.existsSync(path.join(dir, '.cursor', 'rules', '00-auth-required.mdc')));
    assert.ok(fs.existsSync(path.join(dir, '.cursor', 'rules', 'auth-required.mdc')));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'package.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'src')));

    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift, [], `generated plugin drifted: ${check.drift.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gen sweeps orphaned files in managed output dirs (deleted source content)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-orphan-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const orphanRule = path.join(dir, 'rules', 'common', 'retired-rule.md');
    const orphanMdc = path.join(dir, '.cursor', 'rules', 'retired-rule.mdc');
    fs.writeFileSync(orphanRule, '# Retired\n', 'utf8');
    fs.writeFileSync(orphanMdc, '---\nalwaysApply: false\n---\n', 'utf8');

    // check mode reports orphans as drift without touching them.
    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift.sort(), [
      '.cursor/rules/retired-rule.mdc (orphan: no longer generated)',
      'rules/common/retired-rule.md (orphan: no longer generated)',
    ]);
    assert.ok(fs.existsSync(orphanRule));

    // write mode prunes them.
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(write.pruned.sort(), ['.cursor/rules/retired-rule.mdc', 'rules/common/retired-rule.md']);
    assert.ok(!fs.existsSync(orphanRule));
    assert.ok(!fs.existsSync(orphanMdc));

    // and the tree round-trips clean again.
    const recheck = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(recheck.drift, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emitManifests produces all five manifests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-manifests-'));
  try {
    const write = new GenRun({ check: false, root: dir, sourceRoot: REPO_ROOT });
    emitManifests(write);
    emitMcp(write);
    assert.equal(write.written.length, 6);

    const check = new GenRun({ check: true, root: dir, sourceRoot: REPO_ROOT });
    emitManifests(check);
    emitMcp(check);
    assert.deepEqual(check.drift, []);
    assert.equal(check.written.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('distRoot points generation at dist under the source checkout by default', () => {
  assert.equal(distRoot(REPO_ROOT), path.join(REPO_ROOT, 'dist'));
});

test('GenRun.json writes canonical 2-space JSON with a trailing newline; --check round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-'));
  try {
    const sample = { b: 1, a: [1, 2] };
    const write = new GenRun({ check: false, root: dir });
    write.json('nested/x.json', sample);
    assert.deepEqual(write.written, ['nested/x.json']);
    const onDisk = fs.readFileSync(path.join(dir, 'nested', 'x.json'), 'utf8');
    assert.equal(onDisk, `${JSON.stringify(sample, null, 2)}\n`);
    // Re-checking the just-written file reports no drift (idempotent).
    const check = new GenRun({ check: true, root: dir });
    check.json('nested/x.json', sample);
    assert.deepEqual(check.drift, []);
    // A different value drifts.
    const check2 = new GenRun({ check: true, root: dir });
    check2.json('nested/x.json', { b: 2 });
    assert.deepEqual(check2.drift, ['nested/x.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dist AGENTS.md/CLAUDE.md ship the end-user plugin instructions, not the maintainer guide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-agents-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gen', 'static', 'plugin-instructions.md'), 'utf8');
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), source);
    // The maintainer guide (repo root AGENTS.md) must never ship.
    assert.ok(!fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('Stand Down'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
