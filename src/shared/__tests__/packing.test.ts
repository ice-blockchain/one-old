import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { packBundle, packFixCycleHeader, packRuleIndex, roleDigestName } from '../packing';
import { templatePath } from '../stacks/template-path';

function tmpRoot(rels: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pack-'));
  for (const rel of rels) {
    const fp = path.join(dir, templatePath(rel));
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, '# rule\n', 'utf8');
  }
  return dir;
}

test('packBundle emits pointers only for rule templates that exist', () => {
  const dir = tmpRoot(['rules/common/auth-gate.md', 'rules/core.md']);
  try {
    const r = packBundle(dir, ['rules/common/auth-gate.md', 'rules/missing.md'], ['rules/core.md'], 9500);
    assert.deepEqual(r.included, ['rules/common/auth-gate.md', 'rules/core.md']);
    assert.ok(r.body.includes('- .traffic-one/rules/common/auth-gate.md'));
    assert.ok(!r.body.includes('rules/missing.md'));
    assert.ok(r.body.includes('### Optional'));
    assert.deepEqual(r.dropped, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packRuleIndex lists existing rules as pointers', () => {
  const dir = tmpRoot(['rules/core.md']);
  try {
    const r = packRuleIndex(dir, ['rules/core.md', 'rules/nope.md']);
    assert.deepEqual(r.included, ['rules/core.md']);
    assert.ok(r.body.includes('Active rule index'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('roleDigestName maps senior-* to its short digest name', () => {
  assert.equal(roleDigestName('senior-frontend'), 'frontend');
  assert.equal(roleDigestName('senior-architect'), 'architect');
  assert.equal(roleDigestName('weird'), 'weird');
  assert.equal(roleDigestName(null), 'agent');
});

test('packFixCycleHeader points at the fix-cycle + digest files', () => {
  const r = packFixCycleHeader('/x', 'senior-reviewer', 'run-1', 2);
  assert.ok(r.body.includes('.traffic-one/fix-cycles/run-1/senior-reviewer-fix-1.md'));
  assert.ok(r.body.includes('.traffic-one/digests/run-1/reviewer.md'));
});
