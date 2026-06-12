import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedRuleTemplates } from '../emit/rules';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('generatedRuleTemplates re-gathers the full nested rules tree', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  assert.equal(docs.length, 79); // 76 + 3 on-demand slices (new-project x2, ui-quality-reference)
  const paths = new Set(docs.map((d) => d.relPath));
  // Root, common, and deeply-nested rule paths are all preserved exactly.
  assert.ok(paths.has(path.join('rules', 'core.md')));
  assert.ok(paths.has(path.join('rules', 'common', 'auth-gate.md')));
  assert.ok(paths.has(path.join('rules', 'common', 'setup-gate.md')));
  assert.ok([...paths].some((p) => p.startsWith(path.join('rules', 'frontend', 'react'))));
  // Output is sorted + every doc carries content.
  const sorted = [...docs].map((d) => d.relPath).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(docs.map((d) => d.relPath), sorted);
  for (const doc of docs) assert.ok(doc.content.length > 0, `empty: ${doc.relPath}`);
});

test('generated rules do not require architecture.md artifacts', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  for (const doc of docs) {
    assert.doesNotMatch(doc.content, /\b(write|create|ship|include)\s+`?architecture\.md`?/i, doc.relPath);
    assert.doesNotMatch(doc.content, /architecture\.md`\s*\(REQUIRED\)/i, doc.relPath);
    assert.doesNotMatch(doc.content, /package-architecture/i, doc.relPath);
  }
});

test('setup-gate rule makes local preferences blocking', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  const setup = docs.find((d) => d.relPath === path.join('rules', 'common', 'setup-gate.md'));
  const existing = docs.find((d) => d.relPath === path.join('rules', 'modes', 'existing-codebase.md'));
  assert.ok(setup);
  assert.ok(existing);
  assert.match(setup.content, /Before mutating Traffic One work, the setup gate must be clear/);
  assert.match(setup.content, /Existing-project order is OpenCode, Performance,\s*Team Confirmation for Balanced\/High, then Code Graph/);
  assert.match(existing.content, /rules\/common\/setup-gate\.md/);
  assert.doesNotMatch(existing.content, /non-blocking popup/);
});

test('new policy rules exist and carry their canonical text', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  const find = (name: string) => docs.find((d) => d.relPath === path.join('rules', 'common', name));
  const routing = find('project-routing.md');
  const onboarding = find('onboarding.md');
  const precedence = find('skill-precedence.md');
  assert.ok(routing, 'project-routing.md missing');
  assert.ok(onboarding, 'onboarding.md missing');
  assert.ok(precedence, 'skill-precedence.md missing');
  // onboarding carries the invariant that existing projects skip new-project Q&A
  // (the wizard owns the questions now; this rule must not re-introduce a chat flow).
  assert.match(onboarding.content, /without\s+new-project Q&A/);
  assert.match(onboarding.content, /local setup wizard/);
  // skill-precedence carries the precedence policy moved off every skill.
  assert.match(precedence.content, /take precedence/);
  assert.match(precedence.content, /Do not implement via any skill until the setup gate/);
});
