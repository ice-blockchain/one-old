import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentTierForPlan, recommendLevelForPlan } from '../performance-config';
import { recommendTierForPlan } from '../model-tiers';
import { HOST_PLAN_IDS, PLAN_TIER_RECOMMENDATIONS } from '../../config/model-tiers';
import { PLAN_PERFORMANCE_RECOMMENDATIONS } from '../../config/performance';

test('recommendLevelForPlan maps plan → level, bumps with OpenCode, clamps at high', () => {
  assert.equal(recommendLevelForPlan('claude', 'free'), 'low');
  assert.equal(recommendLevelForPlan('claude', 'free', true), 'balanced');
  assert.equal(recommendLevelForPlan('claude', 'pro'), 'balanced');
  assert.equal(recommendLevelForPlan('claude', 'pro', true), 'high');
  assert.equal(recommendLevelForPlan('claude', 'max'), 'high');
  assert.equal(recommendLevelForPlan('claude', 'max', true), 'high'); // already top
  assert.equal(recommendLevelForPlan('codex', 'plus', true), 'high');
  assert.equal(recommendLevelForPlan('cursor', 'free'), 'low');
  assert.equal(recommendLevelForPlan('opencode', 'free'), 'low');
  assert.equal(recommendLevelForPlan('opencode', 'free', true), 'low');
  assert.equal(recommendLevelForPlan('kilo', 'free'), 'low');
  assert.equal(recommendLevelForPlan('kilo', 'free', true), 'low');
  assert.equal(recommendLevelForPlan('copilot', 'Copilot Pro'), 'balanced');
  assert.equal(recommendLevelForPlan('copilot', 'GitHub Copilot Pro', true), 'high');
  assert.equal(recommendLevelForPlan('windsurf', 'free'), 'low');
  assert.equal(recommendLevelForPlan('windsurf', 'max'), 'high');
  // unknown plan → host default plan's level (claude default = free → low)
  assert.equal(recommendLevelForPlan('claude', 'mystery'), 'low');
});

test('recommendLevelForPlan opencode Go (plus): Balanced, NOT Low (the missing-plus-entry regression)', () => {
  // Before the fix, PLAN_PERFORMANCE_RECOMMENDATIONS.opencode had only `free`, so a Go
  // subscriber fell through DEFAULT_HOST_PLAN.opencode='free' → 'low' (the wizard kept
  // recommending Low to a paying user). plus + its `go` alias must both resolve Balanced,
  // and stay Balanced under withOpenCode (delegation is inert on the opencode host).
  assert.equal(recommendLevelForPlan('opencode', 'plus'), 'balanced');
  assert.equal(recommendLevelForPlan('opencode', 'plus', true), 'balanced');
  assert.equal(recommendLevelForPlan('opencode', 'go'), 'balanced');
  // The level table and the tier table must agree for Go.
  assert.equal(recommendTierForPlan('opencode', 'go'), 'balanced');
  assert.equal(recommendTierForPlan('opencode', 'plus'), 'balanced');
});

test('every recognized plan has an explicit entry in BOTH recommendation tables (no silent free-fallback)', () => {
  // The opencode Go bug was a two-table drift: a plan in HOST_PLAN_IDS but absent from a
  // recommendation table silently collapses to DEFAULT_HOST_PLAN[host] (= free), downgrading
  // a paying user. Guard the whole class: every recognized plan must be spelled out in BOTH
  // PLAN_TIER_RECOMMENDATIONS and PLAN_PERFORMANCE_RECOMMENDATIONS.
  for (const [host, plans] of Object.entries(HOST_PLAN_IDS)) {
    for (const plan of plans) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(PLAN_TIER_RECOMMENDATIONS[host as keyof typeof PLAN_TIER_RECOMMENDATIONS], plan),
        `PLAN_TIER_RECOMMENDATIONS.${host} is missing recognized plan "${plan}"`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(PLAN_PERFORMANCE_RECOMMENDATIONS[host as keyof typeof PLAN_PERFORMANCE_RECOMMENDATIONS], plan),
        `PLAN_PERFORMANCE_RECOMMENDATIONS.${host} is missing recognized plan "${plan}"`,
      );
    }
  }
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
  // Copilot product labels must not route Pro accounts through the free override.
  assert.equal(agentTierForPlan('copilot', 'Copilot Pro', 'balanced', 'senior-architect'), 'balanced');
  // Windsurf Free only exposes the SWE model, so even a manual High team stays cheapest.
  assert.equal(agentTierForPlan('windsurf', 'free', 'high', 'senior-architect'), 'cheapest');
  assert.equal(agentTierForPlan('windsurf', 'free', 'high', 'senior-shipper'), 'cheapest');
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
    ['opencode', 'free', 'balanced', 'senior-frontend'],
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
