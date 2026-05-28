import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedRuleTemplates } from '../emit/rules';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('generatedRuleTemplates re-gathers the full nested rules-templates tree', () => {
  const docs = generatedRuleTemplates(REPO_ROOT);
  assert.equal(docs.length, 73);
  const paths = new Set(docs.map((d) => d.relPath));
  // Root, common, and deeply-nested rule paths are all preserved exactly.
  assert.ok(paths.has(path.join('rules-templates', 'core.md')));
  assert.ok(paths.has(path.join('rules-templates', 'common', 'auth-gate.md')));
  assert.ok([...paths].some((p) => p.startsWith(path.join('rules-templates', 'frontend', 'react'))));
  // Output is sorted + every doc carries content.
  const sorted = [...docs].map((d) => d.relPath).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(docs.map((d) => d.relPath), sorted);
  for (const doc of docs) assert.ok(doc.content.length > 0, `empty: ${doc.relPath}`);
});
