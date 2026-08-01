// Per-role tool-call telemetry: append-only tally, session segmentation,
// swallow-all writes, and the token-report regression section over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  AGENT_ACTIVITY_REGRESSION_THRESHOLD,
  AGENT_ACTIVITY_WARN_THRESHOLD,
  bumpRunAgentActivity,
  listRunAgentActivity,
  readRunAgentActivity,
} from '../run-agent';
import { renderRunActivitySection } from '../../../runners/token-report';

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-activity-'));
  try { fn(cwd); } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

test('bump/read/list tally per role and per child session', () => {
  withProject((cwd) => {
    for (let i = 0; i < 3; i += 1) bumpRunAgentActivity(cwd, 'R', 'senior-frontend', 'child-a');
    bumpRunAgentActivity(cwd, 'R', 'senior-frontend', 'child-b'); // replacement child, same role
    bumpRunAgentActivity(cwd, 'R', 'senior-backend', 'child-c');
    const frontend = readRunAgentActivity(cwd, 'R', 'senior-frontend');
    assert.equal(frontend.total, 4);
    assert.deepEqual(frontend.bySession, { 'child-a': 3, 'child-b': 1 });
    const all = listRunAgentActivity(cwd, 'R');
    assert.equal(all['senior-frontend']!.total, 4);
    assert.equal(all['senior-backend']!.total, 1);
    // Missing role/run reads as zero, never throws.
    assert.equal(readRunAgentActivity(cwd, 'R', 'senior-tester').total, 0);
    assert.deepEqual(listRunAgentActivity(cwd, 'other-run'), {});
  });
});

test('a bump can never break a tool call: unwritable roots and junk args are swallowed', () => {
  bumpRunAgentActivity(path.join(os.tmpdir(), 't1-activity-nope', 'not', 'writable-file.txt', 'deep'), 'R', 'senior-frontend', 'x');
  bumpRunAgentActivity('', '', '', null);
  assert.equal(readRunAgentActivity('', 'R', 'senior-frontend').total, 0);
});

test('thresholds: warn at 20, regression flagged past 50 in the token-report section', () => {
  assert.equal(AGENT_ACTIVITY_WARN_THRESHOLD, 20);
  assert.equal(AGENT_ACTIVITY_REGRESSION_THRESHOLD, 50);
  withProject((cwd) => {
    for (let i = 0; i < AGENT_ACTIVITY_REGRESSION_THRESHOLD + 1; i += 1) {
      bumpRunAgentActivity(cwd, 'R', 'senior-frontend', 'child-a');
    }
    bumpRunAgentActivity(cwd, 'R', 'senior-reviewer', 'child-r');
    const section = renderRunActivitySection(cwd);
    assert.ok(section.includes('Run agent activity'));
    assert.ok(section.includes(`| R | senior-frontend | ${AGENT_ACTIVITY_REGRESSION_THRESHOLD + 1} | REGRESSION > ${AGENT_ACTIVITY_REGRESSION_THRESHOLD} |`));
    assert.ok(section.includes('| R | senior-reviewer | 1 |  |'), 'a quiet role carries no flag');
  });
  // No activity anywhere → the section is absent entirely.
  withProject((cwd) => {
    assert.equal(renderRunActivitySection(cwd), '');
  });
});
