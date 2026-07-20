import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentTierForPlan, recommendLevelForPlan } from '../performance-config';
import { recommendTierForPlan } from '../model-tiers';
import { HOST_PLAN_IDS, PLAN_TIER_RECOMMENDATIONS } from '../../config/model-tiers';
import {
  DEFAULT_AGENT_TIERS,
  PLAN_AGENT_TIERS,
  PLAN_PERFORMANCE_RECOMMENDATIONS,
} from '../../config/performance';

test('recommendLevelForPlan maps each plan directly to its configured level', () => {
  assert.equal(recommendLevelForPlan('claude', 'free'), 'low'); // undetectable-metadata fallback → conservative solo
  assert.equal(recommendLevelForPlan('claude', 'pro'), 'balanced');
  assert.equal(recommendLevelForPlan('claude', 'max'), 'high');
  assert.equal(recommendLevelForPlan('claude', 'team'), 'balanced');
  assert.equal(recommendLevelForPlan('claude', 'enterprise'), 'balanced');
  assert.equal(recommendLevelForPlan('codex', 'plus'), 'balanced');
  assert.equal(recommendLevelForPlan('codex', 'pro'), 'high');
  assert.equal(recommendLevelForPlan('codex', 'prolite'), 'high');
  assert.equal(recommendLevelForPlan('cursor', 'free'), 'low');
  assert.equal(recommendLevelForPlan('opencode', 'free'), 'low');
  assert.equal(recommendLevelForPlan('kilo', 'free'), 'low');
  assert.equal(recommendLevelForPlan('copilot', 'Copilot Pro'), 'balanced');
  assert.equal(recommendLevelForPlan('copilot', 'GitHub Copilot Pro'), 'balanced');
  assert.equal(recommendLevelForPlan('windsurf', 'free'), 'low');
  assert.equal(recommendLevelForPlan('windsurf', 'max'), 'high');
  // unknown plan → host default plan's level (Claude default plan = free)
  assert.equal(recommendLevelForPlan('claude', 'mystery'), 'low');
});

test('recommendLevelForPlan opencode Go (plus): Balanced, NOT Low (the missing-plus-entry regression)', () => {
  // Before the fix, PLAN_PERFORMANCE_RECOMMENDATIONS.opencode had only `free`, so a Go
  // subscriber fell through DEFAULT_HOST_PLAN.opencode='free' → 'low' (the wizard kept
  // recommending Low to a paying user). plus + its `go` alias must both resolve Balanced,
  // without depending on an unrelated delegation preference.
  assert.equal(recommendLevelForPlan('opencode', 'plus'), 'balanced');
  assert.equal(recommendLevelForPlan('opencode', 'go'), 'balanced');
  // The level table and the tier table must agree for Go.
  assert.equal(recommendTierForPlan('opencode', 'go'), 'balanced');
  assert.equal(recommendTierForPlan('opencode', 'plus'), 'balanced');
});

test('performance recommendation and role-tier tables store direct scalar values', () => {
  for (const plans of Object.values(PLAN_PERFORMANCE_RECOMMENDATIONS)) {
    for (const level of Object.values(plans)) assert.equal(typeof level, 'string');
  }
  for (const roles of Object.values(DEFAULT_AGENT_TIERS)) {
    for (const tier of Object.values(roles)) assert.equal(typeof tier, 'string');
  }
  for (const plans of Object.values(PLAN_AGENT_TIERS)) {
    for (const levels of Object.values(plans)) {
      for (const roles of Object.values(levels || {})) {
        for (const tier of Object.values(roles || {})) assert.equal(typeof tier, 'string');
      }
    }
  }
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
  // Windsurf Free stays cost-conservative even while two quota-free SWE models
  // are available during the SWE-1.7 preview.
  assert.equal(agentTierForPlan('windsurf', 'free', 'high', 'senior-architect'), 'cheapest');
  assert.equal(agentTierForPlan('windsurf', 'free', 'high', 'senior-shipper'), 'cheapest');
  // Kilo's "free" is an undetected-account fallback, not proof that only one
  // free model tier is selectable. Manual Balanced/High choices keep their tiers.
  assert.equal(agentTierForPlan('kilo', 'free', 'balanced', 'senior-architect'), 'balanced');
  assert.equal(agentTierForPlan('kilo', 'free', 'high', 'senior-architect'), 'highest');
  assert.equal(agentTierForPlan('kilo', 'free', 'high', 'senior-tester'), 'cheapest');
});

test('agentTierForPlan has one deterministic tier per host/plan/level/role', () => {
  assert.equal(agentTierForPlan('claude', 'max', 'balanced', 'senior-architect'), 'balanced');
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'senior-architect'), 'highest');
  assert.equal(agentTierForPlan('claude', 'free', 'high', 'senior-architect'), 'highest');
});

test('agentTierForPlan: solo/unknown level → null; unconfigured role → null', () => {
  assert.equal(agentTierForPlan('claude', 'max', 'low', 'senior-architect'), null);
  assert.equal(agentTierForPlan('claude', 'max', 'bogus', 'senior-architect'), null);
  assert.equal(agentTierForPlan('claude', 'max', 'high', 'mystery-role'), null);
});
