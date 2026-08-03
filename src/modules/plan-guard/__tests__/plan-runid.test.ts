import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runIdPathViolation } from '../plan-runid';

// Block stub: returns the verbatim fallback (the prose ships in TS), with vars echoed
// so the test can assert the corrective names both ids.
const block = (_name: string, fallback: string, vars?: Record<string, unknown>): string =>
  `${fallback}__${vars ? JSON.stringify(vars) : ''}`;

const CURRENT = '1781698183648';

test('runIdPathViolation: denies a write to a stray (date/ISO) runs/<id> path, naming currentRunId', () => {
  const v = runIdPathViolation({
    state: { currentRunId: CURRENT },
    relTargets: ['.traffic-one/runs/2026-06-17T12-09-40Z/assignments.json'],
    command: '',
    block,
  });
  assert.ok(v, 'expected a violation');
  assert.match(v as string, new RegExp(CURRENT));               // correct id named
  assert.match(v as string, /2026-06-17T12-09-40Z/);            // stray id named
  assert.match(v as string, /"EXPECTED":"1781698183648"/);      // vars passed for SKILL prose
});

test('runIdPathViolation: allows the correct currentRunId path and non-run paths', () => {
  assert.equal(runIdPathViolation({
    state: { currentRunId: CURRENT },
    relTargets: [`.traffic-one/runs/${CURRENT}/assignments.json`, 'apps/web/src/x.ts'],
    command: '',
    block,
  }), null);
});

test('runIdPathViolation: catches a stray id in a shell redirect command', () => {
  const v = runIdPathViolation({
    state: { currentRunId: CURRENT },
    relTargets: [],
    command: 'node -e "..." > .traffic-one/runs/2026-06-17T12-09-40Z/assignments.json',
    block,
  });
  assert.ok(v);
  assert.match(v as string, /2026-06-17T12-09-40Z/);
});

test('runIdPathViolation: a pure READ of a stray runs/<id> path does NOT deny (11c)', () => {
  // The run-id-announce hook can point the agent at a now-stale id; reading that
  // orphaned run dir strands no state, so a read-only command must not be denied.
  for (const command of [
    "sed -n '1,80p' .traffic-one/runs/2026-06-17T12-09-40Z/model-policy.json",
    'cat .traffic-one/runs/2026-06-17T12-09-40Z/run.json',
    'find .traffic-one/runs/2026-06-17T12-09-40Z -type f',
  ]) {
    assert.equal(runIdPathViolation({ state: { currentRunId: CURRENT }, relTargets: [], command, block }), null,
      `read must not deny: ${command}`);
  }
});

test('runIdPathViolation: a cp/mv WRITE to a stray runs/<id> path still denies', () => {
  for (const command of [
    'cp ./x.json .traffic-one/runs/2026-06-17T12-09-40Z/assignments.json',
    'mv ./x.json .traffic-one/digests/2026-06-17T12-09-40Z/architect.md',
    'tee .traffic-one/runs/2026-06-17T12-09-40Z/run.json < x',
  ]) {
    const v = runIdPathViolation({ state: { currentRunId: CURRENT }, relTargets: [], command, block });
    assert.ok(v, `write must deny: ${command}`);
    assert.match(v as string, /2026-06-17T12-09-40Z/);
  }
});

test('runIdPathViolation: no currentRunId → no enforcement (returns null)', () => {
  assert.equal(runIdPathViolation({
    state: {},
    relTargets: ['.traffic-one/runs/2026-06-17T12-09-40Z/assignments.json'],
    command: '',
    block,
  }), null);
});

test('runIdPathViolation: a WRITE to a literal <run-id> placeholder path still denies', () => {
  // The SPAWN gate tolerates the template placeholder in prompts; the WRITE guard
  // must not — a child that writes to the literal path would strand run state
  // under a `runs/<run-id>/` dir. Regression guard for the spawn-side tolerance.
  const v = runIdPathViolation({
    state: { currentRunId: CURRENT },
    relTargets: ['.traffic-one/runs/<run-id>/assignments.json'],
    command: '',
    block,
  });
  assert.ok(v, 'placeholder write must violate');
  assert.match(v as string, /<run-id>/);
  assert.match(v as string, new RegExp(CURRENT));
});
