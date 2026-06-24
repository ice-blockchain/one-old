import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { sweepTrafficOneRetention } from '../retention';

function withProject(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-retention-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mkdir(dir: string, rel: string): void {
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
}

test('sweepTrafficOneRetention dry-run preserves current run and durable memory', () => {
  withProject((dir) => {
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: '1004' }), 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'product.md'), '# Product\nKeep me.', 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'retention.json'), JSON.stringify({ keepRuns: 2, backupKeep: 1, orphanTtlDays: 0 }), 'utf8');
    for (const id of ['1001', '1002', '1003', '1004']) {
      mkdir(dir, path.join('.traffic-one', 'runs', id));
      mkdir(dir, path.join('.traffic-one', 'digests', id));
      mkdir(dir, path.join('.traffic-one', 'reports', 'qa', id));
    }
    for (const name of ['001', '002']) mkdir(dir, path.join('.traffic-one', 'backups', name));
    fs.writeFileSync(path.join(dir, '.traffic-one', '.codegraph-build-lock'), 'old', 'utf8');
    mkdir(dir, path.join('.traffic-one', 'runs', '.once'));
    fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', '.once', 'marker'), 'x', 'utf8');

    const dry = sweepTrafficOneRetention(dir, { dryRun: true });
    assert.equal(dry.removed, 0);
    assert.ok(dry.actions.some((a) => a.path.endsWith(path.join('.traffic-one', 'runs', '1001'))));
    assert.ok(!dry.actions.some((a) => a.path.endsWith(path.join('.traffic-one', 'runs', '1004'))));
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'product.md')), true);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', '1001')), true, 'dry-run does not delete');

    const applied = sweepTrafficOneRetention(dir, { dryRun: false });
    assert.ok(applied.removed > 0);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', '1001')), false);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', '1001')), false);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', '1004')), true);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'product.md')), true);
  });
});
