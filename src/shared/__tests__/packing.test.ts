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
    const r = packBundle(dir, ['rules/common/auth-gate.md', 'rules/missing.md'], ['rules/core.md']);
    assert.deepEqual(r.included, ['rules/common/auth-gate.md', 'rules/core.md']);
    assert.ok(r.body.includes('- .traffic-one/rules/common/auth-gate.md'));
    assert.ok(!r.body.includes('rules/missing.md'));
    assert.ok(r.body.includes('### Optional'));
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
  // Negative row: neither spelling on disk → the degraded branch, canonical path.
  assert.ok(r.body.includes('No fix-cycle context file exists on disk'));
  // No consolidated quality-findings file on disk → no pointer to a missing path.
  assert.ok(!r.body.includes('quality-findings'));
});

test('packFixCycleHeader falls back to the legacy short-name fix file (12co)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pack-legacy-'));
  try {
    // The orchestrator wrote the digest-style short name instead of the
    // canonical senior-frontend-fix-1.md. The header must still find it.
    const rel = path.join('.traffic-one', 'fix-cycles', 'run-1', 'frontend-fix-1.md');
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '# findings\n', 'utf8');
    const r = packFixCycleHeader(dir, 'senior-frontend', 'run-1', 2);
    assert.ok(r.body.includes('.traffic-one/fix-cycles/run-1/frontend-fix-1.md'));
    assert.ok(r.body.includes('Read the fix-cycle context'));
    assert.ok(!r.body.includes('No fix-cycle context file exists on disk'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packFixCycleHeader prefers the canonical prefixed name when both exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pack-both-'));
  try {
    for (const name of ['senior-frontend-fix-1.md', 'frontend-fix-1.md']) {
      const rel = path.join('.traffic-one', 'fix-cycles', 'run-1', name);
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), '# findings\n', 'utf8');
    }
    const r = packFixCycleHeader(dir, 'senior-frontend', 'run-1', 2);
    assert.ok(r.body.includes('.traffic-one/fix-cycles/run-1/senior-frontend-fix-1.md'));
    assert.ok(!r.body.includes('.traffic-one/fix-cycles/run-1/frontend-fix-1.md'));
    assert.ok(r.body.includes('Read the fix-cycle context'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('packFixCycleHeader also points at the consolidated quality findings when they exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pack-quality-'));
  try {
    const rel = path.join('.traffic-one', 'fix-cycles', 'run-1', 'senior-frontend-quality-findings.md');
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '# findings\n', 'utf8');
    const r = packFixCycleHeader(dir, 'senior-frontend', 'run-1', 2);
    assert.ok(r.body.includes('.traffic-one/fix-cycles/run-1/senior-frontend-quality-findings.md'));
    assert.ok(r.body.includes('Also apply ALL accumulated quality findings'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
