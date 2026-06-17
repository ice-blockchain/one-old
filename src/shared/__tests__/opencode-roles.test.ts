import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  markOpenCodeRoleAttempted,
  openCodeDelegateRoles,
  openCodeRoleAttempted,
  planDelegationQueueRoles,
  roleHasQueuedUnits,
  shouldRunRoleOnOpenCode,
} from '../opencode-roles';

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

test('shouldRunRoleOnOpenCode: requires enabled + role in the configured set', () => {
  const enabled = { openCode: { enabled: true } };
  assert.equal(shouldRunRoleOnOpenCode('senior-tester', enabled), true);   // default set
  assert.equal(shouldRunRoleOnOpenCode('senior-frontend', enabled), true);
  assert.equal(shouldRunRoleOnOpenCode('senior-backend', enabled), false); // not in default set
  assert.equal(shouldRunRoleOnOpenCode('senior-tester', { openCode: { enabled: false } }), false); // not enabled
  assert.equal(shouldRunRoleOnOpenCode('senior-tester', {}), false);
  // honors a custom set
  assert.equal(shouldRunRoleOnOpenCode('senior-backend', { openCode: { enabled: true, delegateRoles: ['senior-backend'] } }), true);
  assert.equal(shouldRunRoleOnOpenCode('senior-frontend', { openCode: { enabled: true, delegateRoles: ['senior-backend'] } }), false);
});

test('shouldRunRoleOnOpenCode is host-agnostic (same on Codex, Claude, Cursor)', () => {
  const enabled = { openCode: { enabled: true } };
  // OpenCode is a local CLI invoked identically on every host — no per-host gate.
  for (const role of ['senior-frontend', 'senior-tester', 'quick-fix']) {
    assert.equal(shouldRunRoleOnOpenCode(role, enabled), true);
  }
  // a pinned model does not change eligibility — only enabled + role-in-set do
  assert.equal(shouldRunRoleOnOpenCode('senior-frontend', { openCode: { enabled: true, model: 'opencode/gpt-5.1-codex' } }), true);
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

// The unit-kind catalog is the canonical delegation policy — visible, typed,
// and asserted so prose drift gets caught here.
test('OPENCODE_DELEGATE_UNIT_KINDS catalog: bounded kinds present, never-list intact, shipper excluded', async () => {
  const { OPENCODE_DELEGATE_UNIT_KINDS, OPENCODE_NEVER_DELEGATE, DEFAULT_OPENCODE_DELEGATE_ROLES } = await import('../../config/opencode');
  const ids = OPENCODE_DELEGATE_UNIT_KINDS.map((k) => k.id);
  for (const required of ['fixtures-seed-data', 'pure-helpers', 'i18n-catalogs', 'test-scaffolding', 'qa-report-sweep', 'reviewer-input-sweeps', 'docs-draft', 'mechanical-refactor']) {
    assert.ok(ids.includes(required), `missing unit kind: ${required}`);
  }
  assert.ok(OPENCODE_NEVER_DELEGATE.some((s) => /security|RLS/i.test(s)));
  assert.ok(OPENCODE_NEVER_DELEGATE.some((s) => /credential|deploy/i.test(s)));
  assert.ok(!DEFAULT_OPENCODE_DELEGATE_ROLES.includes('senior-shipper'), 'shipper must not ride the free tier by default');
});
