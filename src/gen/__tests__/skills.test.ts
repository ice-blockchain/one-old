import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedSkillDocs } from '../emit/skills';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('generatedSkillDocs re-gathers both skill trees (107 templates + 3 bootstrap)', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  const templates = docs.filter((d) => d.relPath.startsWith(`skills-templates${path.sep}`));
  const bootstrap = docs.filter((d) => d.relPath.startsWith(`skills${path.sep}`));
  assert.equal(templates.length, 107);
  assert.equal(bootstrap.length, 3);
  // The shared bootstrap skills exist in BOTH trees (distinct content).
  assert.ok(docs.some((d) => d.relPath === path.join('skills', 'stack-setup', 'SKILL.md')));
  assert.ok(docs.some((d) => d.relPath === path.join('skills-templates', 'stack-setup', 'SKILL.md')));
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

test('generated skills enforce local preferences before implementation', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  const detect = docs.find((d) => d.relPath === path.join('skills-templates', 'detect-project', 'SKILL.md'));
  const page = docs.find((d) => d.relPath === path.join('skills-templates', 'create-page', 'SKILL.md'));
  const stack = docs.find((d) => d.relPath === path.join('skills-templates', 'stack-setup', 'SKILL.md'));
  assert.ok(detect);
  assert.ok(page);
  assert.ok(stack);
  assert.match(detect.content, /Required order: OpenCode, Performance,\s*Team Confirmation for High\/Balanced, then Code Graph/);
  assert.match(page.content, /rules\/common\/setup-gate\.md/);
  assert.doesNotMatch(page.content, /local preferences contain `openCode`/);
  assert.match(stack.content, /Existing projects do not ask MVP context or\s*Mobile App prompts/);
});
