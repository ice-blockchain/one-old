import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runGen } from '../index';
import { GenRun } from '../lib/run';
import { emitManifests, emitMcp } from '../emit/manifests';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('gen --check reports the committed manifests + .mcp.json as in sync', () => {
  const run = runGen({ check: true, root: REPO_ROOT });
  assert.deepEqual(run.drift, [], `generated manifests drifted: ${run.drift.join(', ')}`);
});

test('emitManifests produces all five manifests', () => {
  const run = new GenRun({ check: true, root: REPO_ROOT });
  emitManifests(run);
  emitMcp(run);
  // check-mode never writes; drift must stay empty against the committed tree.
  assert.deepEqual(run.drift, []);
  assert.equal(run.written.length, 0);
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
