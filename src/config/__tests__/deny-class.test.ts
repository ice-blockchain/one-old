import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DENY_CLASSES,
  DENY_ID_CLASS,
  DENY_IDS,
  NEVER_OVERRIDABLE_DENY_ID_SET,
  denyClassOf,
  isDenyClass,
  type DenyId,
} from '../deny-ids';

test('DENY_ID_CLASS keys are exactly DENY_IDS', () => {
  assert.deepEqual(
    Object.keys(DENY_ID_CLASS).slice().sort(),
    DENY_IDS.slice().sort(),
  );
});

test('every DENY_ID_CLASS value is one of the six DENY_CLASSES', () => {
  for (const value of Object.values(DENY_ID_CLASS)) {
    assert.ok(isDenyClass(value), `unexpected class ${JSON.stringify(value)}`);
  }
});

test('denyClassOf returns DENY_ID_CLASS for every id', () => {
  for (const id of DENY_IDS) {
    assert.equal(denyClassOf(id), DENY_ID_CLASS[id]);
  }
});

test('Tech Lead class pins', () => {
  const pins: ReadonlyArray<readonly [DenyId, (typeof DENY_CLASSES)[number]]> = [
    ['default-export', 'briefing'],
    ['repaired-materialization', 'process'],
    ['architect-phase-incomplete', 'sequencing'],
    ['onboarding-server-deny-first', 'user-required'],
    ['workspace-boundary-guard', 'safety'],
    ['pipeline-handler-crashed', 'fault'],
    ['verify-batch-running', 'process'],
    ['agent-materialization-deny', 'process'],
    ['spawn-host-capability-missing', 'process'],
    ['tester-no-test-evidence-disclosure', 'briefing'],
    ['user-approval-request', 'user-required'],
  ];
  for (const [id, expected] of pins) {
    assert.equal(denyClassOf(id), expected);
  }
});

test('Process class is exactly the pinned set', () => {
  const pinned = [
    'apply-patch-reconstruction-failed',
    'agent-activity-exploration-cap',
    'verify-batch-running',
    'agent-reuse-await-codex-meta',
    'agent-reuse-await-cursor-id',
    'agent-materialization-deny',
    'spawn-claim-unavailable',
    'spawn-model-policy-unavailable',
    'spawn-host-capability-missing',
    'materialization-gate',
    'repaired-materialization',
    'onboarding-server-start-timeout',
  ] as const satisfies readonly DenyId[];
  assert.deepEqual(
    (Object.keys(DENY_ID_CLASS) as DenyId[])
      .filter((id) => DENY_ID_CLASS[id] === 'process')
      .sort(),
    pinned.slice().sort(),
  );
});

// Later Process→allow+context must not lift never-overridable ids.
test('Process ∩ NEVER_OVERRIDABLE is empty', () => {
  const overlap = (Object.keys(DENY_ID_CLASS) as DenyId[]).filter(
    (id) => DENY_ID_CLASS[id] === 'process' && NEVER_OVERRIDABLE_DENY_ID_SET.has(id),
  );
  assert.deepEqual(overlap, []);
});

// LIVE spawn-path id. agent-materialization-deny is the unused sibling already
// pinned as process.
test('agent-materialization-missing is fault', () => {
  assert.equal(denyClassOf('agent-materialization-missing'), 'fault');
});

test('isDenyClass rejects non-classes', () => {
  assert.equal(isDenyClass('blocked'), false);
  assert.equal(isDenyClass(''), false);
  assert.equal(isDenyClass(1), false);
});

// Class is independent of NEVER_OVERRIDABLE. These two facts stay true so a
// later editor does not "fix" class to match the never-overridable set.
test('class does not have to match NEVER_OVERRIDABLE', () => {
  assert.equal(denyClassOf('frontend-structure-completion-gate'), 'briefing');
  assert.ok(NEVER_OVERRIDABLE_DENY_ID_SET.has('frontend-structure-completion-gate'));
  assert.equal(denyClassOf('pipeline-handler-crashed'), 'fault');
  assert.ok(NEVER_OVERRIDABLE_DENY_ID_SET.has('pipeline-handler-crashed'));
});
