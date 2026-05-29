import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentModePrompt, codexDefaultModeFallbackDirective, hostPopupInstruction, onboardingReminderShort, openCodePopupBlock } from '../directives';
import { OPEN_CODE_INSTALL } from '../fallbacks';
import type { OnboardingBlock } from '../fallbacks';
import { makeSkillBlock } from '../../skill-block';
import { pluginRoot } from '../../paths';
import { promptTextFromSubmit } from '../../prompt-input';

const skillBlock = makeSkillBlock(pluginRoot);
const skill: OnboardingBlock = (name, vars) => skillBlock('onboarding-gate', name, vars);

test('agentModePrompt renders the three agent-mode options', () => {
  const out = agentModePrompt(skill);
  assert.ok(out.includes('High (Recommended)'));
  assert.ok(out.includes('Balanced'));
  assert.ok(out.includes('Low'));
});

test('hostPopupInstruction names the host popup tools', () => {
  const out = hostPopupInstruction(skill);
  assert.ok(out.includes('request_user_input'));
  assert.ok(out.includes('AskUserQuestion'));
});

test('codexDefaultModeFallbackDirective starts with the OpenCode prompt', () => {
  const out = codexDefaultModeFallbackDirective(skill);
  assert.ok(out.includes('CURRENT-THREAD ONBOARDING FALLBACK'));
  assert.ok(out.includes('Enable OpenCode delegation')); // first fallback prompt
  assert.ok(out.includes('Agent Mode'));
  assert.ok(out.includes('Mobile App'));
});

test('promptTextFromSubmit reads the prompt from host field-name variants', () => {
  assert.equal(promptTextFromSubmit(JSON.stringify({ prompt: 'build x' })), 'build x');
  assert.equal(promptTextFromSubmit(JSON.stringify({ user_prompt: 'hello' })), 'hello');
  assert.equal(promptTextFromSubmit(JSON.stringify({ message: '  hi  ' })), '  hi  ');
  assert.equal(promptTextFromSubmit(JSON.stringify({})), '');
  assert.equal(promptTextFromSubmit('not json'), '');
  assert.equal(promptTextFromSubmit({ text: 'obj form' }), 'obj form');
});

test('onboardingReminderShort embeds the codex fallback + points at the state schema', () => {
  const out = onboardingReminderShort(skill);
  assert.ok(out.includes('onboarding still incomplete'));
  assert.ok(out.includes('CURRENT-THREAD ONBOARDING FALLBACK')); // embedded codex fallback
  assert.ok(out.includes('.traffic-one/.one.json'));
});

test('openCodePopupBlock renders the SessionStart OpenCode preflight (popup 0)', () => {
  const out = openCodePopupBlock(skill);
  assert.ok(out.includes('OPENCODE DELEGATION PREFLIGHT'));
  assert.ok(out.includes(OPEN_CODE_INSTALL));
  assert.ok(out.includes('request_user_input'));
});
