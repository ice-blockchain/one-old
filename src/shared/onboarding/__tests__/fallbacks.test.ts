import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPEN_CODE_INSTALL,
  nextOnboardingStepPromptAndRequest,
  onboardingGateFallbackReason,
  openCodeChatFallback,
  projectContextChatFallback,
  repairedMaterializationDenyReason,
  teamConfirmationChatFallback,
  teamConfirmationGateFallbackReason,
  teamConfirmationPromptContext,
  type OnboardingBlock,
} from '../fallbacks';
import { makeSkillBlock } from '../../skill-block';
import { pluginRoot } from '../../paths';

// Single source of truth: the real skill block bound to the onboarding-gate
// module (reads its SKILL.md). The wording lives only there now.
const skillBlock = makeSkillBlock(pluginRoot);
const skill: OnboardingBlock = (name, vars) => skillBlock('onboarding-gate', name, vars);

test('openCodeChatFallback renders the install command', () => {
  const out = openCodeChatFallback(skill);
  assert.ok(out.includes(OPEN_CODE_INSTALL));
  assert.ok(out.includes('Enable OpenCode delegation'));
});

test('projectContextChatFallback fills original prompt + dynamic domain questions', () => {
  const state = { projectContext: { originalPrompt: 'an online course academy' } };
  const out = projectContextChatFallback(state, skill);
  assert.ok(out.includes('an online course academy'));
  assert.ok(out.includes('Learning platform specifics'));
  assert.ok(out.includes('audience, coreFlows')); // answer keys joined
  // no original prompt → no intro line, generic domain question
  const generic = projectContextChatFallback({}, skill);
  assert.ok(!generic.includes('Original request'));
  assert.ok(generic.includes('Domain specifics'));
});

test('teamConfirmationChatFallback renders the role line-up for the level', () => {
  const out = teamConfirmationChatFallback('high', null, skill);
  assert.ok(out.includes('HIGH mode'));
  assert.ok(out.includes('senior-architect'));
  assert.ok(out.includes('Approve'));
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

test('gate deny-reason composers embed the next-step prompt / context', () => {
  const reason = onboardingGateFallbackReason({ mode: 'new-project' }, skill);
  assert.ok(reason.includes('onboarding gate: mode=new-project'));
  assert.ok(reason.includes('OpenCode')); // the embedded next-step prompt
  const team = teamConfirmationGateFallbackReason({ performance: { level: 'high' }, team: { mode: 'subagents' } }, skill);
  assert.ok(team.includes('lineup has not been approved'));
  assert.ok(team.includes('Team Confirmation is still required'));
  assert.ok(repairedMaterializationDenyReason(skill).includes('repaired/materialized before this tool use'));
});
