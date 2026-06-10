import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedAgents } from '../emit/agents';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('generatedAgents gathers the six senior roles + the quick-fix maintenance worker', () => {
  const docs = generatedAgents(REPO_ROOT);
  const byPath = new Map(docs.map((d) => [d.relPath, d.content]));
  for (const stem of ['senior-architect', 'senior-backend', 'senior-frontend', 'senior-reviewer', 'senior-shipper', 'senior-tester', 'quick-fix']) {
    const rel = path.join('agents', `${stem}.md`);
    assert.ok(byPath.has(rel), `missing ${rel}`);
    // Content is the verbatim agent doc (frontmatter name matches the stem).
    assert.ok(byPath.get(rel)?.startsWith('---\n'), `${rel} should start with frontmatter`);
    assert.ok(byPath.get(rel)?.includes(`name: ${stem}`), `${rel} frontmatter name should be ${stem}`);
  }
  assert.equal(docs.length, 7);
});
