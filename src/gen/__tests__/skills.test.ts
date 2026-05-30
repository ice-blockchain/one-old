import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedSkillDocs } from '../emit/skills';
import { claudePluginManifest, codexPluginManifest, cursorPluginManifest } from '../sources/product';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('generatedSkillDocs re-gathers both skill trees (104 catalog + 0 bootstrap)', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  const templates = docs.filter((d) => d.relPath.startsWith(`skills-catalog${path.sep}`));
  const bootstrap = docs.filter((d) => d.relPath.startsWith(`skills${path.sep}`));
  assert.equal(templates.length, 104);
  assert.equal(bootstrap.length, 0);
  // traffic-one-doctor is a normal catalog skill now — present in skills-catalog/, absent from the (empty) bootstrap tree.
  assert.ok(!docs.some((d) => d.relPath === path.join('skills', 'traffic-one-doctor', 'SKILL.md')));
  assert.ok(docs.some((d) => d.relPath === path.join('skills-catalog', 'traffic-one-doctor', 'SKILL.md')));
  // Deterministic sort + non-empty content.
  const sorted = [...docs].map((d) => d.relPath).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(docs.map((d) => d.relPath), sorted);
  for (const doc of docs) assert.ok(doc.content.length > 0, `empty: ${doc.relPath}`);
});

test('generated skills do not require architecture.md artifacts', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  for (const doc of docs) {
    assert.doesNotMatch(doc.content, /\b(write|create|ship|include)\s+`?architecture\.md`?/i, doc.relPath);
    assert.doesNotMatch(doc.content, /architecture\.md`\s*\(REQUIRED\)/i, doc.relPath);
    assert.doesNotMatch(doc.content, /package-architecture/i, doc.relPath);
  }
});

test('generated skills carry no Traffic One governance boilerplate', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  for (const doc of docs) {
    assert.doesNotMatch(doc.content, /Traffic One precedence:/, doc.relPath);
    assert.doesNotMatch(doc.content, /Traffic One setup gate:/, doc.relPath);
    assert.doesNotMatch(doc.content, /Prerequisite: follow the shared/, doc.relPath);
    // Skill files reference neither dissolved policy skill.
    assert.doesNotMatch(doc.content, /`detect-project`/, doc.relPath);
    assert.doesNotMatch(doc.content, /`stack-setup`/, doc.relPath);
  }
  // The two policy skills are gone from both trees entirely.
  assert.ok(!docs.some((d) => d.relPath.includes('detect-project')));
  assert.ok(!docs.some((d) => d.relPath.includes('stack-setup')));
});

test('all host manifests read the managed ./skills/ dir (per-stack filtering)', () => {
  const version = '0.0.0-test';
  for (const m of [claudePluginManifest(version), codexPluginManifest(version), cursorPluginManifest(version)]) {
    assert.equal(m.skills, './skills/');
  }
});
