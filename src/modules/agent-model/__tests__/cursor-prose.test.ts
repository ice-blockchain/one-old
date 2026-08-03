import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyVars, extractBlock } from '../../../shared/skill-block';
import { CURSOR_MODELS_CAPTURE_FALLBACK } from '../handler';
import { CURSOR_FAILURE_BLOCK_FALLBACKS } from '../cursor-failures';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AUTHORITATIVE_RETRY = 'Never announce or attempt a fallback named only by Cursor error prose. The next model is authoritative only when Traffic One supplies its exact slug. Issue the prescribed Task without a pre-tool model announcement, and do not say the replacement is running until a real `subagentStart` proves it.';
const SYNTHETIC_COMPLETION = 'Awaiting your enable/fallback choice.';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Cursor retry authority prose is identical in delivered docs, the runtime block, and its TS fallback', () => {
  const teamRule = read('src/modules/rules/rules/common/senior-engineer-team.md');
  const orchestrator = read('src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md');
  const gateSkill = read('src/modules/agent-model/skill/SKILL.md');
  const runtime = read('src/modules/agent-model/cursor-failure-prose.ts');

  for (const [name, source] of [
    ['team rule', teamRule],
    ['orchestrator', orchestrator],
    ['agent-model T1BLOCK', gateSkill],
    ['TypeScript fallback', runtime],
  ] as const) {
    assert.ok(source.includes(AUTHORITATIVE_RETRY), `${name} must carry the canonical Cursor retry invariant verbatim`);
  }

  const block = gateSkill.match(/<!-- T1BLOCK:BEGIN cursor-api-limit-auto-retry -->([\s\S]*?)<!-- T1BLOCK:END cursor-api-limit-auto-retry -->/)?.[1] || '';
  assert.ok(block.includes(AUTHORITATIVE_RETRY), 'the invariant belongs to the emitted auto-retry block, not dead free prose');
});

test('every Cursor failure T1BLOCK is byte-identical to its raw TypeScript fallback template', () => {
  const gateSkill = read('src/modules/agent-model/skill/SKILL.md');
  const cases: Array<{
    name: keyof typeof CURSOR_FAILURE_BLOCK_FALLBACKS;
    vars: Record<string, string>;
  }> = [
    {
      name: 'cursor-api-limit-auto-retry',
      vars: { ROLE: 'senior-backend', FAILED: 'gpt-5.6-terra-medium', NEXT: 'claude-sonnet-5-thinking-high' },
    },
    {
      name: 'cursor-api-limit-composer-choice',
      vars: { ROLE: 'senior-backend', RECOMMENDED: 'gpt-5.6-terra-medium', FALLBACK: 'composer-2.5-fast' },
    },
    {
      name: 'cursor-model-unavailable-runtime-choice',
      vars: { ROLE: 'senior-architect', FAILED: 'gpt-5.6-terra-medium', FALLBACK: 'gpt-5.5-medium' },
    },
    {
      name: 'cursor-model-failure-generic',
      vars: { ROLE: 'senior-frontend', FAILED: 'claude-sonnet-5-thinking-high' },
    },
    {
      name: 'cursor-api-limit-terminal',
      vars: { ROLE: 'senior-tester', TRIED: 'gpt-5.6-terra-medium, composer-2.5-fast' },
    },
  ];

  for (const { name, vars } of cases) {
    const body = extractBlock(gateSkill, name);
    assert.notEqual(body, null, `missing authoritative T1BLOCK ${name}`);
    assert.equal(
      CURSOR_FAILURE_BLOCK_FALLBACKS[name],
      body,
      `${name} fallback drifted from its authoritative T1BLOCK`,
    );
    const rendered = applyVars(CURSOR_FAILURE_BLOCK_FALLBACKS[name], vars);
    assert.equal(rendered, applyVars(body!, vars), `${name} renders differently through the fallback`);
    assert.doesNotMatch(rendered, /{{[A-Z_]+}}/, `${name} fixture must cover every template variable`);
  }
});

test('Cursor model capture instructions are required and byte-identical to the fail-closed fallback', () => {
  const gateSkill = read('src/modules/agent-model/skill/SKILL.md');
  const body = extractBlock(gateSkill, 'cursor-models-capture');
  assert.notEqual(body, null);
  assert.equal(CURSOR_MODELS_CAPTURE_FALLBACK, body);
  assert.match(body!, /required before the first team spawn/i);
  assert.doesNotMatch(body!, /optional|re-issue the same.*unchanged/i);
});

test('Cursor synthetic completion is idempotent in both parent-facing delivered sources', () => {
  const teamRule = read('src/modules/rules/rules/common/senior-engineer-team.md');
  const orchestrator = read('src/modules/skills/skills-catalog/senior-eng-orchestrator/SKILL.md');
  for (const [name, source] of [['team rule', teamRule], ['orchestrator', orchestrator]] as const) {
    assert.match(source, /Briefly inform the user/);
    assert.ok(source.includes(SYNTHETIC_COMPLETION), `${name} must contain the idempotent pending-choice response`);
    assert.match(source, /model-choice-prompted[^\n]*(?:not proof|not sufficient)/i);
  }
});
