import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPEN_CODE_INSTALL,
  nextOnboardingStepPromptAndRequest,
  openCodeChatFallback,
  projectContextChatFallback,
  teamConfirmationChatFallback,
  teamConfirmationPromptContext,
  type OnboardingBlock,
} from '../fallbacks';
import { makeSkillBlock } from '../../skill-block';
import { pluginRoot } from '../../paths';

// Real skill block bound to the onboarding-gate module (reads its SKILL.md).
const skillBlock = makeSkillBlock(pluginRoot);
const skill: OnboardingBlock = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);
// Verbatim-fallback path: ignore the skill, return the in-code fallback.
const verbatim: OnboardingBlock = (_name, _vars, fallback) => fallback;

test('openCodeChatFallback renders the install command (skill + verbatim agree)', () => {
  for (const block of [skill, verbatim]) {
    const out = openCodeChatFallback(block);
    assert.ok(out.includes(OPEN_CODE_INSTALL));
    assert.ok(out.includes('Enable OpenCode delegation'));
  }
});

test('projectContextChatFallback fills original prompt + dynamic domain questions', () => {
  const state = { projectContext: { originalPrompt: 'an online course academy' } };
  for (const block of [skill, verbatim]) {
    const out = projectContextChatFallback(state, block);
    assert.ok(out.includes('an online course academy'));
    assert.ok(out.includes('Learning platform specifics'));
    assert.ok(out.includes('audience, coreFlows')); // answer keys joined
  }
  // no original prompt → no intro line, generic domain question
  const generic = projectContextChatFallback({}, skill);
  assert.ok(!generic.includes('Original request'));
  assert.ok(generic.includes('Domain specifics'));
});

test('teamConfirmationChatFallback renders the role line-up for the level', () => {
  for (const block of [skill, verbatim]) {
    const out = teamConfirmationChatFallback('high', null, block);
    assert.ok(out.includes('HIGH mode'));
    assert.ok(out.includes('senior-architect'));
    assert.ok(out.includes('Approve'));
  }
});

test('teamConfirmationPromptContext embeds the chat fallback + a source-specific note', () => {
  const state = { performance: { level: 'high' }, team: { mode: 'subagents' } };
  const gate = teamConfirmationPromptContext(state, 'gate', skill);
  assert.ok(gate.includes('Team Confirmation is still required'));
  assert.ok(gate.includes('next visible assistant message must ask'));
  const userPrompt = teamConfirmationPromptContext(state, 'user-prompt', skill);
  assert.ok(userPrompt.includes('explicit "Approve" answer'));
});

test('nextOnboardingStepPromptAndRequest routes to the first unresolved step', () => {
  const r = nextOnboardingStepPromptAndRequest({ mode: 'new-project' }, 'gate', skill);
  assert.ok(r.fallbackText.includes('OpenCode'));
  assert.equal(r.promptRequest?.id, 'traffic-one.onboarding.open-code');
  // not a new project → no prompt
  const none = nextOnboardingStepPromptAndRequest({ mode: 'existing-codebase' }, 'gate', skill);
  assert.equal(none.promptRequest, null);
});
