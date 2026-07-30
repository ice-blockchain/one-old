import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { pruneTrafficOneBackups, sweepTrafficOneRetention } from '../retention';
import { reportBaseName } from '../../runners/lighthouse/lib';

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

test('sweepTrafficOneRetention TTL-sweeps per-run debug logs inside retained runs', () => {
  withProject((dir) => {
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: '2001' }), 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'retention.json'), JSON.stringify({ keepRuns: 5, backupKeep: 3, orphanTtlDays: 7 }), 'utf8');
    const debugDir = path.join(dir, '.traffic-one', 'runs', '2001', 'debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const stale = path.join(debugDir, 'claim-capture.jsonl');
    const fresh = path.join(debugDir, 'plan-guard-deny.jsonl');
    const sibling = path.join(dir, '.traffic-one', 'runs', '2001', 'run.json');
    fs.writeFileSync(stale, '{"old":true}\n', 'utf8');
    fs.writeFileSync(fresh, '{"new":true}\n', 'utf8');
    fs.writeFileSync(sibling, '{}', 'utf8');
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);
    fs.utimesSync(sibling, old / 1000, old / 1000);

    const applied = sweepTrafficOneRetention(dir, { dryRun: false });
    assert.ok(applied.removed >= 1);
    assert.equal(fs.existsSync(stale), false, 'stale run debug log swept despite retained run');
    assert.equal(fs.existsSync(fresh), true, 'fresh run debug log kept');
    assert.equal(fs.existsSync(sibling), true, 'non-debug run artifacts untouched by the TTL rule');
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

// A gitnexus bootstrap can run many times in one session and each run snapshots the
// same unchanged files; the SessionStart sweep is far too late to cap that.
test('pruneTrafficOneBackups enforces the cap at write time', () => {
  withProject((dir) => {
    const t1 = '.traffic' + '-one';
    fs.writeFileSync(path.join(dir, t1, 'retention.json'), JSON.stringify({ keepRuns: 2, backupKeep: 2, orphanTtlDays: 0 }), 'utf8');
    const stamps = ['2026-07-26T12-00-00Z', '2026-07-26T12-01-00Z', '2026-07-26T12-02-00Z', '2026-07-26T12-03-00Z'];
    for (const name of stamps) mkdir(dir, path.join(t1, 'backups', name));

    const removed = pruneTrafficOneBackups(dir, stamps[3]);
    const left = fs.readdirSync(path.join(dir, t1, 'backups')).sort();
    assert.equal(removed, 2);
    assert.deepEqual(left, [stamps[2], stamps[3]], 'the newest `backupKeep` snapshots survive');
  });
});

test('pruneTrafficOneBackups never drops the snapshot the caller may restore from', () => {
  withProject((dir) => {
    const t1 = '.traffic' + '-one';
    fs.writeFileSync(path.join(dir, t1, 'retention.json'), JSON.stringify({ keepRuns: 2, backupKeep: 0, orphanTtlDays: 0 }), 'utf8');
    for (const name of ['001', '002']) mkdir(dir, path.join(t1, 'backups', name));

    // backupKeep: 0 must still leave the restore path usable.
    pruneTrafficOneBackups(dir, '001');
    const left = fs.readdirSync(path.join(dir, t1, 'backups')).sort();
    assert.ok(left.includes('001'), 'the live snapshot is never a prune candidate');
    assert.ok(left.length >= 1);
  });
});

// The per-route Lighthouse rule had NO coverage at all, which is how it shipped
// correct but effectively dead: its only trigger was SessionStart, so a long
// build session accumulated six report pairs for one route (~14.7 MB reports
// dir, observed 10co) and nothing ever noticed.
function lighthouseReport(dir: string, t1: string, route: string, stamp: string): void {
  const base = path.join(dir, t1, 'reports', 'lighthouse');
  fs.mkdirSync(base, { recursive: true });
  for (const ext of ['report.json', 'report.html']) {
    fs.writeFileSync(path.join(base, `${route}-${stamp}.${ext}`), 'x', 'utf8');
  }
}

test('lighthouse reports are capped per ROUTE, keeping the newest pairs', () => {
  withProject((dir) => {
    const t1 = '.traffic' + '-one';
    fs.writeFileSync(
      path.join(dir, t1, 'retention.json'),
      JSON.stringify({ lighthouseKeepPerRoute: 2, orphanTtlDays: 3650 }),
      'utf8',
    );
    // Synthetic names must match what the runner actually writes; the shape is
    // pinned against reportBaseName so a rename there breaks this test.
    const shape = reportBaseName('http://127.0.0.1:4173/');
    assert.match(shape, /^home-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, 'reportBaseName shape changed');

    const homeStamps = [
      '2026-07-30T12-15-01-470Z', '2026-07-30T12-16-24-888Z', '2026-07-30T12-56-15-024Z',
      '2026-07-30T13-06-29-955Z', '2026-07-30T13-28-07-823Z', '2026-07-30T13-34-52-417Z',
    ];
    for (const stamp of homeStamps) lighthouseReport(dir, t1, 'home', stamp);
    lighthouseReport(dir, t1, 'courses', '2026-07-30T12-20-00-000Z');
    lighthouseReport(dir, t1, 'courses', '2026-07-30T12-40-00-000Z');
    assert.equal(fs.readdirSync(path.join(dir, t1, 'reports', 'lighthouse')).length, 16);

    sweepTrafficOneRetention(dir, { dryRun: false });

    const left = fs.readdirSync(path.join(dir, t1, 'reports', 'lighthouse')).sort();
    // Two pairs per route, and the survivors are the NEWEST — a run that keeps
    // measuring must not lose the report it just produced.
    assert.equal(left.filter((name) => name.startsWith('home-')).length, 4);
    assert.equal(left.filter((name) => name.startsWith('courses-')).length, 4);
    for (const stamp of homeStamps.slice(-2)) {
      assert.ok(left.includes(`home-${stamp}.report.json`), `newest home ${stamp} must survive`);
      assert.ok(left.includes(`home-${stamp}.report.html`), `newest home ${stamp} must survive`);
    }
    for (const stamp of homeStamps.slice(0, 4)) {
      assert.ok(!left.includes(`home-${stamp}.report.json`), `superseded home ${stamp} must go`);
    }
  });
});

test('a dry-run sweep never deletes a lighthouse report', () => {
  withProject((dir) => {
    const t1 = '.traffic' + '-one';
    fs.writeFileSync(
      path.join(dir, t1, 'retention.json'),
      JSON.stringify({ lighthouseKeepPerRoute: 1, orphanTtlDays: 3650 }),
      'utf8',
    );
    for (const stamp of ['2026-07-30T12-15-01-470Z', '2026-07-30T12-16-24-888Z']) {
      lighthouseReport(dir, t1, 'home', stamp);
    }
    const before = fs.readdirSync(path.join(dir, t1, 'reports', 'lighthouse')).sort();
    const result = sweepTrafficOneRetention(dir);
    assert.equal(result.removed, 0);
    assert.ok(result.actions.length > 0, 'the superseded pair is still reported as a candidate');
    assert.deepEqual(fs.readdirSync(path.join(dir, t1, 'reports', 'lighthouse')).sort(), before);
  });
});
