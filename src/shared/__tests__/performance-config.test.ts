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

test('agentTierForPlan: the OpenCode tier bump is DISABLED — useOpenCode never changes the tier (withOpenCode === base)', () => {
  // The bump was disabled (config/performance.ts): enabling OpenCode must NOT move a
  // role up a tier. Before, balanced+OpenCode silently ran the seniors on `highest`
  // (Opus) — making "balanced" === "high" and diverging from the wizard's displayed
  // line-up. Core invariant: for every host/plan/level/role, OpenCode on === off.
  const cases: ReadonlyArray<readonly [string, string, string, string]> = [
    ['claude', 'max', 'balanced', 'senior-architect'],
    ['cursor', 'max', 'balanced', 'senior-architect'],
    ['codex', 'max', 'balanced', 'senior-frontend'],
    ['claude', 'free', 'high', 'senior-architect'],
    ['cursor', 'free', 'balanced', 'senior-backend'],
    ['claude', 'max', 'high', 'senior-architect'],
    ['claude', 'max', 'high', 'senior-tester'],
  ];
  for (const [host, plan, level, role] of cases) {
    assert.equal(
      agentTierForPlan(host, plan, level, role, true),
      agentTierForPlan(host, plan, level, role, false),
      `${host}/${plan}/${level}/${role}: OpenCode must not change the tier`,
    );
  }
  // The key regression: balanced architect resolves to 'balanced', NOT 'highest'.
  assert.equal(agentTierForPlan('claude', 'max', 'balanced', 'senior-architect', true), 'balanced');
  // High stays 'highest' with OpenCode (kept at base — NOT downgraded to balanced).
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'senior-architect', true), 'highest');
});

test('agentTierForPlan: solo/unknown level → null; unconfigured role → null', () => {
  assert.equal(agentTierForPlan('claude', 'max', 'low', 'senior-architect'), null);
  assert.equal(agentTierForPlan('claude', 'max', 'bogus', 'senior-architect'), null);
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'mystery-role'), null);
});
