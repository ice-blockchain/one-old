import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentTierForPlan, recommendLevelForPlan } from '../performance-config';

test('recommendLevelForPlan maps plan → level, bumps with OpenCode, clamps at high', () => {
  assert.equal(recommendLevelForPlan('claude', 'free'), 'low');
  assert.equal(recommendLevelForPlan('claude', 'free', true), 'balanced');
  assert.equal(recommendLevelForPlan('claude', 'pro'), 'balanced');
  assert.equal(recommendLevelForPlan('claude', 'pro', true), 'high');
  assert.equal(recommendLevelForPlan('claude', 'max'), 'high');
  assert.equal(recommendLevelForPlan('claude', 'max', true), 'high'); // already top
  assert.equal(recommendLevelForPlan('codex', 'plus', true), 'high');
  assert.equal(recommendLevelForPlan('cursor', 'free'), 'low');
  // unknown plan → host default plan's level (claude default = free → low)
  assert.equal(recommendLevelForPlan('claude', 'mystery'), 'low');
});

test('agentTierForPlan: a plan with no override uses DEFAULT_AGENT_TIERS (hand-tuned tester stays low)', () => {
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'senior-architect'), 'highest');
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'senior-tester'), 'cheapest');
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'senior-shipper'), 'balanced');
  assert.equal(agentTierForPlan('claude', 'max', 'balanced', 'senior-architect'), 'balanced');
});

test('agentTierForPlan: a sparse PLAN_AGENT_TIERS deviation overrides the default (free is cheaper)', () => {
  assert.equal(agentTierForPlan('codex', 'free', 'high', 'senior-architect'), 'balanced');
  assert.equal(agentTierForPlan('codex', 'free', 'balanced', 'senior-architect'), 'cheapest');
  // a role not listed in the free override inherits the default
  assert.equal(agentTierForPlan('codex', 'free', 'high', 'senior-tester'), 'cheapest');
});

test('agentTierForPlan: useOpenCode selects the withOpenCode tier', () => {
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'senior-tester', true), 'balanced');
  assert.equal(agentTierForPlan('claude', 'free', 'high', 'senior-architect', true), 'highest');
});

test('agentTierForPlan: solo/unknown level → null; unconfigured role → null', () => {
  assert.equal(agentTierForPlan('claude', 'max', 'low', 'senior-architect'), null);
  assert.equal(agentTierForPlan('claude', 'max', 'bogus', 'senior-architect'), null);
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'mystery-role'), null);
});
