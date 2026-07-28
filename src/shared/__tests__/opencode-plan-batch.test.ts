import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildBatchResultFromUnitStatuses,
  finalizePlanBatch,
  finalizePlanBatchOnly,
} from '../opencode-plan-batch';
import {
  openCodePlanBatchComplete,
  pendingOpenCodePlanRoles,
  readOpenCodePlanBatchState,
} from '../opencode-roles';
import { buildOpenCodeQueue, readOpenCodeQueue, recordOpenCodeUnitStatus, writeOpenCodeQueue } from '../opencode-queue';

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
