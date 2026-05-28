import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentModePrompt, codexDefaultModeFallbackDirective, hostPopupInstruction, onboardingReminderShort, openCodeOptInDirective, openCodePopupBlock } from '../directives';
import { OPEN_CODE_INSTALL } from '../fallbacks';
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

test('onboardingReminderShort embeds the codex fallback + points at the state schema', () => {
  const out = onboardingReminderShort(skill);
  assert.ok(out.includes('onboarding still incomplete'));
  assert.ok(out.includes('CURRENT-THREAD ONBOARDING FALLBACK')); // embedded codex fallback
  assert.ok(out.includes('.traffic-one/.one.json'));
  // verbatim fallback path still renders the codex fallback
  assert.ok(onboardingReminderShort(verbatim).includes('CURRENT-THREAD ONBOARDING FALLBACK'));
});

test('openCodeOptInDirective composes the install command + host popup + chat fallback', () => {
  for (const block of [skill, verbatim]) {
    const out = openCodeOptInDirective(block);
    assert.ok(out.includes('OPENCODE DELEGATION OPT-IN'));
    assert.ok(out.includes(OPEN_CODE_INSTALL));
    assert.ok(out.includes('request_user_input')); // host popup instruction
    assert.ok(out.includes('Enable OpenCode delegation')); // chat fallback options
  }
});

test('openCodePopupBlock renders the SessionStart OpenCode preflight (popup 0)', () => {
  for (const block of [skill, verbatim]) {
    const out = openCodePopupBlock(block);
    assert.ok(out.includes('OPENCODE DELEGATION PREFLIGHT'));
    assert.ok(out.includes(OPEN_CODE_INSTALL));
    assert.ok(out.includes('request_user_input'));
  }
});
