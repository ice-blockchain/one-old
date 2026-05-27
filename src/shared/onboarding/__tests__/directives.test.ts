import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentModePrompt, codexDefaultModeFallbackDirective, hostPopupInstruction } from '../directives';
import type { OnboardingBlock } from '../fallbacks';
import { makeSkillBlock } from '../../skill-block';
import { pluginRoot } from '../../paths';
import { promptTextFromSubmit } from '../../prompt-input';

const skillBlock = makeSkillBlock(pluginRoot);
const skill: OnboardingBlock = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);
const verbatim: OnboardingBlock = (_name, _vars, fallback) => fallback;

test('agentModePrompt renders the three agent-mode options', () => {
  for (const block of [skill, verbatim]) {
    const out = agentModePrompt(block);
    assert.ok(out.includes('High (Recommended)'));
    assert.ok(out.includes('Balanced'));
    assert.ok(out.includes('Low'));
  }
});

test('hostPopupInstruction names the host popup tools', () => {
  for (const block of [skill, verbatim]) {
    const out = hostPopupInstruction(block);
    assert.ok(out.includes('request_user_input'));
    assert.ok(out.includes('AskUserQuestion'));
  }
});

test('codexDefaultModeFallbackDirective embeds the agent-mode prompt', () => {
  for (const block of [skill, verbatim]) {
    const out = codexDefaultModeFallbackDirective(block);
    assert.ok(out.includes('CURRENT-THREAD ONBOARDING FALLBACK'));
    assert.ok(out.includes('High (Recommended)')); // embedded agent-mode prompt
    assert.ok(out.includes('Mobile App'));
  }
});

test('promptTextFromSubmit reads the prompt from host field-name variants', () => {
  assert.equal(promptTextFromSubmit(JSON.stringify({ prompt: 'build x' })), 'build x');
  assert.equal(promptTextFromSubmit(JSON.stringify({ user_prompt: 'hello' })), 'hello');
  assert.equal(promptTextFromSubmit(JSON.stringify({ message: '  hi  ' })), '  hi  ');
  assert.equal(promptTextFromSubmit(JSON.stringify({})), '');
  assert.equal(promptTextFromSubmit('not json'), '');
  assert.equal(promptTextFromSubmit({ text: 'obj form' }), 'obj form');
});
