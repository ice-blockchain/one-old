import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  parseVerificationPlanIntent,
  readVerificationPlanIntent,
  VERIFICATION_PLAN_INTENT_END,
  VERIFICATION_PLAN_INTENT_START,
} from '../verification-plan-intent';

function block(value: unknown): string {
  return [
    '# Verification',
    VERIFICATION_PLAN_INTENT_START,
    JSON.stringify(value),
    VERIFICATION_PLAN_INTENT_END,
    '',
  ].join('\n');
}

function withProject(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-verification-intent-'));
  try {
    fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('absent verification marker produces empty compile options', () => {
  assert.deepEqual(parseVerificationPlanIntent('# Plan\n\nNo machine-readable verification intent.\n'), {});
});

test('valid schema v1 produces only VerificationCompileOptions-compatible fields', () => {
  assert.deepEqual(parseVerificationPlanIntent(block({
    schemaVersion: 1,
    agentRaisedImpact: 'visual',
    redesign: true,
    performanceRisk: false,
    explicitLighthouse: {
      performanceMin: 92.5,
      accessibilityMin: 100,
      bestPracticesMin: 0,
      seoMin: 95,
      lcpMaxMs: 2_500,
      clsMax: 0.1,
      inpMaxMs: 200,
    },
    advisoryLighthouse: {
      performanceMin: 90,
    },
  })), {
    agentRaisedImpact: 'visual',
    redesign: true,
    performanceRisk: false,
    explicitLighthouse: {
      performanceMin: 92.5,
      accessibilityMin: 100,
      bestPracticesMin: 0,
      seoMin: 95,
      lcpMaxMs: 2_500,
      clsMax: 0.1,
      inpMaxMs: 200,
    },
    advisoryLighthouse: {
      performanceMin: 90,
    },
  });
});

test('duplicate, incomplete, reversed, and malformed markers fail closed', () => {
  const validJson = '{"schemaVersion":1}';
  assert.throws(
    () => parseVerificationPlanIntent(
      `${VERIFICATION_PLAN_INTENT_START}\n${validJson}\n${VERIFICATION_PLAN_INTENT_START}\n${VERIFICATION_PLAN_INTENT_END}`,
    ),
    /exactly one start marker and one end marker/,
  );
  assert.throws(
    () => parseVerificationPlanIntent(`${VERIFICATION_PLAN_INTENT_START}\n${validJson}`),
    /exactly one start marker and one end marker/,
  );
  assert.throws(
    () => parseVerificationPlanIntent(`${VERIFICATION_PLAN_INTENT_END}\n${validJson}`),
    /exactly one start marker and one end marker/,
  );
  assert.throws(
    () => parseVerificationPlanIntent(
      `${VERIFICATION_PLAN_INTENT_END}\n${validJson}\n${VERIFICATION_PLAN_INTENT_START}`,
    ),
    /out of order/,
  );
  assert.throws(
    () => parseVerificationPlanIntent('<!-- traffic-one-verification:begin -->\n{"schemaVersion":1}'),
    /malformed or unsupported marker/,
  );
});

test('invalid JSON, non-object JSON, schema mismatches, and unknown root keys are rejected', () => {
  const raw = (json: string): string => [
    VERIFICATION_PLAN_INTENT_START,
    json,
    VERIFICATION_PLAN_INTENT_END,
  ].join('\n');

  assert.throws(() => parseVerificationPlanIntent(raw('{')), /valid JSON/);
  assert.throws(() => parseVerificationPlanIntent(raw('null')), /JSON must be an object/);
  assert.throws(() => parseVerificationPlanIntent(raw('[]')), /JSON must be an object/);
  assert.throws(() => parseVerificationPlanIntent(block({})), /schemaVersion must be 1/);
  assert.throws(() => parseVerificationPlanIntent(block({ schemaVersion: 2 })), /schemaVersion must be 1/);
  assert.throws(
    () => parseVerificationPlanIntent(block({ schemaVersion: 1, browserRequired: false })),
    /unknown key: browserRequired/,
  );
});

test('booleans and Lighthouse objects are validated strictly', () => {
  assert.throws(
    () => parseVerificationPlanIntent(block({ schemaVersion: 1, redesign: 1 })),
    /redesign must be boolean/,
  );
  assert.throws(
    () => parseVerificationPlanIntent(block({ schemaVersion: 1, performanceRisk: 'yes' })),
    /performanceRisk must be boolean/,
  );
  assert.throws(
    () => parseVerificationPlanIntent(block({ schemaVersion: 1, agentRaisedImpact: 'browser' })),
    /agentRaisedImpact is invalid/,
  );
  for (const invalid of [null, [], true, 90]) {
    assert.throws(
      () => parseVerificationPlanIntent(block({ schemaVersion: 1, explicitLighthouse: invalid })),
      /explicitLighthouse must be an object/,
    );
  }
  assert.throws(
    () => parseVerificationPlanIntent(block({
      schemaVersion: 1,
      advisoryLighthouse: { performanceMinimum: 90 },
    })),
    /unknown advisoryLighthouse key: performanceMinimum/,
  );
});

test('Lighthouse threshold ranges match the verification contract', () => {
  for (const [key, value] of [
    ['performanceMin', -1],
    ['accessibilityMin', 101],
    ['bestPracticesMin', '90'],
    ['seoMin', null],
    ['lcpMaxMs', -0.1],
    ['clsMax', -0.01],
    ['inpMaxMs', -1],
  ] as const) {
    assert.throws(
      () => parseVerificationPlanIntent(block({
        schemaVersion: 1,
        explicitLighthouse: { [key]: value },
      })),
      new RegExp(`explicitLighthouse\\.${key} is outside its allowed range`),
    );
  }

  assert.deepEqual(parseVerificationPlanIntent(block({
    schemaVersion: 1,
    explicitLighthouse: {
      performanceMin: 0,
      seoMin: 100,
      lcpMaxMs: 0,
      clsMax: 0,
      inpMaxMs: 0,
    },
  })), {
    explicitLighthouse: {
      performanceMin: 0,
      seoMin: 100,
      lcpMaxMs: 0,
      clsMax: 0,
      inpMaxMs: 0,
    },
  });
});

test('project reader uses .traffic-one/plan.md, treats a missing plan as absent, and rejects bad intent', () => {
  withProject((cwd) => {
    assert.deepEqual(readVerificationPlanIntent(cwd), {});

    const trafficOne = path.join(cwd, '.traffic-one');
    fs.mkdirSync(trafficOne, { recursive: true });
    fs.writeFileSync(path.join(trafficOne, 'plan.md'), block({
      schemaVersion: 1,
      performanceRisk: true,
      advisoryLighthouse: { performanceMin: 88 },
    }));
    assert.deepEqual(readVerificationPlanIntent(cwd), {
      performanceRisk: true,
      advisoryLighthouse: { performanceMin: 88 },
    });

    fs.writeFileSync(
      path.join(trafficOne, 'plan.md'),
      `${VERIFICATION_PLAN_INTENT_START}\n{"schemaVersion":1}`,
    );
    assert.throws(
      () => readVerificationPlanIntent(cwd),
      /exactly one start marker and one end marker/,
    );
  });
});
