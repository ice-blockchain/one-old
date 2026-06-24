import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  buildOpenCodeQueue,
  hasRunningOpenCodeUnits,
  readOpenCodeQueue,
  readOpenCodeUnitStatuses,
  reconcileAllRunningUnits,
  reconcileStaleRunningUnits,
  recordOpenCodeUnitStatus,
} from '../opencode-queue';
import { parsePlanDelegationUnits } from '../opencode-roles';

function withRunDir(fn: (cwd: string, runId: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocqueue2-'));
  const runId = 'run-queue-test';
  try {
    fn(cwd, runId);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('readOpenCodeQueue + readOpenCodeUnitStatuses round-trip queue and status files', () => {
  withRunDir((cwd, runId) => {
    const units = parsePlanDelegationUnits([
      '<!-- opencode-delegate:start -->',
      '- id: ui-card | role: frontend | files: src/Card.tsx | task: render card',
      '<!-- opencode-delegate:end -->',
    ].join('\n'));
    const queue = buildOpenCodeQueue(cwd, runId, units);
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', runId), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-queue.json'), `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
    recordOpenCodeUnitStatus(cwd, runId, {
      id: 'ui-card',
      role: 'frontend',
      status: 'running',
      action: 'running',
      touched: [],
    });
    const readQueue = readOpenCodeQueue(cwd, runId);
    assert.ok(readQueue);
    assert.equal(readQueue?.units[0]?.id, 'ui-card');
    const statuses = readOpenCodeUnitStatuses(cwd, runId);
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.status, 'running');
    assert.equal(hasRunningOpenCodeUnits(cwd, runId), true);
  });
});

test('reconcileAllRunningUnits flips fresh running units to failed', () => {
  withRunDir((cwd, runId) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'opencode-units.json'), JSON.stringify([
      {
        id: 'fresh-unit',
        role: 'frontend',
        status: 'running',
        action: 'running',
        touched: [],
        updatedAt: new Date().toISOString(),
      },
    ], null, 2), 'utf8');
    const reconciled = reconcileAllRunningUnits(cwd, runId, 'forced reconcile');
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.status, 'failed');
    assert.equal(reconciled[0]?.error, 'forced reconcile');
    assert.equal(hasRunningOpenCodeUnits(cwd, runId), false);
  });
});

test('reconcileStaleRunningUnits marks long-running units failed', () => {
  withRunDir((cwd, runId) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const staleAt = new Date(Date.now() - 700_000).toISOString();
    fs.writeFileSync(path.join(runDir, 'opencode-units.json'), JSON.stringify([
      {
        id: 'stale-unit',
        role: 'frontend',
        status: 'running',
        action: 'running',
        touched: [],
        updatedAt: staleAt,
      },
    ], null, 2), 'utf8');
    const reconciled = reconcileStaleRunningUnits(cwd, runId, 600_000);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.status, 'failed');
    assert.match(reconciled[0]?.error || '', /stale running status reconciled/);
    assert.equal(hasRunningOpenCodeUnits(cwd, runId), false);
  });
});
