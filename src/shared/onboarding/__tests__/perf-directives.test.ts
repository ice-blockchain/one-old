import { test } from 'node:test';
import assert from 'node:assert/strict';

import { balancedModeDirective, highModeDirective, lowModeDirective, performanceLevelDirective, performancePopupBlock, teamConfirmationPopupBlock } from '../perf-directives';
import type { OnboardingBlock } from '../fallbacks';
import { makeSkillBlock } from '../../skill-block';
import { pluginRoot } from '../../paths';

const skillBlock = makeSkillBlock(pluginRoot);
const skill: OnboardingBlock = (name, vars) => skillBlock('onboarding-gate', name, vars);

test('lowModeDirective renders the main-agent role checklist', () => {
  const out = lowModeDirective(skill);
  assert.ok(out.includes('performance: LOW'));
  assert.ok(out.includes('- [ ] senior-architect'));
  assert.ok(out.includes('Team mode: main-agent'));
});

test('balanced/high mode directives render the team line-up + model-set instructions', () => {
  const bal = balancedModeDirective(null, skill);
  assert.ok(bal.includes('performance: BALANCED'));
  assert.ok(bal.includes('senior-architect: balanced'));
  assert.ok(bal.includes('HOW TO ACTUALLY SET THE MODEL'));
  const high = highModeDirective(null, skill);
  assert.ok(high.includes('performance: HIGH'));
  assert.ok(high.includes('senior-architect: highest'));
  assert.ok(high.includes('senior-tester: cheapest'));
});

test('highModeDirective annotates per-role overrides', () => {
  const out = highModeDirective({ 'senior-tester': 'highest' }, skill);
  // target the agent-assignment line (has the host-model columns), not the prose summary
  const testerLine = out.split('\n').find((l) => l.includes('senior-tester') && l.includes('claude:'));
  assert.ok(testerLine);
  assert.ok(testerLine!.includes('(override)'));
});

test('performanceLevelDirective dispatches by level', () => {
  assert.ok(performanceLevelDirective('low', null, skill).includes('performance: LOW'));
  assert.ok(performanceLevelDirective('balanced', null, skill).includes('performance: BALANCED'));
  assert.ok(performanceLevelDirective('high', null, skill).includes('performance: HIGH'));
  assert.equal(performanceLevelDirective('bogus', null, skill), '');
});

test('performancePopupBlock renders popup 1', () => {
  assert.ok(performancePopupBlock(skill).includes('AGENT PERFORMANCE PREFLIGHT'));
  assert.ok(performancePopupBlock(skill).includes('popup 2'));
});

test('teamConfirmationPopupBlock renders popup 2 with the HIGH + BALANCED tables', () => {
  const out = teamConfirmationPopupBlock(skill);
  assert.ok(out.includes('TEAM CONFIRMATION PREFLIGHT'));
  assert.ok(out.includes('--- HIGH ---'));
  assert.ok(out.includes('--- BALANCED ---'));
  assert.ok(out.includes('senior-architect: highest')); // HIGH rows
  assert.ok(out.includes('senior-tester: cheapest'));
});
