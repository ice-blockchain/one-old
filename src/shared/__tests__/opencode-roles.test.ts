import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  markOpenCodeRoleAttempted,
  openCodeDelegateRoles,
  openCodeRoleAttempted,
  shouldRunRoleOnOpenCode,
} from '../opencode-roles';

test('openCodeDelegateRoles: default when unset, verbatim when set, sanitized', () => {
  assert.deepEqual(openCodeDelegateRoles({}), ['senior-shipper', 'senior-tester', 'senior-frontend', 'quick-fix']);
  assert.deepEqual(openCodeDelegateRoles({ openCode: {} }), ['senior-shipper', 'senior-tester', 'senior-frontend', 'quick-fix']);
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
