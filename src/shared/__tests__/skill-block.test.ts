import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyVars, extractBlock, makeSkillBlock } from '../skill-block';

test('extractBlock pulls the body between markers and strips edge newlines', () => {
  const src = `intro\n<!-- T1BLOCK:BEGIN greet -->\nHello {{NAME}}\n<!-- T1BLOCK:END greet -->\nafter`;
  assert.equal(extractBlock(src, 'greet'), 'Hello {{NAME}}');
  assert.equal(extractBlock(src, 'missing'), null);
});

test('applyVars substitutes vars and blanks nullish values', () => {
  assert.equal(applyVars('a {{X}} b {{Y}}', { X: 'one', Y: null }), 'a one b ');
});

test('makeSkillBlock reads a module skill and falls back when absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-skill-'));
  try {
    const skillDir = path.join(root, 'src', 'modules', 'demo', 'skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `# Demo\n<!-- T1BLOCK:BEGIN hello -->\nHi {{WHO}}!\n<!-- T1BLOCK:END hello -->\n`,
      'utf8',
    );
    const skillBlock = makeSkillBlock(() => root);
    assert.equal(skillBlock('demo', 'hello', { WHO: 'world' }), 'Hi world!');
    assert.equal(skillBlock('demo', 'absent', {}, 'FB'), 'FB');
    assert.equal(skillBlock('nomodule', 'hello', {}, 'FB2'), 'FB2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
