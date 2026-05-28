import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedCursorRules } from '../emit/cursor-rules';
import {
  cursorFrontmatter,
  parseFrontmatter,
  splitFrontmatter,
  titleFromBody,
} from '../lib/frontmatter';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('splitFrontmatter + parseFrontmatter read paths/description/alwaysApply', () => {
  const md = '---\ndescription: "Hi"\npaths:\n  - "src/**/*.ts"\nalwaysApply: false\n---\n# Title\n\nbody\n';
  const { frontmatterLines, body } = splitFrontmatter(md);
  const fm = parseFrontmatter(frontmatterLines);
  assert.equal(fm.description, 'Hi');
  assert.deepEqual(fm.paths, ['src/**/*.ts']);
  assert.equal(fm.alwaysApply, false);
  assert.equal(titleFromBody(body, 'fallback'), 'Title');
});

test('cursorFrontmatter emits description + globs + alwaysApply', () => {
  const lines = cursorFrontmatter('Desc', ['a/**'], true);
  assert.equal(lines[0], '---');
  assert.ok(lines.includes('description: "Desc"'));
  assert.ok(lines.includes('globs: ["a/**"]'));
  assert.ok(lines.includes('alwaysApply: true'));
});

test('generatedCursorRules gathers rule + agent docs from the repo tree', () => {
  const docs = generatedCursorRules(REPO_ROOT);
  // 72 rule templates + 6 agents (00-auth-required.mdc is hand-authored, not generated).
  assert.equal(docs.length, 78);
  const byPath = new Map(docs.map((d) => [d.relPath, d.content]));

  // common/auth-gate.md → auth-required.mdc (special slug).
  const authPath = path.join('.cursor', 'rules', 'auth-required.mdc');
  assert.ok(byPath.has(authPath));
  assert.ok(byPath.get(authPath)?.startsWith('<!-- GENERATED FROM: rules-templates/common/auth-gate.md;'));

  // agents/senior-architect.md → 00-agent-senior-architect.mdc (always-on mirror).
  const agentPath = path.join('.cursor', 'rules', '00-agent-senior-architect.mdc');
  assert.ok(byPath.has(agentPath));
  assert.ok(byPath.get(agentPath)?.includes('alwaysApply: true'));
  assert.ok(byPath.get(agentPath)?.includes('Cursor has no first-class'));

  // Every generated doc carries the GENERATED-FROM marker + ends with a newline.
  for (const doc of docs) {
    assert.ok(doc.content.startsWith('<!-- GENERATED FROM: '), `missing marker: ${doc.relPath}`);
    assert.ok(doc.content.endsWith('\n'), `missing trailing newline: ${doc.relPath}`);
  }
});
