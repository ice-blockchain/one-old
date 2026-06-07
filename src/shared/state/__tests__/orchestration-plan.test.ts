import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  orchestrationPlanPath,
  validateOrchestrationPlan,
  readOrchestrationPlan,
  writeOrchestrationPlan,
  planHasRole,
  planRoleTier,
  planRoleRules,
  planRoleSkills,
} from '../orchestration-plan';

const RUN = '1715091785000';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-orchplan-'));
}

function basePlan(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    runId: RUN,
    taskClass: 'standard',
    roster: ['senior-frontend', 'senior-backend'],
    graph: [['senior-frontend', 'senior-backend']],
    roles: { 'senior-frontend': { tier: 'cheapest' }, 'senior-backend': { tier: 'highest' } },
    ...extra,
  };
}

test('orchestrationPlanPath lands under .traffic-one/runs/<runId>/orchestration.json', () => {
  const cwd = tmp();
  try {
    assert.equal(orchestrationPlanPath(cwd, RUN), path.join(cwd, '.traffic-one', 'runs', RUN, 'orchestration.json'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('write → read round-trip preserves roster, tiers, and per-role narrowing', () => {
  const cwd = tmp();
  try {
    const written = writeOrchestrationPlan(cwd, basePlan({
      roles: {
        'senior-frontend': { tier: 'cheapest', rules: ['rules/frontend/i18n.md'], skills: ['i18n-text'] },
        'senior-backend': { tier: 'highest' },
      },
    }));
    assert.ok(written, 'valid plan should be written');
    const plan = readOrchestrationPlan(cwd, RUN);
    assert.ok(plan);
    assert.deepEqual(plan!.roster, ['senior-frontend', 'senior-backend']);
    assert.equal(planRoleTier(plan, 'senior-frontend'), 'cheapest');
    assert.equal(planRoleTier(plan, 'senior-backend'), 'highest');
    assert.deepEqual(planRoleRules(plan, 'senior-frontend'), ['rules/frontend/i18n.md']);
    assert.deepEqual(planRoleSkills(plan, 'senior-frontend'), ['i18n-text']);
    assert.equal(planRoleRules(plan, 'senior-backend'), null);
    assert.equal(planHasRole(plan, 'senior-frontend'), true);
    assert.equal(planHasRole(plan, 'senior-architect'), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('validate fails open (null) on empty/invalid roster, missing or mismatched runId, and garbage', () => {
  assert.equal(validateOrchestrationPlan(basePlan({ roster: [] })), null);
  assert.equal(validateOrchestrationPlan(basePlan({ roster: ['nope'] })), null);
  assert.equal(validateOrchestrationPlan(basePlan({ runId: '' })), null);
  assert.equal(validateOrchestrationPlan(basePlan(), 'a-different-run'), null);
  assert.equal(validateOrchestrationPlan(null), null);
  assert.equal(validateOrchestrationPlan('x'), null);
  assert.equal(validateOrchestrationPlan(42), null);
});

test('validate drops unknown roster/graph roles and canonicalizes tiers', () => {
  const plan = validateOrchestrationPlan(basePlan({
    roster: ['senior-frontend', 'bogus', 'senior-backend'],
    graph: [['senior-frontend', 'bogus'], ['senior-architect']],
    roles: { 'senior-frontend': { tier: 'CHEAPEST' }, 'senior-backend': { tier: 'nope' } },
  }));
  assert.ok(plan);
  assert.deepEqual(plan!.roster, ['senior-frontend', 'senior-backend']);
  // graph keeps only roster roles, dropping the now-empty senior-architect group.
  assert.deepEqual(plan!.graph, [['senior-frontend']]);
  assert.equal(planRoleTier(plan, 'senior-frontend'), 'cheapest'); // alias canonicalized
  assert.equal(planRoleTier(plan, 'senior-backend'), null);        // 'nope' → null → static default downstream
});

test('an empty rules/skills narrowing is treated as no-narrowing (never strip a role to nothing)', () => {
  const plan = validateOrchestrationPlan(basePlan({
    roles: { 'senior-frontend': { tier: 'cheapest', rules: [], skills: [] }, 'senior-backend': { tier: 'highest' } },
  }));
  assert.equal(planRoleRules(plan, 'senior-frontend'), null);
  assert.equal(planRoleSkills(plan, 'senior-frontend'), null);
});

test('readOrchestrationPlan returns null when no file, wrong run folder, or empty runId', () => {
  const cwd = tmp();
  try {
    assert.equal(readOrchestrationPlan(cwd, RUN), null);
    writeOrchestrationPlan(cwd, basePlan());
    assert.ok(readOrchestrationPlan(cwd, RUN));
    assert.equal(readOrchestrationPlan(cwd, 'some-other-run'), null);
    assert.equal(readOrchestrationPlan(cwd, ''), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeOrchestrationPlan refuses to persist an invalid plan', () => {
  const cwd = tmp();
  try {
    assert.equal(writeOrchestrationPlan(cwd, basePlan({ roster: [] })), null);
    assert.equal(fs.existsSync(orchestrationPlanPath(cwd, RUN)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('accessors are null-safe on a null plan', () => {
  assert.equal(planHasRole(null, 'senior-frontend'), false);
  assert.equal(planRoleTier(null, 'senior-frontend'), null);
  assert.equal(planRoleRules(null, 'senior-frontend'), null);
  assert.equal(planRoleSkills(null, 'senior-frontend'), null);
});
