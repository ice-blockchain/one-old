import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generatedCursorRules } from '../emit/cursor-rules';
import { runGen } from '../index';
import {
  cursorFrontmatter,
  parseFrontmatter,
  splitFrontmatter,
  titleFromBody,
} from '../lib/frontmatter';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STRUCTURAL_PROFILE_IDS = [
  'vite-react',
  'next-app',
  'next-pages',
  'nuxt',
  'vue',
  'sveltekit',
  'svelte',
  'astro',
  'angular',
  'server-rendered',
  'generic-web',
  'unsupported-hybrid',
  'react-native',
  'swift-native',
  'kotlin-native',
  'flutter-native',
  'backend-only',
] as const;

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
  assert.ok(lines.includes('globs: "a/**"'));
  assert.ok(lines.includes('alwaysApply: true'));

  const noGlobLines = cursorFrontmatter('Desc', [], false);
  assert.ok(!noGlobLines.some((line) => line.startsWith('globs:')));
  assert.ok(noGlobLines.includes('alwaysApply: false'));
});

test('generatedCursorRules gathers rule + agent docs from the repo tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-rules-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const docs = generatedCursorRules(dir);
    // 97 rule templates (including all 17 structural profiles) + 7 agents.
    assert.equal(docs.length, 104);
    const byPath = new Map(docs.map((d) => [d.relPath, d.content]));

    // common/auth-gate.md -> auth-required.mdc (special slug, always-on kernel).
    const authPath = path.join('.cursor', 'rules', 'auth-required.mdc');
    assert.ok(byPath.has(authPath));
    assert.ok(byPath.get(authPath)?.startsWith('---\n'));
    assert.ok(byPath.get(authPath)?.includes('<!-- GENERATED FROM: rules/common/auth-gate.md;'));
    assert.ok(byPath.get(authPath)?.includes('alwaysApply: true'));

    // agents/senior-architect.md -> 00-agent-senior-architect.mdc — attached on
    // demand via description, NOT pinned to every request.
    const agentPath = path.join('.cursor', 'rules', '00-agent-senior-architect.mdc');
    assert.ok(byPath.has(agentPath));
    assert.ok(byPath.get(agentPath)?.includes('alwaysApply: false'));
    // The note must not claim Cursor lacks subagents — Traffic One spawns every
    // role through `Task`, and the old wording contradicted the orchestrator skill
    // in every generated role rule.
    assert.ok(!byPath.get(agentPath)?.includes('Cursor has no first-class'));
    assert.ok(byPath.get(agentPath)?.includes('subagent_type'));

    // Only the small behavioral kernel stays always-on; bulky paths-less rules
    // (stack pitches, onboarding, role-team docs) ship agent-requested.
    const alwaysOn = docs.filter((d) => d.content.includes('alwaysApply: true')).map((d) => path.basename(d.relPath)).sort();
    assert.deepEqual(alwaysOn, [
      'auth-required.mdc',
      'common-clean-code.mdc',
      'common-execution-discipline.mdc',
      'common-security.mdc',
      'common-setup-gate.mdc',
      'common-skill-precedence.mdc',
      'core.mdc',
    ]);
    const stackRec = byPath.get(path.join('.cursor', 'rules', 'common-stack-recommendations.mdc'));
    assert.ok(stackRec?.includes('alwaysApply: false'));
    const defaultVite = byPath.get(path.join('.cursor', 'rules', 'mode-new-project-vite-react.mdc'));
    assert.ok(defaultVite?.includes('alwaysApply: false'));
    assert.ok(defaultVite?.includes('profileId=vite-react'));
    for (const profileId of STRUCTURAL_PROFILE_IDS) {
      const profileRule = byPath.get(path.join(
        '.cursor',
        'rules',
        `mode-new-project-${profileId}.mdc`,
      ));
      assert.ok(profileRule, `missing Cursor rule for ${profileId}`);
      assert.ok(profileRule.includes('alwaysApply: false'));
      assert.ok(profileRule.includes(`profileId=${profileId}`));
    }

    // Cursor requires .mdc frontmatter to be the first bytes. The generated
    // marker lives below the frontmatter so Cursor does not reject the file.
    for (const doc of docs) {
      assert.ok(doc.content.startsWith('---\n'), `frontmatter must start file: ${doc.relPath}`);
      assert.ok(doc.content.includes('<!-- GENERATED FROM: '), `missing marker: ${doc.relPath}`);
      assert.ok(doc.content.endsWith('\n'), `missing trailing newline: ${doc.relPath}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
