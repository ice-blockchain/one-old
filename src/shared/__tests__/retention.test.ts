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

test('sweepTrafficOneRetention lists leaked nested roots only as explicit cleanup candidates', () => {
  withProject((dir) => {
    const memoryDir = '.traffic' + '-one';
    // The root must genuinely declare a workspace, so apps/web is a real sub-package
    // whose stray .one.json is a leak: resolveProjectRoot anchors it at the workspace
    // root, not at apps/web itself. Without this declaration apps/web would be an
    // independent project and must NOT be swept (see the next test).
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf8');
    const nested = path.join(dir, 'apps', 'web', memoryDir);
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');

    const dry = sweepTrafficOneRetention(dir, { dryRun: true });
    assert.ok(dry.actions.some((a) => a.path === nested));
    assert.equal(fs.existsSync(nested), true, 'dry-run preserves leaked root');

    const applied = sweepTrafficOneRetention(dir, { dryRun: false });
    assert.ok(applied.actions.some((a) => a.path === nested));
    assert.equal(fs.existsSync(nested), false);
  });
});

test('sweepTrafficOneRetention never deletes an independent nested onboarded project (no workspace ancestor)', () => {
  withProject((dir) => {
    const memoryDir = '.traffic' + '-one';
    // Parent is NOT a workspace (no pnpm-workspace.yaml / package.json workspaces), so
    // the nested project is its OWN independent root — resolveProjectRoot(sub) === sub.
    // It must never become a cleanup candidate (the data-loss case this guards).
    const nested = path.join(dir, 'sub', memoryDir);
    fs.mkdirSync(path.join(nested, 'runs', '9001'), { recursive: true });
    fs.writeFileSync(path.join(nested, '.one.json'), JSON.stringify({ mode: 'new-project', currentRunId: '9001' }), 'utf8');
    fs.writeFileSync(path.join(nested, 'product.md'), '# independent project memory', 'utf8');

    const dry = sweepTrafficOneRetention(dir, { dryRun: true });
    assert.ok(!dry.actions.some((a) => a.path === nested), 'independent nested project must not be a candidate');

    const applied = sweepTrafficOneRetention(dir, { dryRun: false });
    assert.ok(!applied.actions.some((a) => a.path === nested));
    assert.equal(fs.existsSync(path.join(nested, '.one.json')), true, 'independent nested .one.json preserved');
    assert.equal(fs.existsSync(path.join(nested, 'runs', '9001')), true, 'its runs preserved');
    assert.equal(fs.existsSync(path.join(nested, 'product.md')), true, 'its durable memory preserved');
  });
});
