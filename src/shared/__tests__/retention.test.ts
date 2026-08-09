import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { pruneTrafficOneBackups, sweepAfterTerminalSettlement, sweepTrafficOneRetention } from '../retention';
import { runLiveClaimEvidence } from '../run-settlement';
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

test('default policy is 3 runs / 1 backup / 3-day TTL / 1 Lighthouse pair per route (12co audit)', () => {
  withProject((dir) => {
    // No retention.json → the defaults apply.
    const result = sweepTrafficOneRetention(dir, { dryRun: true });
    assert.deepEqual(result.policy, {
      keepRuns: 3,
      backupKeep: 1,
      orphanTtlDays: 3,
      lighthouseKeepPerRoute: 1,
    });
  });
});

test('sweepAfterTerminalSettlement sweeps for real but never touches the current run', () => {
  withProject((dir) => {
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: '1004' }), 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'retention.json'), JSON.stringify({ keepRuns: 1, backupKeep: 1, orphanTtlDays: 3650 }), 'utf8');
    for (const id of ['1001', '1002', '1003', '1004']) {
      mkdir(dir, path.join('.traffic-one', 'digests', id));
    }
    sweepAfterTerminalSettlement(dir);
    // keepRuns:1 → current (1004) + the newest non-current window survive; the rest are removed for real.
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', '1004')), true, 'current run is protected');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', '1001')), false, 'superseded run is reclaimed');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', '1002')), false, 'superseded run is reclaimed');
  });
  // Never throws, even on a directory that is not a project at all.
  sweepAfterTerminalSettlement(path.join(os.tmpdir(), 't1-retention-does-not-exist'));
});

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

// Membership heal + its data-loss fence. Stray state inside a real repo (observed:
// mercury/strategies got a full new-project state inside a Go repo) must become a
// cleanup candidate, while every genuine repo root must be structurally unsweepable.
test('sweepTrafficOneRetention heals stray state inside a repo but never touches a repo root', () => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-retention-member-')));
  const memoryDir = '.traffic' + '-one';
  try {
    // Two independently-onboarded sibling repos under a marker-less container.
    const repos = ['mercury', 'agora'].map((name) => {
      const repo = path.join(container, name);
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'go.mod'), `module ${name}\n`, 'utf8');
      fs.mkdirSync(path.join(repo, memoryDir), { recursive: true });
      fs.writeFileSync(path.join(repo, memoryDir, '.one.json'),
        JSON.stringify({ mode: 'existing-codebase', stack: 'custom-backend' }), 'utf8');
      return repo;
    });
    // A stray root inside one of them: owns no marker, belongs to `mercury`.
    const stray = path.join(repos[0]!, 'strategies', memoryDir);
    fs.mkdirSync(path.join(stray, 'runs', '9001'), { recursive: true });
    fs.writeFileSync(path.join(stray, '.one.json'), JSON.stringify({ mode: 'new-project' }), 'utf8');

    const dry = sweepTrafficOneRetention(container, { dryRun: true });
    assert.ok(dry.actions.some((a) => a.path === stray), 'stray state inside a repo IS a candidate');
    for (const repo of repos) {
      const own = path.join(repo, memoryDir);
      assert.ok(!dry.actions.some((a) => a.path === own),
        `${path.basename(repo)} owns .git — it must never be a candidate`);
    }

    sweepTrafficOneRetention(container, { dryRun: false });
    assert.equal(fs.existsSync(stray), false, 'the stray root is healed away');
    for (const repo of repos) {
      assert.equal(fs.existsSync(path.join(repo, memoryDir, '.one.json')), true,
        `${path.basename(repo)} state preserved`);
    }
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
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

// ── liveness ────────────────────────────────────────────────────────────────
// The keep set used to be pure RECENCY: `keepRunIds` built its set from
// currentRunId, protectRunIds and the newest N, and nothing anywhere in the
// sweep asked whether a run was still ALIVE. Measured on the realistic 9-run
// fixture these tests are cut down from, that reclaimed 5 runs of which 2 still
// held live claims — and because claim resolution walks every run on disk
// (runIdsForLookup), deleting a live run's directory demotes a working agent to
// `no-claim` and the gates begin refusing its writes.
//
// Every test below asserts a BASELINE first — "this run IS reclaimable before I
// make it live" — so a fixture that silently stopped reaching the sweep fails
// instead of passing vacuously.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Run ids ARE epoch-ms mint stamps in the runtime, and the keep set now reads
// them as a birth time, so these fixtures cannot use the short synthetic ids the
// tests above use. `Date.now()` rather than an injected clock because the claim
// scan being consumed (run-settlement/io.ts -> timestampAgeMs) reads the real
// wall clock and cannot be steered by the sweep's `nowMs`.
const NOW = Date.now();
function runIdAged(ageMs: number): string {
  return String(NOW - ageMs);
}

function seedRun(
  dir: string,
  id: string,
  opts: { ledger?: Record<string, unknown>; claims?: number; claimAgeMs?: number; architecture?: boolean } = {},
): void {
  const t1 = '.traffic' + '-one';
  const runDir = path.join(dir, t1, 'runs', id);
  fs.mkdirSync(path.join(runDir, 'pending'), { recursive: true });
  fs.mkdirSync(path.join(dir, t1, 'digests', id), { recursive: true });
  if (opts.ledger) fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(opts.ledger), 'utf8');
  if (opts.architecture !== false) fs.writeFileSync(path.join(runDir, 'architecture-v1.json'), '{}', 'utf8');
  // A claim only counts as active while it is fresh (SUBAGENT_STALE_MS), which
  // is what makes `claimAgeMs` the whole experiment in the expiry test below.
  for (let index = 0; index < (opts.claims || 0); index += 1) {
    fs.writeFileSync(
      path.join(runDir, 'pending', `claim-${index}.json`),
      JSON.stringify({
        role: 'frontend',
        runId: id,
        status: 'claimed',
        updatedAt: new Date(Date.now() - (opts.claimAgeMs ?? 30 * 1000)).toISOString(),
      }),
      'utf8',
    );
  }
}

function project(dir: string, currentRunId: string, policy: Record<string, unknown>): void {
  const t1 = '.traffic' + '-one';
  fs.writeFileSync(path.join(dir, t1, '.one.json'), JSON.stringify({ mode: 'existing-codebase', currentRunId }), 'utf8');
  fs.writeFileSync(path.join(dir, t1, 'retention.json'), JSON.stringify(policy), 'utf8');
}

function reclaims(dir: string, id: string): boolean {
  const target = path.join(dir, '.traffic' + '-one', 'runs', id);
  return sweepTrafficOneRetention(dir, { dryRun: true, nowMs: NOW })
    .actions.some((action) => action.path === target);
}

function reportsLive(dir: string, id: string): boolean {
  return sweepTrafficOneRetention(dir, { dryRun: true, nowMs: NOW }).liveRunIds.includes(id);
}

test('a run holding live claims is never reclaimed, even far outside the newest-N window', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const old = runIdAged(6 * HOUR);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, runIdAged(2 * HOUR), { ledger: { status: 'active' } });
    // Non-terminal but far past the mint window, so ONLY a live claim can save
    // it: this isolates the claim rule from the ledger rule.
    seedRun(dir, old, { ledger: { status: 'active' } });

    assert.equal(reclaims(dir, old), true, 'baseline: the old run must be reclaimable before it is made live');
    assert.equal(reportsLive(dir, old), false, 'baseline: the old run is not live yet');

    seedRun(dir, old, { ledger: { status: 'active' }, claims: 2 });
    assert.equal(reclaims(dir, old), false, 'a run holding live claims must never be reclaimed');
    assert.equal(reportsLive(dir, old), true, 'the sweep must report WHY the run survived');
  });
});

// The design point: liveness is RESERVED outside `policy.keepRuns`, exactly as
// protectRunIds is, so a live run cannot crowd out the newest-N. Charging it to
// the budget would trade one wrong deletion for a different one.
test('a live run is reserved outside the keepRuns budget, never charged to it', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const recent = runIdAged(20 * MINUTE);
    const older = runIdAged(90 * MINUTE);
    const live = runIdAged(8 * HOUR);
    project(dir, current, { keepRuns: 2, orphanTtlDays: 3650 });
    for (const id of [current, recent, older, live]) {
      seedRun(dir, id, { ledger: { status: 'completed', outcome: 'verified' } });
    }

    assert.equal(reclaims(dir, older), false, 'baseline: the second-newest run is inside the keepRuns window');
    assert.equal(reclaims(dir, live), true, 'baseline: the oldest run is outside it');

    seedRun(dir, live, { ledger: { status: 'completed', outcome: 'verified' }, claims: 1 });
    assert.equal(reclaims(dir, live), false, 'the live run is retained');
    // The discriminating assertion. If liveness CONSUMED the budget, keepRuns:2
    // would now be spent on {current, live} and this run would be evicted.
    assert.equal(reclaims(dir, older), false, 'a live run must not evict a run the newest-N budget already kept');
    assert.equal(reclaims(dir, recent), false, 'nor the newest non-current run');
  });
});

// Ambiguous cell 1: live claims + a TERMINAL ledger. The ledger records a
// verdict about the PAST; a fresh claim is evidence about the PRESENT. Both
// run-settle.ts and runCompletionEvidenceAllows refuse to reach terminal while
// claims are live, so this combination is already an anomaly — and the
// reversible choice in an anomaly is to keep.
test('live claims outrank a TERMINAL ledger: settlement does not license deletion', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const settled = runIdAged(5 * HOUR);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, runIdAged(2 * HOUR), { ledger: { status: 'completed', outcome: 'verified' } });
    seedRun(dir, settled, { ledger: { status: 'completed', outcome: 'verified' } });

    assert.equal(reclaims(dir, settled), true, 'baseline: a settled run with no claims is reclaimable');

    seedRun(dir, settled, { ledger: { status: 'completed', outcome: 'verified' }, claims: 1 });
    assert.equal(reclaims(dir, settled), false, 'a terminal ledger must not license deleting a run with live claims');
    assert.equal(reportsLive(dir, settled), true, 'and it is reported as live, not merely recent');
  });
});

// Ambiguous cell 2: a non-terminal ledger with NO claims. Protected only inside
// the mint window — a run minted seconds ago has not written its first claim yet
// and is at its most fragile. Past that window this is the ABANDONED run the
// orphan rule was written for (observed 8cl: `status: active` forever), and
// protecting it unconditionally would make it immortal.
test('a non-terminal ledger protects a freshly minted run but never an abandoned one', () => {
  withProject((dir) => {
    // currentRunId deliberately points at an OLDER run: the 8cl shape, where a
    // sibling run is minted while `.one.json` stays behind. Two runs NEWER than
    // the subject push it out of the newest-N window under keepRuns:1, so the
    // ledger is the only thing that can save it.
    const current = runIdAged(3 * HOUR);
    const minted = runIdAged(90 * 1000);
    const newer = runIdAged(20 * 1000);
    const newest = runIdAged(10 * 1000);
    const abandoned = runIdAged(4 * DAY);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    for (const id of [newest, newer]) {
      seedRun(dir, id, { ledger: { status: 'completed', outcome: 'verified' } });
    }
    // Baseline via a TERMINAL ledger: fresh, but nothing claims it is in flight.
    seedRun(dir, minted, { ledger: { status: 'completed', outcome: 'verified' } });
    seedRun(dir, abandoned, { ledger: { status: 'active' } });

    assert.equal(reclaims(dir, minted), true, 'baseline: keepRuns:1 evicts this run while its ledger is terminal');

    // Same run, same age, same absence of claims — only the ledger changes.
    seedRun(dir, minted, { ledger: { status: 'planned' } });
    assert.equal(reclaims(dir, minted), false, 'a non-terminal ledger inside the mint window protects the run');

    // The other half, and the reason the window exists at all.
    assert.equal(reclaims(dir, abandoned), true, 'an abandoned non-terminal run must stay reclaimable');
    assert.equal(reportsLive(dir, abandoned), false, 'an abandoned run is not live');
  });
});

// The guard rail, as a permanent test rather than a one-off measurement: if
// liveness never expired, a project that once looked busy could never be swept
// again and `.traffic-one` would grow without bound. Protection is borrowed from
// SUBAGENT_STALE_MS, so it lapses on its own with no action from anyone.
test('liveness protection EXPIRES, so the sweep can never decay into a no-op', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const busy = runIdAged(7 * HOUR);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, runIdAged(2 * HOUR), { ledger: { status: 'active' } });
    seedRun(dir, busy, { ledger: { status: 'active' }, claims: 3 });

    assert.equal(reclaims(dir, busy), false, 'baseline: a run with fresh claims is protected');

    // The agents stopped. Nothing else about the tree changes — same run, same
    // claim files, same count — only the age of the claims.
    fs.rmSync(path.join(dir, '.traffic' + '-one', 'runs', busy, 'pending'), { recursive: true, force: true });
    seedRun(dir, busy, { ledger: { status: 'active' }, claims: 3, claimAgeMs: 31 * MINUTE });
    assert.equal(reclaims(dir, busy), true, 'once its claims go stale the run is reclaimable again');
    assert.equal(reportsLive(dir, busy), false, 'and it is no longer reported live');
  });
});

// ── ignorance is not liveness ────────────────────────────────────────────────
// The sweep reads the claim walk through runLiveClaimEvidence, not through
// activeRunClaimCount, because the count folds a scan it could not FINISH into
// "at least one live claim". For the settlement vetoes that sentinel was
// written for, ignorance-as-keep lifts as soon as the scan succeeds; for this
// DELETER it never lifts, because the sweep it suppresses is the only thing
// that would remove the records the scan choked on.
//
// Every test below plants the cheapest trigger the walk actually has — more
// than its 2,048-entry bound — rather than an unreadable-file fixture. A
// `chmod 000` file is read straight through by root and an EISDIR fixture
// throws through the write path; the entry bound trips identically for every
// user and needs no errno at all. Each test still asserts the fixture reached
// the intended arm (`runLiveClaimEvidence === 'unknown'`), so a scan that
// quietly started completing fails these instead of passing them vacuously.
const UNFINISHABLE_CLAIMS = 2_050; // > the walk's 2,048-entry bound

function floodClaims(dir: string, id: string, count: number, claimAgeMs: number, extra: Record<string, unknown> = {}): void {
  const pending = path.join(dir, '.traffic' + '-one', 'runs', id, 'pending');
  fs.mkdirSync(pending, { recursive: true });
  for (const [name, record] of Object.entries(extra)) {
    fs.writeFileSync(path.join(pending, name), JSON.stringify(record), 'utf8');
  }
  const updatedAt = new Date(Date.now() - claimAgeMs).toISOString();
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(
      path.join(pending, `flood-${String(index).padStart(5, '0')}.json`),
      JSON.stringify({ role: 'frontend', runId: id, status: 'claimed', updatedAt }),
      'utf8',
    );
  }
}

test('an unfinishable claim scan is not evidence of life once the run is past the window', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const hoarder = runIdAged(40 * DAY);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, runIdAged(2 * HOUR), { ledger: { status: 'completed', outcome: 'verified' } });
    seedRun(dir, hoarder, { ledger: { status: 'completed', outcome: 'verified' } });

    assert.equal(reclaims(dir, hoarder), true, 'baseline: with a finishable, empty scan the run is reclaimable');

    // Every one of these claims is 30 days stale, so a scan that COULD finish
    // would count zero of them. Only the truncation makes the run look alive.
    floodClaims(dir, hoarder, UNFINISHABLE_CLAIMS, 30 * DAY);
    assert.equal(runLiveClaimEvidence(dir, hoarder), 'unknown', 'fixture: the scan really cannot finish');

    assert.equal(reportsLive(dir, hoarder), false, 'a scan that could not finish is not a live claim');
    assert.equal(reclaims(dir, hoarder), true, 'so the run does not hold a reserved slot forever');
  });
});

test('an unfinishable claim scan still protects a freshly minted run', () => {
  withProject((dir) => {
    const current = runIdAged(10 * 1000);
    const minted = runIdAged(3 * MINUTE);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, runIdAged(1 * MINUTE), { ledger: { status: 'completed', outcome: 'verified' } });
    // TERMINAL ledger deliberately: the mint-window arm above must not be what
    // saves this run, or the test would not be about the claim walk at all.
    seedRun(dir, minted, { ledger: { status: 'completed', outcome: 'verified' } });

    assert.equal(reclaims(dir, minted), true, 'baseline: keepRuns:1 evicts this run while its scan finishes');

    floodClaims(dir, minted, UNFINISHABLE_CLAIMS, 30 * DAY);
    assert.equal(runLiveClaimEvidence(dir, minted), 'unknown', 'fixture: the scan really cannot finish');

    assert.equal(reportsLive(dir, minted), true, 'inside the window, ignorance still protects');
    assert.equal(reclaims(dir, minted), false, 'a run that could still be in use is never reclaimed on a scan we could not finish');
  });
});

test('a claim actually SEEN outranks an unfinishable scan, however old the run', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const busy = runIdAged(40 * DAY);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, runIdAged(2 * HOUR), { ledger: { status: 'completed', outcome: 'verified' } });
    seedRun(dir, busy, { ledger: { status: 'completed', outcome: 'verified' } });

    // The walk visits a directory in name order, so `a-live.json` is seen well
    // before the bound is reached: positive evidence, from an incomplete scan.
    floodClaims(dir, busy, UNFINISHABLE_CLAIMS, 30 * DAY, {
      'a-live.json': { role: 'frontend', runId: busy, status: 'claimed', updatedAt: new Date(Date.now() - 30 * 1000).toISOString() },
    });
    assert.equal(runLiveClaimEvidence(dir, busy), 'live', 'fixture: seen beats unfinished');

    assert.equal(reportsLive(dir, busy), true, 'an active record that was actually read outranks the truncation');
    assert.equal(reclaims(dir, busy), false, 'and the run is retained');
  });
});

// The two halves of leaving `runAgeMs` un-skew-guarded (see the comment above
// runIsLive), pinned rather than left to be rediscovered. A skew guard fitted
// to runAgeMs turns BOTH of these red, which is the point: the cost of the
// guard is a deletion, and it should never be able to land looking free.
//
// Half one, the one the ruling turns on: this run's ledger says an agent is
// inside it, and since `ageAttestsLiveness` landed in run-settlement/io.ts a
// future-stamped claim no longer protects it either — so the mint stamp is the
// last protection standing.
test('a future-minted id with a non-terminal ledger stays protected — the skew trade, made visible', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const skewed = String(NOW + 1 * HOUR);
    const abandoned = runIdAged(4 * DAY);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, skewed, { ledger: { status: 'active' } });
    // Control: the same non-terminal ledger on an ordinary id is NOT protected,
    // so what saves the run above is the future stamp and nothing else.
    seedRun(dir, abandoned, { ledger: { status: 'active' } });

    assert.equal(reportsLive(dir, abandoned), false, 'control: the mint window closes normally on an ordinary id');
    assert.equal(reportsLive(dir, skewed), true, 'a stamp ahead of now keeps the mint window open forever');
  });
});

// Half two: the ignorance arm, bounded by the same mint stamp. A disk-only,
// conservative-direction leak, and a far narrower shape than the status quo it
// replaces — which held EVERY run with an unfinishable scan forever, at any
// age, as the test above shows.
test('a future-minted id keeps the ignorance arm open indefinitely — the accepted cost', () => {
  withProject((dir) => {
    const current = runIdAged(1 * MINUTE);
    const skewed = String(NOW + 1 * HOUR);
    project(dir, current, { keepRuns: 1, orphanTtlDays: 3650 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    seedRun(dir, skewed, { ledger: { status: 'completed', outcome: 'verified' } });

    floodClaims(dir, skewed, UNFINISHABLE_CLAIMS, 30 * DAY);
    assert.equal(runLiveClaimEvidence(dir, skewed), 'unknown', 'fixture: the scan really cannot finish');

    assert.equal(reportsLive(dir, skewed), true, 'a stamp ahead of now is inside the borrowed window forever');
  });
});

// The orphan rule deletes runs the keep set RETAINED, so it cannot inherit the
// keep set's liveness — it has to ask separately. keepRuns is set high enough
// that the newest-N rule cannot be what schedules this run, so the reason string
// identifies which rule is under test.
test('the abandoned-run TTL rule also asks the liveness question', () => {
  withProject((dir) => {
    const t1 = '.traffic' + '-one';
    const current = runIdAged(1 * MINUTE);
    const preplan = runIdAged(6 * DAY);
    project(dir, current, { keepRuns: 20, orphanTtlDays: 3 });
    seedRun(dir, current, { ledger: { status: 'active' } });
    // Never reached architecture compilation, and its directory is old: exactly
    // the orphan shape — but a resumed long-running run can hold live claims in
    // it, which the 3-day TTL alone cannot distinguish.
    seedRun(dir, preplan, { ledger: { status: 'active' }, architecture: false });
    const runDir = path.join(dir, t1, 'runs', preplan);
    const stale = (Date.now() - 30 * DAY) / 1000;
    fs.utimesSync(runDir, stale, stale);

    const baseline = sweepTrafficOneRetention(dir, { dryRun: true, nowMs: NOW })
      .actions.find((action) => action.path === runDir);
    assert.ok(baseline, 'baseline: the pre-architecture run is a candidate');
    assert.match(baseline.reason, /abandoned before architecture compilation/, 'baseline: scheduled by the orphan rule, not the newest-N rule');

    // Claims first, then restore the old mtime the writes just bumped.
    seedRun(dir, preplan, { ledger: { status: 'active' }, architecture: false, claims: 2 });
    fs.utimesSync(runDir, stale, stale);
    assert.equal(reclaims(dir, preplan), false, 'the orphan TTL must not reclaim a run that still holds live claims');
  });
});

// ── the post-settlement deleter's report ─────────────────────────────────────
// `sweepAfterTerminalSettlement` used to be `void` around a catch-all, so three
// different worlds arrived at the caller as one silence: nothing to reclaim,
// every reclaim REFUSED by the state-write fence, and the sweep throwing. The
// three tests below pin each apart. The property that must SURVIVE — settlement
// never fails because cleanup did — is asserted in every one of them.

/**
 * Run `fn` with stderr captured, and hand BOTH back. Returning the value rather
 * than letting the caller assign into an outer `let` is deliberate: TypeScript
 * cannot see that a callback ran, so an outer binding stays narrowed to its
 * initializer and every property read off it is an error on `never`.
 */
function capturedStderr<T>(fn: () => T): { value: T; stderr: string } {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = fn();
    return { value, stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

/**
 * A project with two stale candidates: one plain (the WRITABLE BASELINE — it
 * must really be reclaimed, or a fixture that stopped fencing would pass) and
 * one fenced behind a symlink.
 *
 * The fence is the READ-BEFORE-WRITE variant, and it has to be. The sweep
 * SCHEDULES `.codegraph-build-lock` only after `fs.existsSync` and a `statSync`
 * mtime both resolve at that path, so a DANGLING link is never scheduled at all
 * and `removePath` is never reached — the test would report zero refusals having
 * proved nothing about the fence. So the real file is moved aside to
 * `.codegraph-build-lock.real` (a name nothing sweeps) and the original name is
 * a link to it; `lockIsReadable` below is the guard that the read still
 * resolves. EACCES/EISDIR were not candidates here: the refusal this exercises
 * is the fsjson symlink guard, which is decided by `lstat` before any I/O, and
 * an errno would instead be RETHROWN through `act` into the other arm.
 */
function fencedProject(dir: string): { lock: string; debugLog: string } {
  const t1 = path.join(dir, '.traffic' + '-one');
  fs.writeFileSync(
    path.join(t1, 'retention.json'),
    JSON.stringify({ keepRuns: 3, backupKeep: 1, orphanTtlDays: 3 }),
    'utf8',
  );
  const stale = (Date.now() - 30 * DAY) / 1000;

  const debugLog = path.join(t1, 'debug', 'session.log');
  fs.mkdirSync(path.dirname(debugLog), { recursive: true });
  fs.writeFileSync(debugLog, 'stale\n', 'utf8');
  fs.utimesSync(debugLog, stale, stale);

  const lock = path.join(t1, '.codegraph-build-lock');
  const behind = `${lock}.real`;
  fs.writeFileSync(behind, 'held\n', 'utf8');
  fs.utimesSync(behind, stale, stale);
  fs.symlinkSync(behind, lock);
  return { lock, debugLog };
}

test('sweepAfterTerminalSettlement tells an EMPTY sweep from a fully REFUSED one', () => {
  withProject((dir) => {
    const empty = sweepAfterTerminalSettlement(dir);
    assert.equal(empty.status, 'swept');
    assert.deepEqual(
      empty,
      { status: 'swept', planned: 0, removed: 0, refused: 0 },
      'a project with nothing to reclaim reports planned 0 — not merely "no error"',
    );
  });

  withProject((dir) => {
    const { lock, debugLog } = fencedProject(dir);
    // FIXTURE GUARDS, both directions, before anything is asserted about the fix.
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true, 'fixture: the lock path is a link');
    assert.equal(fs.existsSync(lock), true, 'fixture: the link RESOLVES — a dangling one is never scheduled');
    const planned = sweepTrafficOneRetention(dir, { dryRun: true }).actions.map((action) => action.path);
    assert.ok(planned.includes(lock), 'fixture: the fenced lock is genuinely scheduled for removal');
    assert.ok(planned.includes(debugLog), 'baseline: the unfenced debug log is scheduled too');

    // stderr is discarded here; the next test is the one that asserts on it.
    capturedStderr(() => {
      const swept = sweepAfterTerminalSettlement(dir);
      assert.equal(swept.status, 'swept');
      if (swept.status !== 'swept') return;
      assert.equal(swept.planned, 2, 'both candidates were planned');
      assert.equal(swept.removed, 1, 'WRITABLE BASELINE: the unfenced candidate really was reclaimed');
      assert.equal(swept.refused, 1, 'the fenced candidate was refused, and the report says so');
    });

    assert.equal(fs.existsSync(debugLog), false, 'baseline: the plain candidate is gone');
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true, 'the fenced candidate survived, as the fence intends');
  });
});

test('a refused reclaim is ANNOUNCED, not swallowed — and settlement still does not fail', () => {
  withProject((dir) => {
    fencedProject(dir);
    const { value: report, stderr } = capturedStderr(() => sweepAfterTerminalSettlement(dir, '1001'));
    assert.equal(report.status, 'swept', 'the deleter returned rather than threw');
    assert.match(
      stderr,
      /retention sweep after settlement reclaimed 1 of 2 path\(s\) for run 1001 — 1 refused by the state-write fence/,
      'the refusal names the run, the arithmetic, and the fence that made it',
    );
  });
});

// The catch is DEFENSIVE, and that is a measurement rather than an assumption:
// thirteen hostile shapes were tried against the sweep — retention.json and
// .one.json as directories (EISDIR), retention.json at chmod 000 (EACCES), an
// unreadable runs/, a symlink loop inside a run, backups/ as a file, a missing
// cwd, a NUL-bearing cwd, a 300-char currentRunId, five malformed ledgers and
// out-of-range policy numerics — and every one is absorbed by a guard. The only
// input found that reaches the catch is a NON-STRING cwd, which `path.join`
// rejects inside `readPolicy` before anything is read, let alone deleted. That
// is an untyped caller, not a filesystem state, so the cast below is the shape
// of the defect and not a trick: no stub is involved, and the throw travels the
// real code path.
test('a THROWN sweep reports `failed` and never escapes into settlement', () => {
  const { value: report, stderr } = capturedStderr(
    () => sweepAfterTerminalSettlement(undefined as unknown as string, '1001'),
  );
  assert.equal(report.status, 'failed', 'the deleter RETURNED `failed` — it neither threw nor claimed a sweep');
  if (report.status === 'failed') {
    assert.match(report.reason, /must be of type string/, 'the swallowed error text is carried out to the caller');
  }
  assert.match(
    stderr,
    /retention sweep after settlement failed for run 1001: .*— how much it had reclaimed first is unknown/,
    'the failure is announced, and declines to invent a removed count it cannot know',
  );
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
