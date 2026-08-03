import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  extractOpenCodeDelegateBlock,
  preserveOpenCodeDelegateBlockForWrite,
  preservedOpenCodeDelegateBlock,
  restorePlanOpenCodeDelegateBlock,
} from '../opencode-plan/preserve';
import { parsePlanDelegationUnits } from '../opencode-roles/plan-units';

const BLOCK = [
  '<!-- opencode-delegate:start -->',
  '- id: i18n | role: frontend | files: packages/i18n/src/locales/en/common.json | task: seed strings',
  '- id: seed | role: backend | files: supabase/seed.sql | task: seed demo rows',
  '- id: smoke | role: tester | files: apps/web/e2e/smoke.spec.ts | task: scaffold smoke coverage',
  '<!-- opencode-delegate:end -->',
].join('\n');

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocpreserve-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writePlan(dir: string, content: string): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), content, 'utf8');
}

function readPlan(dir: string): string {
  return fs.readFileSync(path.join(dir, '.traffic-one', 'plan.md'), 'utf8');
}

test('extractOpenCodeDelegateBlock returns the verbatim accepted block and rejects partial ones', () => {
  assert.equal(extractOpenCodeDelegateBlock(`# Plan\n\n${BLOCK}\n\ntrailing prose\n`), BLOCK);
  const partial = [
    '<!-- opencode-delegate:start -->',
    '- id: only | role: backend | files: supabase/seed.sql | task: seed demo rows',
    '<!-- opencode-delegate:end -->',
  ].join('\n');
  assert.equal(extractOpenCodeDelegateBlock(`# Plan\n${partial}\n`), null);
  assert.equal(extractOpenCodeDelegateBlock('# Plan with no markers\n'), null);
});

test('preserve at write time snapshots the on-disk block; restore re-appends it after the rewrite lands', () => {
  withDir((dir) => {
    writePlan(dir, `# Plan v1\n\n${BLOCK}\n`);
    assert.equal(preserveOpenCodeDelegateBlockForWrite(dir, 'R1'), true);
    const snapshot = path.join(dir, '.traffic-one', 'runs', 'R1', 'opencode-plan-block.md');
    assert.equal(fs.readFileSync(snapshot, 'utf8'), `${BLOCK}\n`);

    // The rewrite lands without the block; the next runtime touchpoint repairs it.
    writePlan(dir, '# Plan v2 — prose only\n');
    assert.equal(restorePlanOpenCodeDelegateBlock(dir, 'R1'), true);
    const repaired = readPlan(dir);
    assert.ok(repaired.startsWith('# Plan v2 — prose only\n'));
    assert.equal(parsePlanDelegationUnits(repaired).length, 3);
    // Idempotent: with the block back, restore never rewrites again.
    assert.equal(restorePlanOpenCodeDelegateBlock(dir, 'R1'), false);
  });
});

test('preserved block reconstructs from the compiled opencode-queue.json when no snapshot exists', () => {
  withDir((dir) => {
    const runDir = path.join(dir, '.traffic-one', 'runs', 'R1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'opencode-queue.json'), JSON.stringify({
      version: 1,
      runId: 'R1',
      assignmentHash: null,
      queueHash: 'x',
      units: [
        { id: 'i18n', role: 'frontend', kind: null, allowedFiles: ['packages/i18n/src/locales/en/common.json', 'packages/i18n/src/locales/ro/common.json'], task: 'seed strings', dependsOn: [] },
        { id: 'seed', role: 'backend', kind: null, allowedFiles: ['supabase/seed.sql'], task: 'seed demo rows', dependsOn: [] },
        { id: 'smoke', role: 'tester', kind: 'e2e', allowedFiles: ['apps/web/e2e/smoke.spec.ts'], task: 'scaffold smoke coverage', dependsOn: ['i18n', 'seed'] },
      ],
    }), 'utf8');
    const rebuilt = preservedOpenCodeDelegateBlock(dir, 'R1');
    assert.ok(rebuilt, 'queue must reconstruct a block');
    const units = parsePlanDelegationUnits(rebuilt!);
    assert.equal(units.length, 3);
    assert.deepEqual(units[2]!.dependsOn, ['i18n', 'seed']);
    assert.equal(units[0]!.files, 'packages/i18n/src/locales/en/common.json,packages/i18n/src/locales/ro/common.json');

    // preserve-for-write accepts the queue as the durable source even when the
    // on-disk plan never carried a block (nothing to snapshot).
    writePlan(dir, '# Prose only\n');
    assert.equal(preserveOpenCodeDelegateBlockForWrite(dir, 'R1'), true);
    assert.equal(restorePlanOpenCodeDelegateBlock(dir, 'R1'), true);
    assert.equal(parsePlanDelegationUnits(readPlan(dir)).length, 3);
  });
});

test('restore never overwrites authored units and fails closed with nothing preserved', () => {
  withDir((dir) => {
    // A plan that still parses ANY unit is authored content — hands off.
    writePlan(dir, [
      '# Plan',
      '<!-- opencode-delegate:start -->',
      '- id: only | role: backend | files: supabase/seed.sql | task: seed demo rows',
      '<!-- opencode-delegate:end -->',
    ].join('\n'));
    fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', 'R1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', 'R1', 'opencode-plan-block.md'), `${BLOCK}\n`, 'utf8');
    assert.equal(restorePlanOpenCodeDelegateBlock(dir, 'R1'), false);

    // No snapshot, no queue → nothing recoverable, both halves refuse.
    writePlan(dir, '# Prose only\n');
    assert.equal(preserveOpenCodeDelegateBlockForWrite(dir, 'R2'), false);
    assert.equal(restorePlanOpenCodeDelegateBlock(dir, 'R2'), false);
    assert.equal(preserveOpenCodeDelegateBlockForWrite(dir, ''), false);
  });
});

test('restore strips stray markers so the repaired block is the only parseable region', () => {
  withDir((dir) => {
    fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', 'R1'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', 'R1', 'opencode-plan-block.md'), `${BLOCK}\n`, 'utf8');
    writePlan(dir, [
      '# Plan v2',
      '<!-- opencode-delegate:start -->',
      'prose the parser cannot execute',
      '<!-- opencode-delegate:end -->',
      'after',
    ].join('\n'));
    assert.equal(restorePlanOpenCodeDelegateBlock(dir, 'R1'), true);
    const repaired = readPlan(dir);
    assert.equal(parsePlanDelegationUnits(repaired).length, 3);
    assert.ok(!repaired.includes('prose the parser cannot execute'));
    assert.ok(repaired.includes('after'));
  });
});
