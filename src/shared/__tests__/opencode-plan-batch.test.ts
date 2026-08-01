import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildBatchResultFromUnitStatuses,
  finalizePlanBatch,
  finalizePlanBatchOnly,
} from '../opencode-plan/batch';
import {
  batchLooksLive,
  clearOpenCodeApplyInProgress,
  markOpenCodeApplyInProgress,
  openCodePlanBatchComplete,
  pendingOpenCodePlanRoles,
  readOpenCodePlanBatchState,
  reservedOpenCodeFiles,
  shouldBlockImplementerForPlanBatch,
  touchPlanBatchHeartbeat,
} from '../opencode-roles';
import { buildOpenCodeQueue, readOpenCodeQueue, recordOpenCodeUnitStatus, touchOpenCodeUnitRunning, writeOpenCodeQueue } from '../opencode-queue';

test('a replan (new assignments hash) supersedes the terminal batch so Step-0 can run again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocbatch-replan-'));
  try {
    const runDir = path.join(dir, '.traffic-one', 'runs', 'run-replan');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'assignments.json'), JSON.stringify({ v: 1, scope: 'before' }), 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- id: u1 | role: frontend | files: a | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    writeOpenCodeQueue(dir, buildOpenCodeQueue(dir, 'run-replan', [
      { role: 'frontend', files: 'a', task: 't' },
    ]));
    const queue = readOpenCodeQueue(dir, 'run-replan');
    finalizePlanBatch(dir, 'run-replan', {
      total: 1,
      delegated: 0,
      units: [{ id: queue!.units[0]!.id, role: 'frontend', action: 'failed', status: 'rejected_policy', touched: [] }],
    });
    const terminal = readOpenCodePlanBatchState(dir, 'run-replan');
    assert.ok(terminal && terminal.outcome !== 'running', 'first batch is terminal');
    assert.ok(terminal!.assignmentHash, 'terminal batch is stamped with the assignments hash');

    // Replan: runtime republishes assignments.json → the old batch no longer binds.
    fs.writeFileSync(path.join(runDir, 'assignments.json'), JSON.stringify({ v: 2, scope: 'after-replan' }), 'utf8');
    assert.equal(readOpenCodePlanBatchState(dir, 'run-replan'), null,
      'observed 4cu: the pre-replan batch verdict must not replay after assignments change');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizePlanBatch writes terminal batch.json, COMPLETE, and non-empty role markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocbatch-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- id: u1 | role: frontend | files: a | task: t\n'
      + '- id: u2 | role: backend | files: b | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    writeOpenCodeQueue(dir, buildOpenCodeQueue(dir, 'run-batch', [
      { role: 'frontend', files: 'a', task: 't' },
      { role: 'backend', files: 'b', task: 't' },
    ]));
    const queue = readOpenCodeQueue(dir, 'run-batch');
    const u1 = queue!.units[0]!.id;
    const u2 = queue!.units[1]!.id;
    const merged = finalizePlanBatch(dir, 'run-batch', {
      total: 2,
      delegated: 1,
      units: [
        { id: u1, role: 'frontend', action: 'delegated', status: 'delegated', touched: ['a'] },
        { id: u2, role: 'backend', action: 'failed', status: 'failed', touched: [] },
      ],
    });
    assert.equal(merged.total, 2);
    const batchDir = path.join(dir, '.traffic-one', 'runs', 'run-batch', 'opencode-plan-batch');
    const batch = readOpenCodePlanBatchState(dir, 'run-batch');
    assert.equal(batch?.outcome, 'partial');
    // Observed live: outcome "success" with `rolesCompleted: []` because the
    // terminal write ran BEFORE the per-role loop and then refused the update.
    assert.deepEqual([...(batch?.rolesCompleted ?? [])].sort(), ['backend', 'frontend']);
    assert.equal(fs.existsSync(path.join(batchDir, 'COMPLETE')), true);
    assert.ok(fs.statSync(path.join(batchDir, 'frontend')).size > 0);
    assert.ok(fs.statSync(path.join(batchDir, 'backend')).size > 0);
    const state = { mode: 'new-project', openCode: { enabled: true }, toolchain: { opencode: { installedVersion: '1.0.0' } } };
    assert.equal(openCodePlanBatchComplete(dir, 'run-batch'), true);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run-batch', state), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizePlanBatchOnly recovers stuck runs with terminal units but no batch.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocrecover-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- id: u1 | role: frontend | files: a | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    const stuckQueue = buildOpenCodeQueue(dir, 'stuck-run', [
      { role: 'frontend', files: 'a', task: 't' },
    ]);
    writeOpenCodeQueue(dir, stuckQueue);
    const stuckUnitId = stuckQueue.units[0]!.id;
    recordOpenCodeUnitStatus(dir, 'stuck-run', {
      id: stuckUnitId,
      role: 'frontend',
      status: 'failed',
      action: 'failed',
      touched: [],
      error: 'timeout',
    });
    assert.equal(openCodePlanBatchComplete(dir, 'stuck-run'), true, 'belt clears gate from terminal units');
    assert.equal(readOpenCodePlanBatchState(dir, 'stuck-run'), null);
    finalizePlanBatchOnly(dir, 'stuck-run');
    assert.equal(readOpenCodePlanBatchState(dir, 'stuck-run')?.outcome, 'failed');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'stuck-run', 'opencode-plan-batch', 'COMPLETE')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildBatchResultFromUnitStatuses maps opencode-units.json into batch summary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocbuild-'));
  try {
    const builtQueue = buildOpenCodeQueue(dir, 'r1', [
      { role: 'tester', files: 'x', task: 't' },
    ]);
    writeOpenCodeQueue(dir, builtQueue);
    recordOpenCodeUnitStatus(dir, 'r1', {
      id: builtQueue.units[0]!.id,
      role: 'tester',
      status: 'delegated',
      action: 'delegated',
      touched: ['x'],
    });
    const built = buildBatchResultFromUnitStatuses(dir, 'r1');
    assert.equal(built.total, 1);
    assert.equal(built.delegated, 1);
    assert.equal(built.units?.[0]?.action, 'delegated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Batch liveness: a `running` batch.json left by a dead process must stop
// blocking implementers (it used to wedge the spawn gate FOREVER, with the
// prose-only --finalize-only recovery), while every live signal keeps blocking.

function livenessFixture(): { dir: string; runId: string; state: Record<string, unknown> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocliveness-'));
  const runId = 'run-live';
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
    '<!-- opencode-delegate:start -->\n'
    + '- id: u1 | role: frontend | files: src/a.ts | task: t\n'
    + '<!-- opencode-delegate:end -->\n', 'utf8');
  const queue = buildOpenCodeQueue(dir, runId, [{ role: 'frontend', files: 'src/a.ts', task: 't' }]);
  writeOpenCodeQueue(dir, queue);
  // Legacy-shaped running batch (no assignmentHash → no supersession path).
  fs.writeFileSync(
    path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch', 'batch.json'),
    JSON.stringify({ version: 1, outcome: 'running', startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), rolesCompleted: [] }),
    'utf8',
  );
  const state = {
    mode: 'new-project',
    openCode: { enabled: true },
    toolchain: { opencode: { installedVersion: '1.0.0' } },
  };
  return { dir, runId, state };
}

test('a running batch with no sign of life stops blocking; every live signal still blocks', () => {
  const { dir, runId, state } = livenessFixture();
  try {
    // Dead batch: running batch.json, no heartbeat, no fresh unit, no latch.
    assert.equal(batchLooksLive(dir, runId), false);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, runId, state, 'claude'), false, 'a dead running batch opens the gate');

    // Fresh heartbeat sidecar → blocks again.
    touchPlanBatchHeartbeat(dir, runId);
    assert.equal(batchLooksLive(dir, runId), true);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, runId, state, 'claude'), true, 'a fresh heartbeat proves the batch alive');
    // The heartbeat is a dotfile sidecar: it must never appear as a completed
    // role and must never rewrite batch.json (that write would race the
    // terminal writer).
    const batchRaw = fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch', 'batch.json'), 'utf8');
    touchPlanBatchHeartbeat(dir, runId);
    assert.equal(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch', 'batch.json'), 'utf8'), batchRaw);
    // Age the heartbeat past the freshness window → dead again.
    const heartbeat = path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch', '.heartbeat');
    const old = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(heartbeat, old, old);
    assert.equal(batchLooksLive(dir, runId), false);

    // A running unit inside its sanctioned in-flight window (~25 min) blocks —
    // the runner is spawnSync and cannot refresh updatedAt mid-attempt.
    const queue = readOpenCodeQueue(dir, runId);
    recordOpenCodeUnitStatus(dir, runId, {
      id: queue!.units[0]!.id,
      role: 'frontend',
      status: 'running',
      action: 'running',
      touched: [],
      updatedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    });
    assert.equal(batchLooksLive(dir, runId), true, 'a 15-min-old running unit is inside the in-flight window');
    // Past the window → dead.
    recordOpenCodeUnitStatus(dir, runId, {
      id: queue!.units[0]!.id,
      role: 'frontend',
      status: 'running',
      action: 'running',
      touched: [],
      updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    assert.equal(batchLooksLive(dir, runId), false, 'a 30-min-old running unit is a dead batch');

    // A pid-verified apply latch blocks regardless.
    markOpenCodeApplyInProgress(dir, runId, 'senior-frontend');
    assert.equal(batchLooksLive(dir, runId), true);
    clearOpenCodeApplyInProgress(dir, runId, 'senior-frontend');

    // A batch that never STARTED (no batch.json) still blocks: Step-0 first.
    fs.rmSync(path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch', 'batch.json'));
    assert.equal(shouldBlockImplementerForPlanBatch(dir, runId, state, 'claude'), true, 'an unstarted batch still gates implementers');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reservedOpenCodeFiles: only verifiably-running units reserve; stale/terminal/empty never do', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocreserve-'));
  try {
    const queue = buildOpenCodeQueue(dir, 'r-res', [
      { role: 'frontend', files: 'src/features/news/**,src/i18n.ts', task: 't' },
      { role: 'tester', files: 'e2e/', task: 't2' },
    ]);
    writeOpenCodeQueue(dir, queue);
    // Fresh running unit → reserves its patterns.
    recordOpenCodeUnitStatus(dir, 'r-res', {
      id: queue.units[0]!.id, role: 'frontend', status: 'running', action: 'running', touched: [],
      allowedFiles: queue.units[0]!.allowedFiles,
    });
    // Terminal unit → reserves nothing.
    recordOpenCodeUnitStatus(dir, 'r-res', {
      id: queue.units[1]!.id, role: 'tester', status: 'delegated', action: 'delegated', touched: [],
      allowedFiles: queue.units[1]!.allowedFiles,
    });
    const live = reservedOpenCodeFiles(dir, 'r-res');
    assert.equal(live.length, 1);
    assert.equal(live[0]!.role, 'frontend');
    assert.ok(live[0]!.patterns.includes('src/i18n.ts'));

    // Stale running (past the in-flight window, no latch) → gone.
    recordOpenCodeUnitStatus(dir, 'r-res', {
      id: queue.units[0]!.id, role: 'frontend', status: 'running', action: 'running', touched: [],
      allowedFiles: queue.units[0]!.allowedFiles,
      updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    assert.deepEqual(reservedOpenCodeFiles(dir, 'r-res'), [], 'a stale ledger never reserves');
    // ...unless the pid-verified apply latch shows the executor mid-apply.
    markOpenCodeApplyInProgress(dir, 'r-res', 'frontend');
    assert.equal(reservedOpenCodeFiles(dir, 'r-res').length, 1);
    clearOpenCodeApplyInProgress(dir, 'r-res', 'frontend');
    // Empty allowlist reserves nothing, and no ledger at all is just empty.
    assert.deepEqual(reservedOpenCodeFiles(dir, 'no-such-run'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('touchOpenCodeUnitRunning refreshes updatedAt without appending attempt rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-octouch-'));
  try {
    const queue = buildOpenCodeQueue(dir, 'r-touch', [
      { role: 'frontend', files: 'src/a.ts', task: 't' },
      { role: 'tester', files: 'e2e/b.ts', task: 't2' },
    ]);
    writeOpenCodeQueue(dir, queue);
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    recordOpenCodeUnitStatus(dir, 'r-touch', {
      id: queue.units[0]!.id, role: 'frontend', status: 'running', action: 'running', touched: [], updatedAt: stale,
    });
    recordOpenCodeUnitStatus(dir, 'r-touch', {
      id: queue.units[1]!.id, role: 'tester', status: 'delegated', action: 'delegated', touched: [], updatedAt: stale,
    });
    const before = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'r-touch', 'opencode-units.json'), 'utf8')) as Array<Record<string, unknown>>;
    touchOpenCodeUnitRunning(dir, 'r-touch');
    const after = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'r-touch', 'opencode-units.json'), 'utf8')) as Array<Record<string, unknown>>;
    const runningAfter = after.find((e) => e.status === 'running')!;
    const terminalAfter = after.find((e) => e.status === 'delegated')!;
    assert.ok(String(runningAfter.updatedAt) > stale, 'the running unit was refreshed');
    assert.equal(String(terminalAfter.updatedAt), stale, 'terminal units are untouched');
    // Zero attempt-row churn: a repeated running write would evict real retry
    // history against the attempt cap.
    assert.equal((runningAfter.attempts as unknown[]).length, (before.find((e) => e.status === 'running')!.attempts as unknown[]).length);
    // No-op safe on a run with no ledger.
    touchOpenCodeUnitRunning(dir, 'no-such-run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
