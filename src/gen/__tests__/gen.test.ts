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
    assert.ok(fs.existsSync(path.join(dir, '.cursor', 'rules', '00-auth-required.mdc')));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'package.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'src')));

    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift, [], `generated plugin drifted: ${check.drift.join(', ')}`);
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
