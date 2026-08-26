import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { stableBinDir } from '../runner-shims';

import {
  deriveBatchOutcomeFromUnits,
  hasFreshArchitectQueueForRun,
  markOpenCodeGatewayOutage,
  markOpenCodePlanBatchComplete,
  markOpenCodePlanBatchRunning,
  markOpenCodePlanBatchTerminal,
  markOpenCodePlanRoleCompleted,
  markOpenCodeRoleAttempted,
  openCodeDelegateRoles,
  openCodeGatewayOutageActive,
  openCodePlanBatchComplete,
  openCodePlanRoleCompleted,
  openCodeRoleAttempted,
  parsePlanDelegationBlock,
  parsePlanDelegationUnits,
  pendingOpenCodePlanRoles,
  planDelegationUnitCount,
  planDelegationQueueRoles,
  planDelegationQueueRolesForRun,
  readOpenCodePlanBatchState,
  roleHasQueuedUnits,
  shouldBlockImplementerForPlanBatch,
  shouldRunRoleOnOpenCode,
} from '../opencode-roles';
import { buildOpenCodeQueue, openCodeQueuePolicyViolations, writeOpenCodeQueue } from '../opencode-queue';

test('planDelegationQueueRoles + roleHasQueuedUnits: read the plan queue, normalized', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocqueue-')));
  try {
    assert.deepEqual(planDelegationQueueRoles(dir), []);              // no plan → empty
    assert.equal(roleHasQueuedUnits(dir, 'senior-frontend'), false);
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- role: senior-frontend | files: a | task: t\n'
      + '- role: frontend | files: a2 | task: t\n'
      + '- role: tester | files: b | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    assert.deepEqual(planDelegationQueueRoles(dir), ['frontend', 'tester']); // senior- stripped, deduped, in order
    assert.equal(roleHasQueuedUnits(dir, 'senior-frontend'), true);  // role id normalizes to a queued label
    assert.equal(roleHasQueuedUnits(dir, 'senior-tester'), true);
    assert.equal(roleHasQueuedUnits(dir, 'senior-backend'), false);  // not queued → not gated
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run-scoped OpenCode queue wins over stale plan.md roles', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocqueue-run-')));
  try {
    const memoryDir = '.traffic' + '-one';
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- id: stale-fe | role: frontend | files: a.ts | task: stale\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    writeOpenCodeQueue(dir, buildOpenCodeQueue(dir, 'run-current', [
      { id: 'current-be', role: 'backend', files: 'api.ts', task: 'current' },
    ]));
    const state = {
      mode: 'new-project',
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.0.0' } },
    };
    assert.deepEqual(planDelegationQueueRolesForRun(dir, 'run-current'), ['backend']);
    assert.equal(roleHasQueuedUnits(dir, 'senior-frontend', 'run-current'), false);
    assert.equal(roleHasQueuedUnits(dir, 'senior-backend', 'run-current'), true);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run-current', state), ['backend']);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-current', state), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parsePlanDelegationBlock counts only runnable role/files/task units', () => {
  const plan = [
    '# Plan',
    '<!-- opencode-delegate:start -->',
    '- role: frontend | files: packages/i18n/src/en.json | task: seed copy',
    '- role: backend | files: supabase/seed.sql',
    '- role: tester | task: add smoke test',
    '- role: docs | files: README.md | task: draft usage notes',
    '- role: senior-frontend | files: packages/i18n/src/locales/ro/common.json | task: seed translated copy',
    '<!-- opencode-delegate:end -->',
  ].join('\n');
  const parsed = parsePlanDelegationBlock(plan);
  assert.equal(parsed.unitCount, 3);
  assert.deepEqual(parsed.roles, ['frontend', 'docs']);
  assert.equal(planDelegationUnitCount(plan), 3);
});

test('parsePlanDelegationUnits reads optional id/kind/depends metadata', () => {
  const plan = [
    '<!-- opencode-delegate:start -->',
    '- id: seed-data | role: senior-backend | kind: fixtures-seed-data | files: src/data.ts | task: seed data',
    '- id: ui-card | role: frontend | kind: ui-stub | files: src/Card.tsx | depends: seed-data | task: render card',
    '<!-- opencode-delegate:end -->',
  ].join('\n');
  const units = parsePlanDelegationUnits(plan);
  assert.deepEqual(units, [
    { id: 'seed-data', role: 'backend', files: 'src/data.ts', task: 'seed data', kind: 'fixtures-seed-data' },
    { id: 'ui-card', role: 'frontend', files: 'src/Card.tsx', task: 'render card', kind: 'ui-stub', dependsOn: ['seed-data'] },
  ]);
  const queue = buildOpenCodeQueue('', '', units);
  assert.deepEqual(queue.units.map((u) => ({ id: u.id, role: u.role, kind: u.kind, dependsOn: u.dependsOn })), [
    { id: 'seed-data', role: 'backend', kind: 'fixtures-seed-data', dependsOn: [] },
    { id: 'ui-card', role: 'frontend', kind: 'ui-stub', dependsOn: ['seed-data'] },
  ]);
});

test('openCodeQueuePolicyViolations rejects duplicate ids, missing scopes, and unordered overlaps', () => {
  const missingId = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- role: frontend | files: apps/web/src/a.ts | task: A',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(missingId).some((v) => /stable unique `id`/.test(v)));

  const dup = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: same | role: frontend | files: apps/web/src/a.ts | task: A',
    '- id: same | role: tester | files: apps/web/src/b.ts | task: B',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(dup).some((v) => /duplicated/.test(v)));

  const overlap = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: ui | role: frontend | files: apps/web/src/** | task: A',
    '- id: card | role: frontend | files: apps/web/src/components/Card.tsx | task: B',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(overlap).some((v) => /overlapping/.test(v)));

  const ordered = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: ui | role: frontend | files: apps/web/src/** | task: A',
    '- id: card | role: frontend | files: apps/web/src/components/Card.tsx | depends: ui | task: B',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(ordered), []);

  const unsafe = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: generated | role: frontend | files: dist/** | task: A',
    '- id: brace | role: frontend | files: apps/{web,admin}/src/** | task: B',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  const unsafeViolations = openCodeQueuePolicyViolations(unsafe).join('\n');
  assert.match(unsafeViolations, /generated\/internal/);
  assert.match(unsafeViolations, /brace\/glob/);
});

test('openCodeQueuePolicyViolations rejects test-oriented tasks without explicit test/config allowlists', () => {
  const helperOnly = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: markdown | role: frontend | files: apps/web/src/lib/markdown.ts | task: Write a pure markdown helper. Acceptance: unit-testable and handles code blocks.',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(helperOnly).some((v) => /mentions tests\/testability/.test(v)));

  const helperWithSpec = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: markdown | role: frontend | files: apps/web/src/lib/markdown.ts, apps/web/src/lib/markdown.test.ts | task: Write a pure markdown helper plus unit tests.',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(helperWithSpec), []);
});

test('openCodeQueuePolicyViolations rejects dependency markers hidden inside task text', () => {
  const hiddenDependency = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: seed | role: backend | files: apps/web/src/fixtures.ts | task: Create fixtures. depends_on: frontend',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.ok(openCodeQueuePolicyViolations(hiddenDependency).some((v) => /dependency marker inside task text/.test(v)));

  const structuredDependency = parsePlanDelegationUnits([
    '<!-- opencode-delegate:start -->',
    '- id: seed | role: backend | files: apps/web/src/fixtures.ts | task: Create fixtures.',
    '- id: card | role: frontend | files: apps/web/src/card.tsx | depends: seed | task: Render fixtures.',
    '<!-- opencode-delegate:end -->',
  ].join('\n'));
  assert.deepEqual(openCodeQueuePolicyViolations(structuredDependency), []);
});

test('openCodeDelegateRoles: default when unset, verbatim when set, sanitized', () => {
  // senior-shipper deliberately absent: deploys/credentials never ride the free tier.
  assert.deepEqual(openCodeDelegateRoles({}), ['senior-tester', 'senior-frontend', 'quick-fix']);
  assert.deepEqual(openCodeDelegateRoles({ openCode: {} }), ['senior-tester', 'senior-frontend', 'quick-fix']);
  assert.deepEqual(openCodeDelegateRoles({ openCode: { delegateRoles: ['senior-backend'] } }), ['senior-backend']);
  // sanitizes non-strings/blanks
  assert.deepEqual(openCodeDelegateRoles({ openCode: { delegateRoles: ['senior-frontend', '', 3, '  '] } }), ['senior-frontend']);
  // explicit empty array = opt out of role delegation
  assert.deepEqual(openCodeDelegateRoles({ openCode: { delegateRoles: [] } }), []);
});

function withTempOpenCodeShim(writeShim: boolean, fn: () => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocshim-'));
  const saved = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(tmp, 'toolchains');
  try {
    if (writeShim) {
      const binDir = stableBinDir();
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'opencode-mcp.cjs'), '// test shim\n', 'utf8');
    }
    fn();
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
    else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const OPENCODE_READY = {
  openCode: { enabled: true },
  toolchain: { opencode: { installedVersion: '1.17.8' } },
};

test('shouldRunRoleOnOpenCode: enabled without installedVersion is false (unified with triage)', () => {
  withTempOpenCodeShim(true, () => {
    assert.equal(shouldRunRoleOnOpenCode('senior-tester', { openCode: { enabled: true } }, 'claude'), false);
    assert.equal(shouldRunRoleOnOpenCode('senior-frontend', { openCode: { enabled: true } }, 'cursor'), false);
  });
});

test('shouldRunRoleOnOpenCode: enabled + installedVersion + missing shim is false', () => {
  withTempOpenCodeShim(false, () => {
    assert.equal(shouldRunRoleOnOpenCode('senior-tester', OPENCODE_READY, 'claude'), false);
    assert.equal(shouldRunRoleOnOpenCode('senior-frontend', OPENCODE_READY, 'cursor'), false);
  });
});

test('shouldRunRoleOnOpenCode: enabled + stamped + shim + role in set + paid host is true', () => {
  withTempOpenCodeShim(true, () => {
    assert.equal(shouldRunRoleOnOpenCode('senior-tester', OPENCODE_READY, 'claude'), true);
    assert.equal(shouldRunRoleOnOpenCode('senior-frontend', OPENCODE_READY, 'claude'), true);
    assert.equal(shouldRunRoleOnOpenCode('senior-frontend', OPENCODE_READY, 'codex'), true);
    assert.equal(shouldRunRoleOnOpenCode('senior-frontend', OPENCODE_READY, 'cursor'), true);
    assert.equal(shouldRunRoleOnOpenCode('senior-backend', OPENCODE_READY, 'claude'), false); // not in default set
    assert.equal(shouldRunRoleOnOpenCode('senior-tester', { openCode: { enabled: false }, toolchain: OPENCODE_READY.toolchain }, 'claude'), false);
    assert.equal(shouldRunRoleOnOpenCode('senior-tester', {}, 'claude'), false);
    assert.equal(shouldRunRoleOnOpenCode('senior-backend', {
      openCode: { enabled: true, delegateRoles: ['senior-backend'] },
      toolchain: OPENCODE_READY.toolchain,
    }, 'claude'), true);
    assert.equal(shouldRunRoleOnOpenCode('senior-frontend', {
      openCode: { enabled: true, delegateRoles: ['senior-backend'] },
      toolchain: OPENCODE_READY.toolchain,
    }, 'claude'), false);
  });
});

test('shouldRunRoleOnOpenCode applies on paid hosts and is inert on OpenCode-compatible self hosts', () => {
  withTempOpenCodeShim(true, () => {
    for (const role of ['senior-frontend', 'senior-tester', 'quick-fix']) {
      assert.equal(shouldRunRoleOnOpenCode(role, OPENCODE_READY, 'claude'), true);
      assert.equal(shouldRunRoleOnOpenCode(role, OPENCODE_READY, 'codex'), true);
      assert.equal(shouldRunRoleOnOpenCode(role, OPENCODE_READY, 'cursor'), true);
      assert.equal(shouldRunRoleOnOpenCode(role, OPENCODE_READY, 'opencode'), false);
      assert.equal(shouldRunRoleOnOpenCode(role, OPENCODE_READY, 'kilo'), false);
    }
    assert.equal(shouldRunRoleOnOpenCode('senior-frontend', {
      openCode: { enabled: true, model: 'opencode/gpt-5.5' },
      toolchain: OPENCODE_READY.toolchain,
    }, 'codex'), true);
  });
});

test('opencode role attempt marker: write then detect (per run + role)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocrole-'));
  try {
    assert.equal(openCodeRoleAttempted(dir, 'run1', 'senior-tester'), false);
    markOpenCodeRoleAttempted(dir, 'run1', 'senior-tester');
    assert.equal(openCodeRoleAttempted(dir, 'run1', 'senior-tester'), true);
    // scoped per role + per run
    assert.equal(openCodeRoleAttempted(dir, 'run1', 'senior-frontend'), false);
    assert.equal(openCodeRoleAttempted(dir, 'run2', 'senior-tester'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gateway outage breaker: mark then detect within TTL; stale/missing/unscoped → inactive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocgw-'));
  try {
    assert.equal(openCodeGatewayOutageActive(dir, 'r1', 60_000), false); // no marker yet
    markOpenCodeGatewayOutage(dir, 'r1');
    assert.equal(openCodeGatewayOutageActive(dir, 'r1', 60_000), true);
    assert.equal(openCodeGatewayOutageActive(dir, 'r1', 0), false);      // ttl 0 → always stale
    assert.equal(openCodeGatewayOutageActive(dir, 'r1', 1_000, Date.now() + 2_000), false); // past the TTL
    assert.equal(openCodeGatewayOutageActive(dir, '', 60_000), false);   // no runId → never active
    assert.equal(openCodeGatewayOutageActive(dir, 'r2', 60_000), false); // scoped per run
    // unparseable marker → inactive (fail open to a normal probe)
    fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', 'r1', 'opencode-gateway-down'), 'not json', 'utf8');
    assert.equal(openCodeGatewayOutageActive(dir, 'r1', 60_000), false);
    // a no-runId mark is a no-op, never a stray file
    markOpenCodeGatewayOutage(dir, '');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', '', 'opencode-gateway-down')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The plan batch marks queue labels ("frontend") while the spawn gate checks
// role ids ("senior-frontend") — markers are normalized so both agree, and
// legacy raw-named markers from older builds still count.
test('attempt markers: senior-frontend and frontend resolve to the same marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocroles-'));
  try {
    markOpenCodeRoleAttempted(dir, 'r1', 'frontend');
    assert.equal(openCodeRoleAttempted(dir, 'r1', 'senior-frontend'), true);
    markOpenCodeRoleAttempted(dir, 'r2', 'senior-tester');
    assert.equal(openCodeRoleAttempted(dir, 'r2', 'tester'), true);
    // Legacy raw marker (written by an older build under the unstripped name).
    const legacy = path.join(dir, '.traffic-one', 'runs', 'r3', 'opencode-attempts');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'senior-frontend'), '', 'utf8');
    assert.equal(openCodeRoleAttempted(dir, 'r3', 'senior-frontend'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan-batch completion markers: queued roles stay pending until terminal marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocplan-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- role: frontend | files: a | task: t\n'
      + '- role: backend | files: b | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    const state = { mode: 'new-project', openCode: { enabled: true }, toolchain: { opencode: { installedVersion: '1.0.0' } } };
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state), ['frontend', 'backend']);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state, 'opencode'), []);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state, 'kilo'), []);
    markOpenCodePlanRoleCompleted(dir, 'run1', 'senior-frontend');
    assert.equal(openCodePlanRoleCompleted(dir, 'run1', 'frontend'), true);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state), ['frontend', 'backend'],
      'per-role markers are diagnostic only; gate stays until terminal batch');
    markOpenCodePlanRoleCompleted(dir, 'run1', 'backend');
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state), ['frontend', 'backend']);
    markOpenCodePlanBatchTerminal(dir, 'run1', 'success');
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state), []);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run2', state), ['frontend', 'backend']);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', { openCode: { enabled: false } }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maintenance plan-batch requires a fresh run-scoped architect queue (assignments.json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmaint-'));
  try {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- role: frontend | files: a | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    const state = {
      mode: 'existing-codebase',
      lifecycle: { phase: 'maintenance' },
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.0.0' } },
    };

    // No run-scoped assignments.json → the durable plan.md is treated as stale
    // (small/triage maintenance work), so the plan-batch stays suppressed.
    assert.equal(hasFreshArchitectQueueForRun(dir, 'run1'), false);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run1', state), false);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state), []);

    // A hand-copied manifest ALONE (no architect digest/agent for the run) must
    // NOT make the queue look fresh (11c: the orchestrator copied the build's
    // assignments.json into a small maintenance run → one dead spawn).
    fs.mkdirSync(path.join(t1, 'runs', 'run1'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'runs', 'run1', 'assignments.json'),
      JSON.stringify({ version: 1, runId: 'run1', createdBy: 'senior-architect', assignments: [] }), 'utf8');
    assert.equal(hasFreshArchitectQueueForRun(dir, 'run1'), false);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run1', state), false);

    // The architect actually ran THIS run (digest on disk) → plan-batch is live.
    fs.mkdirSync(path.join(t1, 'digests', 'run1'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'digests', 'run1', 'architect.md'),
      '# architect digest — run run1\n\nverdict: PLAN_READY\n', 'utf8');
    assert.equal(hasFreshArchitectQueueForRun(dir, 'run1'), true);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run1', state), true);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run1', state), ['frontend']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('new-project mode in MAINTENANCE does not re-run the stale build queue (8c deny #1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmaint-'));
  try {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    // The durable plan.md still carries the BUILD run's queue after settlement.
    fs.writeFileSync(path.join(t1, 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- role: frontend | files: a | task: t\n'
      + '- role: backend | files: b | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    const state = {
      mode: 'new-project',
      lifecycle: { phase: 'maintenance', source: 'prompt-boundary' },
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.0.0' } },
    };

    // Fresh maintenance run, no architect this run → the stale queue must not
    // demand a Step-0 batch (mode stays "new-project" for the project's life).
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-maint', state), false);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run-maint', state), []);

    // An orchestrator-copied manifest (no architect evidence) still suppresses
    // the batch — the exact 11c "Couldn't start" trigger.
    fs.mkdirSync(path.join(t1, 'runs', 'run-maint'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'runs', 'run-maint', 'assignments.json'),
      JSON.stringify({ version: 1, runId: 'run-maint', createdBy: 'senior-architect', assignments: [] }), 'utf8');
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-maint', state), false);

    // A complex maintenance run that ACTUALLY re-entered the architect (fresh
    // manifest + architect digest) re-activates the plan batch.
    fs.mkdirSync(path.join(t1, 'digests', 'run-maint'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'digests', 'run-maint', 'architect.md'),
      '# architect digest — run run-maint\n\nverdict: PLAN_READY\n', 'utf8');
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-maint', state), true);

    // Building phase (no lifecycle yet) is unchanged: the queue gates implementers.
    const building = { ...state, lifecycle: undefined };
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-build', building), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a recorded senior-architect agent also counts as architect-run evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocagentev-'));
  try {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(path.join(t1, 'runs', 'run-a'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'runs', 'run-a', 'assignments.json'),
      JSON.stringify({ version: 1, runId: 'run-a', createdBy: 'senior-architect', assignments: [] }), 'utf8');
    assert.equal(hasFreshArchitectQueueForRun(dir, 'run-a'), false, 'manifest alone is not evidence');
    fs.writeFileSync(path.join(t1, 'runs', 'run-a', 'agents.json'), JSON.stringify({
      version: 1,
      agents: { 'senior-architect': { agentId: 'arch-1', recordedAt: 'x' } },
    }), 'utf8');
    assert.equal(hasFreshArchitectQueueForRun(dir, 'run-a'), true, 'registry entry is evidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan-batch per-role markers alone do not clear gate without terminal batch.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocrole-only-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- role: frontend | files: a | task: t\n'
      + '- role: backend | files: b | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    const state = {
      mode: 'new-project',
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.0.0' } },
    };
    markOpenCodePlanRoleCompleted(dir, 'run-role-only', 'frontend');
    markOpenCodePlanRoleCompleted(dir, 'run-role-only', 'backend');
    assert.equal(openCodePlanBatchComplete(dir, 'run-role-only'), false);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-role-only', state), true);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-role-only', state, 'opencode'), false);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-role-only', state, 'kilo'), false);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run-role-only', state), ['frontend', 'backend']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan-batch zero-byte legacy role markers do not count as completed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oczero-'));
  try {
    const batchDir = path.join(dir, '.traffic-one', 'runs', 'run-zero', 'opencode-plan-batch');
    fs.mkdirSync(batchDir, { recursive: true });
    fs.writeFileSync(path.join(batchDir, 'frontend'), '');
    assert.equal(openCodePlanRoleCompleted(dir, 'run-zero', 'frontend'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('plan-batch COMPLETE marker clears implementer gate immediately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-occomplete-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- role: frontend | files: a | task: t\n'
      + '- role: backend | files: b | task: t\n'
      + '- role: tester | files: c | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    const state = {
      mode: 'new-project',
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.0.0' } },
    };
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-complete', state), true);
    markOpenCodePlanBatchComplete(dir, 'run-complete');
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-complete', state), false);
    assert.deepEqual(pendingOpenCodePlanRoles(dir, 'run-complete', state), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The unit-kind catalog is the canonical delegation policy — visible, typed,
// and asserted so prose drift gets caught here.
test('plan-batch batch.json lifecycle: running is idempotent, terminal is single-writer, fail-open clears gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocbatch-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- id: fe-1 | role: frontend | files: a.ts | task: t\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    const state = {
      mode: 'new-project',
      openCode: { enabled: true },
      toolchain: { opencode: { installedVersion: '1.0.0' } },
    };
    assert.equal(readOpenCodePlanBatchState(dir, 'run-batch'), null);
    markOpenCodePlanBatchRunning(dir, 'run-batch');
    markOpenCodePlanBatchRunning(dir, 'run-batch');
    const running = readOpenCodePlanBatchState(dir, 'run-batch');
    assert.equal(running?.outcome, 'running');
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-batch', state), true);
    markOpenCodePlanBatchTerminal(dir, 'run-batch', 'failed', 'every unit failed');
    markOpenCodePlanBatchTerminal(dir, 'run-batch', 'success');
    const terminal = readOpenCodePlanBatchState(dir, 'run-batch');
    assert.equal(terminal?.outcome, 'failed');
    assert.equal(openCodePlanBatchComplete(dir, 'run-batch'), true);
    assert.equal(shouldBlockImplementerForPlanBatch(dir, 'run-batch', state), false);
    markOpenCodePlanBatchComplete(dir, 'run-batch-2');
    assert.equal(readOpenCodePlanBatchState(dir, 'run-batch-2')?.outcome, 'success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deriveBatchOutcomeFromUnits classifies delegated, failed, partial, and abandoned batches', () => {
  assert.equal(deriveBatchOutcomeFromUnits([{ action: 'delegated' }]), 'success');
  assert.equal(deriveBatchOutcomeFromUnits([{ action: 'delegated' }, { action: 'delegated' }]), 'success');
  assert.equal(deriveBatchOutcomeFromUnits([{ action: 'failed' }, { action: 'skipped' }]), 'failed');
  assert.equal(deriveBatchOutcomeFromUnits([{ action: 'delegated' }, { action: 'failed' }]), 'partial');
  assert.equal(deriveBatchOutcomeFromUnits([{ action: 'delegated' }, { action: 'skipped' }]), 'partial');
  assert.equal(deriveBatchOutcomeFromUnits([{ action: 'abandoned' }], 'stopped polling'), 'abandoned');
  assert.equal(deriveBatchOutcomeFromUnits([]), 'failed');
});

test('OPENCODE_DELEGATE_UNIT_KINDS catalog: bounded kinds present, never-list intact, shipper excluded', async () => {
  const { OPENCODE_DELEGATE_UNIT_KINDS, OPENCODE_NEVER_DELEGATE, DEFAULT_OPENCODE_DELEGATE_ROLES } = await import('../../config/opencode-delegation');
  const ids = OPENCODE_DELEGATE_UNIT_KINDS.map((k) => k.id);
  for (const required of ['fixtures-seed-data', 'pure-helpers', 'i18n-catalogs', 'test-scaffolding', 'qa-report-sweep', 'reviewer-input-sweeps', 'docs-draft', 'mechanical-refactor']) {
    assert.ok(ids.includes(required), `missing unit kind: ${required}`);
  }
  assert.ok(OPENCODE_NEVER_DELEGATE.some((s) => /security|RLS/i.test(s)));
  assert.ok(OPENCODE_NEVER_DELEGATE.some((s) => /credential|deploy/i.test(s)));
  // The .traffic-one project-memory baseline is architect-owned, never delegated
  // (the 5b/Cursor partial-baseline bug: the docs delegate wrote only README/.env).
  assert.ok(
    OPENCODE_NEVER_DELEGATE.some((s) => /\.traffic-one/.test(s) && /baseline/i.test(s)),
    'the .traffic-one memory baseline must be on the never-delegate list',
  );
  // The docs-draft unit kind must scope to ROOT human docs, not the .traffic-one baseline.
  const docsDraft = OPENCODE_DELEGATE_UNIT_KINDS.find((k) => k.id === 'docs-draft');
  assert.ok(docsDraft && /\.traffic-one/.test(docsDraft.summary) && /never/i.test(docsDraft.summary),
    'docs-draft must explicitly exclude the .traffic-one baseline');
  assert.ok(!DEFAULT_OPENCODE_DELEGATE_ROLES.includes('senior-shipper'), 'shipper must not ride the free tier by default');
});

// The 5b/Cursor failure: the architect wrote only 4 of the baseline files and
// emitted PLAN_READY anyway, because the memory baseline (unlike the workspace
// scaffold) had no hard ls-verify gate. Lock the gate into the role doc so it
// can't silently regress to soft "mandatory" prose again.
test('senior-architect agent.md enforces Phase order with OpenCode Step 0 before implementers', () => {
  const doc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'modules', 'senior-architect', 'agent.md'),
    'utf8',
  );
  assert.match(doc, /## Phase order/);
  assert.match(doc, /OpenCode batch/);
  assert.match(doc, /opencode_delegate_from_plan/);
  assert.match(doc, /backend \+ frontend in parallel/);
});

test('senior-architect agent.md names start/end OpenCode queue markers, not a bare HTML comment', () => {
  const doc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'modules', 'senior-architect', 'agent.md'),
    'utf8',
  );
  assert.match(doc, /opencode-delegate:start/);
  assert.match(doc, /opencode-delegate:end/);
  assert.doesNotMatch(doc, /<!-- opencode-delegate -->/);
});

test('senior-architect agent.md enforces the full .traffic-one memory baseline before PLAN_READY', () => {
  const doc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'modules', 'senior-architect', 'agent.md'),
    'utf8',
  );
  assert.match(doc, /Required project-memory baseline/, 'baseline subsection present');
  // Every canonical baseline file is named in the hard ls-verify rule.
  for (const f of ['coding', 'security', 'api', 'database', 'deployment', 'environment-setup']) {
    assert.ok(doc.includes(`${f}.md`) || doc.includes(`${f},`) || doc.includes(`,${f}`),
      `baseline file ${f}.md must be enumerated in the architect doc`);
  }
  assert.match(doc, /ls .*\.traffic-one.*decisions\/\*\.md/, 'hard ls-verify gate present');
  assert.match(doc, /MUST NOT be delegated to OpenCode|not delegate the `?\.traffic-one/, 'never-delegate note present');
});

// The 9b/Cursor failure: the agent printed "Cursor doesn't expose senior-architect
// subagents" and simulated the team, even though the runtime fully supports Cursor
// subagents (Task tool + materialized .cursor/agents/<role>.md). The orchestrator skill
// + team rule must name Cursor's spawn tool and must NOT group Cursor as a no-subagent
// host in the spawn decision — lock that into the prose so it can't regress.
test('orchestrator + team prose name Cursor as a first-class subagent host (Task tool), not no-subagent', () => {
  const modules = path.join(__dirname, '..', '..', 'modules');
  const skill = fs.readFileSync(path.join(modules, 'skills', 'skills-catalog', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  const teamRule = fs.readFileSync(path.join(modules, 'rules', 'rules', 'common', 'senior-engineer-team.md'), 'utf8');
  // The skill names Cursor's concrete spawn tool.
  assert.match(skill, /Cursor\s*=\s*the `Task` tool/, 'orchestrator skill must name Cursor = the `Task` tool');
  assert.match(skill, /first-class subagent host/i, 'skill must affirm Cursor is a first-class subagent host');
  // The misleading phrasing that grouped Cursor under "no subagent" is gone.
  assert.doesNotMatch(skill, /no subagent barrier such as Cursor/i, 'must not group Cursor under "no subagent barrier"');
  // The team rule names Cursor's Task+resume continuation primitive.
  assert.match(teamRule, /Cursor.*`Task` tool.*resume|resume.*Cursor/i, 'team rule must name Cursor Task+resume continuation');
});

// The 13b failure: the architect's FIRST spawn hit a one-time materialization
// readiness deny ("New subagent — Couldn't start"), and composer fell back to
// building the role inline instead of re-spawning. Both docs must instruct a
// re-spawn-before-inline-fallback so a retryable deny never drops to main-agent.
test('orchestrator + team prose: a denied/"Couldn\'t start" first spawn must RE-SPAWN, never fall back to inline', () => {
  const modules = path.join(__dirname, '..', '..', 'modules');
  const skill = fs.readFileSync(path.join(modules, 'skills', 'skills-catalog', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  const teamRule = fs.readFileSync(path.join(modules, 'rules', 'rules', 'common', 'senior-engineer-team.md'), 'utf8');
  for (const [name, doc] of [['orchestrator SKILL', skill], ['team rule', teamRule]] as const) {
    assert.match(doc, /re-?spawn/i, `${name} must instruct a re-spawn`);
    assert.match(doc, /couldn'?t start|denied/i, `${name} must name the Couldn't-start/denied case`);
    assert.match(doc, /(not|never)[^.\n]*inline/i, `${name} must forbid building the role inline on a first spawn failure`);
  }
});

test('Kilo prose requires built-in general plus the marker-bound project role contract', () => {
  const modules = path.join(__dirname, '..', '..', 'modules');
  const skill = fs.readFileSync(path.join(modules, 'skills', 'skills-catalog', 'senior-eng-orchestrator', 'SKILL.md'), 'utf8');
  const teamRule = fs.readFileSync(path.join(modules, 'rules', 'rules', 'common', 'senior-engineer-team.md'), 'utf8');
  const promptTemplates = fs.readFileSync(
    path.join(modules, 'skills', 'skills-catalog', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  for (const [name, doc] of [['orchestrator SKILL', skill], ['team rule', teamRule], ['prompt templates', promptTemplates]] as const) {
    assert.match(doc, /Kilo/i, `${name} must name Kilo`);
    assert.match(doc, /\.kilo\/agents/, `${name} must name Kilo's project role directory`);
    assert.match(doc, /\[t1-role: senior-<role>\]/, `${name} must require the marker-bound role contract`);
    assert.match(doc, /not|do not|never/i, `${name} must include a negative guard`);
    assert.match(doc, /general/i, `${name} must use Kilo's writable built-in general worker`);
    assert.match(doc, /explore/i, `${name} must explicitly reject explore`);
  }
});

test('Cursor/frontend prompts require demo seed data when Supabase env is missing', () => {
  const modules = path.join(__dirname, '..', '..', 'modules');
  const promptTemplates = fs.readFileSync(
    path.join(modules, 'skills', 'skills-catalog', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
    'utf8',
  );
  const teamRule = fs.readFileSync(path.join(modules, 'rules', 'rules', 'common', 'senior-engineer-team.md'), 'utf8');
  for (const [name, doc] of [['frontend prompt template', promptTemplates], ['team rule', teamRule]] as const) {
    assert.match(doc, /demo\/seed/i, `${name} must require product-specific demo/seed data`);
    assert.match(doc, /missing[- ]env|Missing Supabase\/env|missing-config/i, `${name} must name missing-env/config surfaces`);
    assert.match(doc, /blank panels|sparse UI/i, `${name} must reject sparse missing-config UI`);
  }
});
