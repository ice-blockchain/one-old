import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assignmentWriterRole, digestClaimsVerdict } from '../contracts';

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-contracts-writer-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('assignmentWriterRole uses activeAgentRole only when no run-agent state exists', () => {
  withProject((cwd) => {
    const legacy = { currentRunId: 'R', activeAgentRole: 'senior-architect' };
    assert.equal(
      assignmentWriterRole(cwd, legacy, null),
      'senior-architect',
      'legacy runs without claims/assignments still fall back',
    );

    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'R'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'assignments.json'), '{}', 'utf8');
    assert.equal(
      assignmentWriterRole(cwd, legacy, null),
      null,
      'parent must not forge PLAN_READY/APPROVED/TESTS_GREEN via activeAgentRole once run-agent state exists',
    );
  });
});

test('digestClaimsVerdict agrees with settlement on every verdict line and fails closed on conflict', () => {
  assert.equal(digestClaimsVerdict('verdict: IMPLEMENTED\n', 'IMPLEMENTED'), true);
  assert.equal(digestClaimsVerdict('verdict: TESTS_GREEN — 37 tests passed.\n', 'TESTS_GREEN'), true);
  assert.equal(digestClaimsVerdict('verdict: TESTS_GREEN\nverdict: TESTS_GREEN\n', 'TESTS_GREEN'), true);

  assert.equal(
    digestClaimsVerdict('verdict: IMPLEMENTED\nverdict: BLOCKED\n', 'IMPLEMENTED'),
    false,
    'conflicting verdict lines fail closed',
  );
  assert.equal(
    digestClaimsVerdict('verdict: TESTS_GREEN — was TESTS_FAILING\n', 'TESTS_GREEN'),
    false,
    'trailing other machine token on the verdict line fails closed',
  );
  assert.equal(
    digestClaimsVerdict('verdict: BLOCKED before this role can emit IMPLEMENTED\n', 'IMPLEMENTED'),
    false,
    'a verdict line claiming BLOCKED is not IMPLEMENTED even if the token appears later',
  );
});

test('digestClaimsVerdict keeps bare-word for completion gates and drops it for the compile trigger', () => {
  assert.equal(
    digestClaimsVerdict('The frontend is IMPLEMENTED and ready.\n', 'IMPLEMENTED'),
    true,
    'prose IMPLEMENTED without a verdict line still triggers completion gates',
  );
  assert.equal(
    digestClaimsVerdict('End with PLAN_READY after the ADR.\n', 'PLAN_READY', { allowBareWord: false }),
    false,
    'compile trigger does not treat a bare PLAN_READY mention as a compile claim',
  );
  assert.equal(
    digestClaimsVerdict('verdict: PLAN_READY\n', 'PLAN_READY', { allowBareWord: false }),
    true,
  );
});
