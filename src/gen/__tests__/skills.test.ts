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
