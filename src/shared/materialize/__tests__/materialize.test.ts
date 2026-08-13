import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { GENERATED_MARKER, copySkillDir, isGenerated, removeGeneratedFile, removeGeneratedSkillDir } from '../generated';
import { hasMaterializedProjectAssets, isLeanMaterialization } from '../has-assets';
import { migrateArchitectureDocsToPlan } from '../plan-migration';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-mat-'));
}

test('isGenerated detects the marker; removeGeneratedFile only removes generated files', () => {
  const dir = tmp();
  try {
    const generated = path.join(dir, 'a.md');
    fs.writeFileSync(generated, `x\n${GENERATED_MARKER}\n`, 'utf8');
    const plain = path.join(dir, 'b.md');
    fs.writeFileSync(plain, 'plain', 'utf8');
    assert.equal(isGenerated(generated), true);
    assert.equal(isGenerated(plain), false);
    assert.equal(removeGeneratedFile(generated), true);
    assert.equal(fs.existsSync(generated), false);
    assert.equal(removeGeneratedFile(plain), false);
    assert.equal(fs.existsSync(plain), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copySkillDir stamps the GENERATED marker into SKILL.md and copies siblings', () => {
  const dir = tmp();
  try {
    const src = path.join(dir, 'src-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill\nbody', 'utf8');
    fs.writeFileSync(path.join(src, 'extra.md'), 'extra', 'utf8');
    const dst = path.join(dir, 'dst-skill');
    assert.equal(copySkillDir(src, dst), true);
    const skill = fs.readFileSync(path.join(dst, 'SKILL.md'), 'utf8');
    assert.ok(skill.includes(GENERATED_MARKER));
    assert.ok(skill.includes('# Skill'));
    assert.equal(fs.existsSync(path.join(dst, 'extra.md')), true);
    assert.equal(removeGeneratedSkillDir(dst), true);
    assert.equal(fs.existsSync(dst), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hasMaterializedProjectAssets validates the manifest + the referenced files', () => {
  const dir = tmp();
  try {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
    fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'rule', 'utf8');
    fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 'skill', 'utf8');
    fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({
      generatedBy: 'traffic-one', stack: 'default',
      rules: ['rules/common/auth-gate.md'], skills: ['project-memory'],
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), `ctx\n${GENERATED_MARKER}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');

    assert.equal(hasMaterializedProjectAssets(dir, { stack: 'default' }), true);
    assert.equal(hasMaterializedProjectAssets(dir, { stack: 'minimal' }), false); // stack mismatch
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const empty = tmp();
  try {
    assert.equal(hasMaterializedProjectAssets(empty), false); // no manifest
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('isLeanMaterialization defaults to true; full-mode flags turn it off', () => {
  assert.equal(isLeanMaterialization('/x'), true);
  assert.equal(isLeanMaterialization('/x', { leanMode: false }), false);
  assert.equal(isLeanMaterialization('/x', { contextMode: 'full' }), false);
  assert.equal(isLeanMaterialization('/x', { tokenProfile: 'full' }), false);
});

test('migrateArchitectureDocsToPlan: .traffic-one/architecture.md becomes plan.md and is removed', () => {
  const dir = tmp();
  try {
    const t1 = path.join(dir, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    // The migration is gated on Traffic One OWNING the directory, so the fixture
    // carries the state file every project it can legitimately run on has. Without
    // it this is a directory nobody was invited into, and the gate refuses —
    // see __tests__/plan-migration-gate.test.ts for that half.
    fs.writeFileSync(path.join(t1, '.one.json'), '{"mode":"existing-codebase","stack":"minimal"}\n', 'utf8');
    fs.writeFileSync(path.join(t1, 'architecture.md'), '# Legacy\n\nModule map from old file.', 'utf8');

    const result = migrateArchitectureDocsToPlan(dir);
    assert.deepEqual(result?.migrated, ['.traffic-one/architecture.md']);
    assert.equal(fs.existsSync(path.join(t1, 'architecture.md')), false);

    const plan = fs.readFileSync(path.join(t1, 'plan.md'), 'utf8');
    assert.ok(plan.includes('# Traffic One Plan'));
    assert.ok(plan.includes('### .traffic-one/architecture.md'));
    assert.ok(plan.includes('Module map from old file.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrateArchitectureDocsToPlan: root and package architecture docs append to existing plan then are removed', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), '{"mode":"existing-codebase","stack":"minimal"}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), '# Existing Plan\n\n## Module map\nCanonical package map.', 'utf8');
    fs.writeFileSync(path.join(dir, 'architecture.md'), '# Root Architecture\n\nRoot data flow.', 'utf8');
    fs.writeFileSync(path.join(dir, 'packages', 'ui', 'architecture.md'), '# UI Package\n\nButton boundary.', 'utf8');

    const result = migrateArchitectureDocsToPlan(dir);
    assert.deepEqual(result?.migrated, ['architecture.md', 'packages/ui/architecture.md']);
    assert.equal(fs.existsSync(path.join(dir, 'architecture.md')), false);
    assert.equal(fs.existsSync(path.join(dir, 'packages', 'ui', 'architecture.md')), false);

    const plan = fs.readFileSync(path.join(dir, '.traffic-one', 'plan.md'), 'utf8');
    assert.ok(plan.startsWith('# Existing Plan'));
    assert.ok(plan.includes('Canonical package map.'));
    assert.ok(plan.includes('### architecture.md'));
    assert.ok(plan.includes('Root data flow.'));
    assert.ok(plan.includes('### packages/ui/architecture.md'));
    assert.ok(plan.includes('Button boundary.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
