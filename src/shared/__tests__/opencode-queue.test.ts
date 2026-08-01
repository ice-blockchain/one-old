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
  writeOpenCodeQueue,
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
    writeOpenCodeQueue(cwd, queue);
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
    assert.deepEqual(
      fs.readdirSync(path.join(cwd, '.traffic-one', 'runs', runId))
        .filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
      [],
    );
  });
});

test('recordOpenCodeUnitStatus folds repeated terminal writes into one attempt and keeps the model', () => {
  withRunDir((cwd, runId) => {
    const unit = { id: 'responsive-navigation', role: 'frontend', touched: ['src/Nav.tsx'] };
    // The exact 6co sequence for one successful unit: the delegate records the
    // terminal status, the batch records it again 2 ms later, and batch
    // finalization reconciles it a third time without model metadata.
    recordOpenCodeUnitStatus(cwd, runId, {
      ...unit, status: 'running', action: 'running', model: null, updatedAt: '2026-07-29T09:18:50.380Z',
    });
    recordOpenCodeUnitStatus(cwd, runId, {
      ...unit, status: 'delegated', action: 'delegated', model: 'opencode/deepseek-v4-flash-free', updatedAt: '2026-07-29T09:22:09.278Z',
    });
    recordOpenCodeUnitStatus(cwd, runId, {
      ...unit, status: 'delegated', action: 'delegated', model: 'opencode/deepseek-v4-flash-free', updatedAt: '2026-07-29T09:22:09.280Z',
    });
    recordOpenCodeUnitStatus(cwd, runId, {
      ...unit, status: 'delegated', action: 'delegated', model: null, updatedAt: '2026-07-29T09:33:12.688Z',
    });

    const [status] = readOpenCodeUnitStatuses(cwd, runId);
    assert.deepEqual(
      (status?.attempts || []).map((attempt) => attempt.status),
      ['running', 'delegated'],
      'one terminal transition must record one attempt',
    );
    assert.equal(status?.attempts?.[1]?.model, 'opencode/deepseek-v4-flash-free');
    assert.equal(status?.attempts?.[1]?.updatedAt, '2026-07-29T09:22:09.278Z');
    assert.equal(status?.model, 'opencode/deepseek-v4-flash-free', 'reconciliation must not blank the model');

    // A genuine retry is still a new attempt — the cap protects real history.
    recordOpenCodeUnitStatus(cwd, runId, {
      ...unit, status: 'running', action: 'running', model: null, updatedAt: '2026-07-29T09:40:00.000Z',
    });
    recordOpenCodeUnitStatus(cwd, runId, {
      ...unit, status: 'failed', action: 'failed', model: 'opencode/other', error: 'boom', updatedAt: '2026-07-29T09:41:00.000Z',
    });
    const [retried] = readOpenCodeUnitStatuses(cwd, runId);
    assert.deepEqual(
      (retried?.attempts || []).map((attempt) => attempt.status),
      ['running', 'delegated', 'running', 'failed'],
    );
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

test('recordOpenCodeUnitStatus caps attempt history and stores a repeated error once', () => {
  withRunDir((cwd, runId) => {
    const error = `delegation denied: ${'x'.repeat(400)}`;
    // Real retries alternate running/terminal; consecutive identical terminals
    // are duplicate reporting and now fold into one attempt, so the cap is
    // exercised with the shape it actually protects.
    for (let index = 0; index < 12; index += 1) {
      recordOpenCodeUnitStatus(cwd, runId, {
        id: 'ui-card',
        role: 'frontend',
        status: 'running',
        action: 'running',
        touched: [],
      });
      recordOpenCodeUnitStatus(cwd, runId, {
        id: 'ui-card',
        role: 'frontend',
        status: 'failed',
        action: 'failed',
        failureKind: 'gate-denied',
        error,
        touched: [],
      });
    }
    const [status] = readOpenCodeUnitStatuses(cwd, runId);
    assert.equal(status?.error, error, 'full error lives once at the entry level');
    assert.equal(status?.attempts?.length, 8, 'attempt history is capped');
    const materialized = (status?.attempts || []).filter((attempt) => (
      attempt.error && attempt.error !== '(unchanged)'
    ));
    assert.equal(materialized.length, 0, 'repeated error is never re-stored in capped history');
    assert.ok((status?.attempts || []).every((attempt) => !('touched' in attempt)));

    recordOpenCodeUnitStatus(cwd, runId, {
      id: 'ui-card',
      role: 'frontend',
      status: 'failed',
      action: 'failed',
      failureKind: 'gate-denied',
      error: 'a different failure',
      touched: [],
    });
    const [after] = readOpenCodeUnitStatuses(cwd, runId);
    assert.equal(after?.attempts?.[after.attempts.length - 1]?.error, 'a different failure');
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

// A parallel-mode paid spawn records a fallback for its role WHILE the free
// unit is still executing — flipping that live row destroyed its file
// reservation the instant the flag's designed use case fired (adversarial
// review). Live rows survive; dead ones still flip.
test('recordOpenCodeFallback never flips a VERIFIABLY RUNNING unit; a dead running row still falls back', () => {
  withRunDir((cwd, runId) => {
    recordOpenCodeUnitStatus(cwd, runId, {
      id: 'live-unit', role: 'frontend', status: 'running', action: 'running', touched: [],
      allowedFiles: ['src/features/news/**'],
    });
    recordOpenCodeUnitStatus(cwd, runId, {
      id: 'dead-unit', role: 'frontend', status: 'running', action: 'running', touched: [],
      updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    recordOpenCodeFallback(cwd, runId, 'senior-frontend', { status: 'paid_spawned', agentId: 'agent-2' });
    const statuses = readOpenCodeUnitStatuses(cwd, runId);
    assert.equal(statuses.find((s) => s.id === 'live-unit')?.status, 'running', 'a live executor keeps its row (and its reservation)');
    assert.equal(statuses.find((s) => s.id === 'dead-unit')?.status, 'fallback_required', 'a dead running row still records the fallback');
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

test('openCodeQueuePolicyViolations: a docs-only unit documenting test commands stays on OpenCode', () => {
  // The root-docs incident: a CONTRIBUTING.md draft saying "run pnpm test before
  // a PR" documents a command; it cannot write tests — its allowlist is docs-only.
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: root-docs | role: docs | kind: docs | files: README.md, CONTRIBUTING.md, CHANGELOG.md | task: draft root docs; CONTRIBUTING.md tells contributors to run pnpm typecheck and pnpm test before opening a PR',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(units), []);
});

// Regression (4cl, 1.0.28): 4/5 units invented helper paths no module compiles
// (src/lib/format.ts) — the rejection must PRINT real in-scope paths so the
// architect stops guessing, and must say the files are unwritable for everyone.
test('openCodeQueuePolicyViolations: out-of-scope unit rejection lists real in-scope files for the role', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: format-helpers | role: frontend | kind: pure-helper | files: apps/web/src/lib/format.ts | task: pure formatting helpers',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  const errors = openCodeQueuePolicyViolations(units, {
    assignments: [{
      role: 'senior-frontend',
      scope: {
        include: ['apps/web/src/App.tsx', 'apps/web/src/features/course-catalog/index.ts', 'README.md'],
        exclude: [],
      },
    }],
  });
  const scopeError = errors.find((error) => /outside frontend's assignment scope/.test(error));
  assert.ok(scopeError, errors.join(' | '));
  assert.match(scopeError as string, /apps\/web\/src\/features\/course-catalog\/index\.ts/);
  assert.match(scopeError as string, /NOT writable by the implementers either/);
});

test('openCodeQueuePolicyViolations: a non-docs unit mentioning tests still needs test paths in its allowlist', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: helpers | role: frontend | kind: helper | files: packages/utils/src/format.ts | task: add pure helpers with vitest coverage for each',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(units).some((error) => /mentions tests\/testability/.test(error)));
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

test('openCodeQueuePolicyViolations allows verb-phrase negations (8c pure-helpers false positive)', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    // the 8c final wording — reversed noun negation "no changes to package.json"
    '- id: pure-utils-helpers | role: frontend | kind: pure helpers | files: packages/utils/src/*.ts,packages/utils/src/*.test.ts | task: Implement framework-agnostic helpers in packages/utils/src/ (slugify.ts, format-duration.ts, format-price.ts) exporting named functions, re-exported from src/index.ts. Add unit tests using the vitest setup already declared for this package. No React imports, no dependency on other workspace packages, no changes to package.json or any config file.',
    // draft-style verb negations that previously kept "add … packages" visible
    '- id: fixtures-only | role: frontend | kind: fixtures/seed data | files: apps/web/src/fixtures/demo-news.ts | task: Create demo news fixtures with typed exports. Do not add packages or dependencies; do not touch package.json. Never install anything.',
    "- id: docsless-helpers | role: backend | kind: pure helpers | files: services/api/src/lib/slug.ts | task: Add a slugify helper with tests colocated in the same file's folder, without adding dependencies and without touching lockfiles.",
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  const violations = openCodeQueuePolicyViolations(units)
    .filter((e) => /dependency\/package-manager work/.test(e));
  assert.deepEqual(violations, []);
});

test('verb-phrase negation stripping never hides an affirmative install elsewhere in the task', () => {
  const units = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: sneaky | role: backend | files: services/api/src/x.ts | task: Do not add comments to generated files. Then run pnpm install lodash before wiring the helper.',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(units).some((e) => /dependency\/package-manager work/.test(e)));
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
