import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  buildOpenCodeQueue,
  hasRunningOpenCodeUnits,
  openCodeQueuePolicyViolations,
  readOpenCodeQueue,
  readOpenCodeUnitStatuses,
  reconcileAllRunningUnits,
  reconcileStaleRunningUnits,
  recordOpenCodeFallback,
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

test('recordOpenCodeUnitStatus keeps best status and appends attempts', () => {
  withRunDir((cwd, runId) => {
    recordOpenCodeUnitStatus(cwd, runId, {
      id: 'ui-card',
      role: 'frontend',
      status: 'delegated',
      action: 'delegated',
      touched: ['src/Card.tsx'],
    });
    recordOpenCodeUnitStatus(cwd, runId, {
      id: 'ui-card',
      role: 'frontend',
      status: 'no_changes',
      action: 'no-changes',
      touched: [],
    });
    const [status] = readOpenCodeUnitStatuses(cwd, runId);
    assert.equal(status?.status, 'delegated');
    assert.equal(status?.action, 'delegated');
    assert.deepEqual(status?.touched, ['src/Card.tsx']);
    assert.equal(status?.attempts?.length, 2);
    assert.equal(status?.attempts?.[1]?.status, 'no_changes');
  });
});

test('recordOpenCodeFallback annotates units without appending attempts', () => {
  withRunDir((cwd, runId) => {
    recordOpenCodeUnitStatus(cwd, runId, {
      id: 'ui-card',
      role: 'frontend',
      status: 'failed',
      action: 'failed',
      touched: [],
    });
    const before = readOpenCodeUnitStatuses(cwd, runId)[0];
    assert.equal(before?.attempts?.length, 1);
    recordOpenCodeFallback(cwd, runId, 'senior-frontend', { status: 'paid_spawned', agentId: 'agent-1' });
    const after = readOpenCodeUnitStatuses(cwd, runId)[0];
    assert.equal(after?.status, 'fallback_required');
    assert.equal(after?.fallback?.status, 'paid_spawned');
    assert.equal(after?.fallback?.agentId, 'agent-1');
    assert.equal(after?.attempts?.length, 1);
  });
});

test('openCodeQueuePolicyViolations routes dependency/package-manager units away from OpenCode', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: deps | role: backend | kind: dependencies | files: package.json, pnpm-lock.yaml | task: install zod and update package manager files',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  const errors = openCodeQueuePolicyViolations(units);
  assert.ok(errors.some((error) => /dependency\/package-manager work/.test(error)));
});

test('openCodeQueuePolicyViolations: a docs-only unit describing install steps stays on OpenCode (B9)', () => {
  // The readme-draft incident: documenting `npm install` steps in prose is not
  // dependency work — the unit's file allowlist is docs-only and enforced.
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: readme-draft | role: frontend | kind: docs | files: README.md, docs/** | task: draft the README with setup steps (npm install, pnpm dev) and usage examples',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(units), []);
});

test('openCodeQueuePolicyViolations: a unit mixing docs with package.json still routes to paid', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: readme-and-deps | role: backend | files: README.md, package.json | task: document setup and npm install the new packages',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(units).some((error) => /dependency\/package-manager work/.test(error)));
});

test('openCodeQueuePolicyViolations allows package manifests for non-dependency config work', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: scripts | role: frontend | files: package.json, vite.config.ts | task: adjust package metadata and Vite aliases only',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(units), []);
});

test('openCodeQueuePolicyViolations allows "add a build script" to package.json (not dependency work)', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: build-script | role: frontend | files: package.json | task: add a build script to package.json',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(units), []);
});

test('openCodeQueuePolicyViolations still routes adding a package to package.json to paid', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: add-dep | role: backend | files: package.json | task: add lodash to package.json',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(units).some((e) => /dependency\/package-manager work/.test(e)));
});

test('openCodeQueuePolicyViolations allows negated dependency wording in safe fixture units', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: i18n-catalog-seed | role: frontend | kind: seed-data | files: packages/i18n/src/index.ts,packages/i18n/src/locales/en/common.json,packages/i18n/package.json,packages/i18n/tsconfig.json | task: Create a typed English catalog skeleton for learner navigation, course cards, filters, empty states, and route metadata keys; no app wiring and no dependency/version changes.',
    '- id: go-course-seed | role: backend | kind: seed-data | files: services/api/internal/course/types.go,services/api/internal/course/seed.go | task: Create Go course DTO structs and embedded seed data matching the planned public course fields; no HTTP handlers, no persistence, no external dependencies.',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(units), []);
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
