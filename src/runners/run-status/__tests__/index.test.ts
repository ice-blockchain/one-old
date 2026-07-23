import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { main, parseRunStatusArgs } from '../index';

test('parseRunStatusArgs accepts only bounded ledger vocabulary', () => {
  assert.deepEqual(parseRunStatusArgs([
    '--run-id', 'run-1', '--status', 'blocked', '--outcome', 'test-cycle-cap',
  ]), { runId: 'run-1', status: 'blocked', outcome: 'test-cycle-cap' });
  assert.equal(parseRunStatusArgs(['--run-id', 'run-1', '--status', 'done']), null);
  assert.equal(parseRunStatusArgs([
    '--run-id', 'run-1', '--status', 'active', '--reason', 'automatic-retry',
  ]), null);
});

test('run-status CLI persists validated transitions and rejects an unauthorized blocked resume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-'));
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(main(['--run-id', 'run-1', '--status', 'active'], root), 0);
    assert.equal(main([
      '--run-id', 'run-1', '--status', 'blocked', '--outcome', 'review-cycle-cap',
    ], root), 0);
    assert.equal(main(['--run-id', 'run-1', '--status', 'active'], root), 1);
    assert.equal(main([
      '--run-id', 'run-1', '--status', 'active', '--reason', 'user-authorized-extra-cycle',
    ], root), 0);
    const ledger = JSON.parse(fs.readFileSync(
      path.join(root, '.traffic-one', 'runs', 'run-1', 'run.json'),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.qaContractVersion, 1);
    assert.deepEqual(
      (ledger.transitionHistory as Array<Record<string, unknown>>).map((entry) => entry.to),
      ['active', 'blocked', 'active'],
    );
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('run-status CLI rejects completed outcomes until verification or shipper evidence exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-evidence-'));
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(main(['--run-id', 'run-2', '--status', 'active'], root), 0);
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'verified',
    ], root), 1, 'text-free completion is rejected');

    const digests = path.join(root, '.traffic-one', 'digests', 'run-2');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'backend.md'), '# backend\nBUILD_COMPLETE\n');
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# tester\nverdict: TESTS_GREEN\n');
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'verified',
    ], root), 0);
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'shipped',
    ], root), 1, 'verified is not synonymous with shipped');
    fs.writeFileSync(path.join(digests, 'shipper.md'), '# shipper\nverdict: SHIPPED\n');
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'shipped',
    ], root), 0);

    const ledger = JSON.parse(fs.readFileSync(
      path.join(root, '.traffic-one', 'runs', 'run-2', 'run.json'),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(ledger.status, 'completed');
    assert.equal(ledger.outcome, 'shipped');
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
