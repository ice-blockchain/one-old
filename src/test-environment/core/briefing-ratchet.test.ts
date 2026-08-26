// Unit coverage for the briefing-class first-attempt tally and the decision-log
// mapper. The end-to-end ratchet is a run-sim assertion; this file pins the
// classification rules so a transcript field rename cannot silently empty it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertion as briefingAssertion } from '../assertions/run-sim-briefing-ratchet.assert';
import { assertionSpecsForRun } from './case-runner';
import type { AssertionContext, Case } from './types';
import {
  tallyEventsFromDecisions,
  tallyFirstAttemptBriefing,
} from './briefing-ratchet';

test('briefing id at spawnIndex 1 is counted', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'default-export', spawnIndex: 1, host: 'claude' },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, [
    { denyId: 'default-export', spawnIndex: 1, host: 'claude' },
  ]);
});

test('briefing id at spawnIndex 2 is not a first-attempt briefing', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'default-export', spawnIndex: 2, host: 'claude' },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, []);
});

test('sequencing and safety at spawnIndex 1 are not briefing', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'architect-phase-incomplete', spawnIndex: 1, host: 'claude' },
    { denyId: 'workspace-boundary-guard', spawnIndex: 1, host: 'cursor' },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, []);
  assert.deepEqual(tally.namedRatchetHits, []);
});

test('named ids are always counted in namedRatchetHits', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'default-export', spawnIndex: 1, host: 'claude' },
    { denyId: 'no-any', spawnIndex: 2, host: 'cursor' },
    { denyId: 'performance-model-param', spawnIndex: 3, host: 'codex' },
    { denyId: 'repaired-materialization', spawnIndex: 1, host: 'claude' },
    { denyId: 'onboarding-server-deny-first', spawnIndex: 2, host: 'kilo' },
  ]);
  assert.deepEqual(tally.namedRatchetHits, [
    { denyId: 'default-export', spawnIndex: 1, host: 'claude' },
    { denyId: 'no-any', spawnIndex: 2, host: 'cursor' },
    { denyId: 'performance-model-param', spawnIndex: 3, host: 'codex' },
    { denyId: 'repaired-materialization', spawnIndex: 1, host: 'claude' },
    { denyId: 'onboarding-server-deny-first', spawnIndex: 2, host: 'kilo' },
  ]);
  assert.deepEqual(
    tally.briefingFirstAttempt.map((hit) => hit.denyId),
    ['default-export'],
  );
});

test('expected:true rows are ignored', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'default-export', spawnIndex: 1, host: 'claude', expected: true },
    { denyId: 'no-any', spawnIndex: 1, host: 'claude', expected: true },
    { denyId: 'onboarding-server-deny-first', spawnIndex: 1, host: 'claude', expected: true },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, []);
  assert.deepEqual(tally.namedRatchetHits, []);
});

test('unknown or missing denyId cannot be classified as briefing', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'not-a-real-deny-id', spawnIndex: 1, host: 'claude' },
    { spawnIndex: 1, host: 'claude' },
    { denyId: null, spawnIndex: 1, host: 'claude' },
    { denyId: '', spawnIndex: 1, host: 'claude' },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, []);
  assert.deepEqual(tally.namedRatchetHits, []);
});

test('omitted spawnIndex counts only on the first unexpected (host, denyId) pair', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'no-any', host: 'claude' },
    { denyId: 'no-any', host: 'claude' },
    { denyId: 'no-any', host: 'cursor' },
    { denyId: 'default-export', spawnIndex: 2, host: 'claude' },
    { denyId: 'default-export', host: 'claude' },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, [
    { denyId: 'no-any', spawnIndex: 1, host: 'claude' },
    { denyId: 'no-any', spawnIndex: 1, host: 'cursor' },
  ]);
});

test('recorded spawnIndex 0 is not a first attempt (runtime is 1-based)', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'default-export', spawnIndex: 0, host: 'claude' },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, []);
  assert.deepEqual(tally.namedRatchetHits, [
    { denyId: 'default-export', spawnIndex: 0, host: 'claude' },
  ]);
});

test('onboarding-server-deny-first is named but not briefing', () => {
  const tally = tallyFirstAttemptBriefing([
    { denyId: 'onboarding-server-deny-first', spawnIndex: 1, host: 'claude' },
  ]);
  assert.deepEqual(tally.briefingFirstAttempt, []);
  assert.deepEqual(tally.namedRatchetHits, [
    { denyId: 'onboarding-server-deny-first', spawnIndex: 1, host: 'claude' },
  ]);
});

test('tallyEventsFromDecisions maps deny records and omits spawnIndex', () => {
  const events = tallyEventsFromDecisions([
    { decision: 'allow', denyId: 'default-export', host: 'claude' },
    { decision: 'deny', denyId: 'default-export', host: 'claude' },
    { decision: 'deny', denyId: 'architect-phase-incomplete', host: 'cursor' },
    { decision: 'context', denyId: 'repaired-materialization', host: 'claude' },
  ]);
  assert.deepEqual(events, [
    { denyId: 'default-export', host: 'claude' },
    { denyId: 'architect-phase-incomplete', host: 'cursor' },
  ]);
  const tally = tallyFirstAttemptBriefing(events);
  assert.deepEqual(tally.briefingFirstAttempt, [
    { denyId: 'default-export', spawnIndex: 1, host: 'claude' },
  ]);
});

test('tallyEventsFromDecisions forwards a caller-resolved spawnIndex', () => {
  const events = tallyEventsFromDecisions(
    [{ decision: 'deny', denyId: 'no-any', host: 'claude' }],
    2,
  );
  assert.deepEqual(events, [
    { denyId: 'no-any', host: 'claude', spawnIndex: 2 },
  ]);
  assert.deepEqual(tallyFirstAttemptBriefing(events).briefingFirstAttempt, []);
});

const RUN_SIM_CASE: Case = {
  id: 'sim-ratchet-fixture',
  category: 'run-sim',
  layer: 'run-sim',
  fixture: 'empty-git',
  preSeed: { mode: 'new-project' },
  assertions: [{ id: 'run-sim-clean' }],
};

test('run-sim cases receive the briefing ratchet invariant', () => {
  assert.deepEqual(
    assertionSpecsForRun(RUN_SIM_CASE, 'pure-node').map((spec) => spec.id),
    ['run-sim-clean', 'consent-fence', 'run-sim-briefing-ratchet'],
  );
});

function assertionContext(caseFolder: string): AssertionContext {
  return {
    cwd: caseFolder,
    caseFolder,
    env: {},
    members: [],
    host: 'pure-node',
    testCase: RUN_SIM_CASE,
    spec: { id: 'run-sim-briefing-ratchet' },
    hostResult: { status: 'COMPLETED', exitCode: 0, durationMs: 1 },
  };
}

test('assertion fails a first-attempt briefing deny and names id/index/host/path/role', async () => {
  const caseFolder = fs.mkdtempSync(path.join(os.tmpdir(), 't1-briefing-ratchet-'));
  try {
    fs.writeFileSync(path.join(caseFolder, 'run-sim.json'), `${JSON.stringify({
      ok: true,
      writes: [
        {
          denied: true,
          expected: true,
          denyId: 'default-export',
          spawnIndex: 1,
          host: 'claude',
          path: 'src/expected.ts',
          role: 'senior-frontend',
        },
        {
          denied: true,
          denyId: 'default-export',
          spawnIndex: 1,
          host: 'claude',
          path: 'src/App.tsx',
          role: 'senior-frontend',
        },
      ],
      spawns: [],
    })}\n`, 'utf8');
    const outcome = await briefingAssertion.run(assertionContext(caseFolder));
    assert.equal(outcome.status, 'FAIL');
    assert.match(outcome.detail, /default-export/);
    assert.match(outcome.detail, /spawnIndex=1/);
    assert.match(outcome.detail, /host=claude/);
    assert.match(outcome.detail, /senior-frontend/);
    assert.match(outcome.detail, /src\/App\.tsx/);
    assert.doesNotMatch(outcome.detail, /src\/expected\.ts/);
  } finally {
    fs.rmSync(caseFolder, { recursive: true, force: true });
  }
});

test('assertion passes a clean transcript and fails when the transcript is missing', async () => {
  const caseFolder = fs.mkdtempSync(path.join(os.tmpdir(), 't1-briefing-ratchet-'));
  try {
    const missing = await briefingAssertion.run(assertionContext(caseFolder));
    assert.equal(missing.status, 'FAIL');
    assert.match(missing.detail, /never started/);

    fs.writeFileSync(path.join(caseFolder, 'run-sim.json'), `${JSON.stringify({
      ok: true,
      writes: [
        { denied: false, host: 'claude', path: 'src/App.tsx', role: 'senior-frontend', spawnIndex: 1 },
        {
          denied: true,
          expected: true,
          denyId: 'default-export',
          spawnIndex: 1,
          host: 'claude',
          path: 'src/bad.ts',
          role: 'senior-frontend',
        },
      ],
      spawns: [
        {
          denied: true,
          expected: true,
          denyId: 'spawn-bounded-scope-missing',
          spawnIndex: 1,
          host: 'claude',
          role: 'quick-fix',
          phase: 'leg-3:unscoped',
        },
      ],
    })}\n`, 'utf8');
    const passed = await briefingAssertion.run(assertionContext(caseFolder));
    assert.equal(passed.status, 'PASS');
  } finally {
    fs.rmSync(caseFolder, { recursive: true, force: true });
  }
});
