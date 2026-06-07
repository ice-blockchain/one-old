import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoLaunchesTeam, effectiveTierForRole, modelForRole, modelForRoleHost, teamModeForLevel } from '../performance';

test('teamModeForLevel maps levels (default main-agent)', () => {
  assert.equal(teamModeForLevel('low'), 'main-agent');
  assert.equal(teamModeForLevel('balanced'), 'subagents');
  assert.equal(teamModeForLevel('high'), 'subagents');
  assert.equal(teamModeForLevel('bogus'), 'main-agent');
});

test('autoLaunchesTeam is true only for balanced/high', () => {
  assert.equal(autoLaunchesTeam('low'), false);
  assert.equal(autoLaunchesTeam('balanced'), true);
  assert.equal(autoLaunchesTeam('high'), true);
});

test('effectiveTierForRole honors config + overrides; null for low', () => {
  assert.equal(effectiveTierForRole('high', 'senior-architect'), 'highest');
  assert.equal(effectiveTierForRole('high', 'senior-tester'), 'cheapest');
  assert.equal(effectiveTierForRole('high', 'senior-tester', { 'senior-tester': 'highest' }), 'highest');
  assert.equal(effectiveTierForRole('low', 'senior-architect'), null); // low has no subagents
  assert.equal(effectiveTierForRole('high', 'unknown-role'), null);
});

test('modelForRoleHost resolves per host; modelForRole gives all columns', () => {
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude'), 'opus');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'codex'), 'gpt-5.4-mini'); // cheapest
  assert.equal(modelForRoleHost('high', 'senior-tester', 'claude', { 'senior-tester': 'highest' }), 'opus');
  assert.equal(modelForRoleHost('low', 'senior-architect', 'claude'), null);
  assert.deepEqual(modelForRole('balanced', 'senior-frontend'), {
    tier: 'balanced', claude: 'sonnet', codex: 'gpt-5.4', cursor: 'sonnet',
  });
});

test('effectiveTierForRole: planCtx makes tiers plan-aware; overrides win; legacy unchanged', () => {
  const free = { host: 'claude', plan: 'free', useOpenCode: false };
  const max = { host: 'claude', plan: 'max', useOpenCode: false };
  // legacy (no planCtx) → PERFORMANCE_CONFIG default
  assert.equal(effectiveTierForRole('high', 'senior-architect'), 'highest');
  // plan-aware: free high architect drops to balanced; max high architect stays highest
  assert.equal(effectiveTierForRole('high', 'senior-architect', null, free), 'balanced');
  assert.equal(effectiveTierForRole('high', 'senior-architect', null, max), 'highest');
  // a user override beats the plan
  assert.equal(effectiveTierForRole('high', 'senior-architect', { 'senior-architect': 'cheapest' }, max), 'cheapest');
  // low has no subagents → null regardless of plan
  assert.equal(effectiveTierForRole('low', 'senior-architect', null, max), null);
});

test('modelForRoleHost threads planCtx → plan-aware model id', () => {
  const free = { host: 'claude', plan: 'free', useOpenCode: false };
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude', null, free), 'sonnet'); // free → balanced
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude', null, null), 'opus'); // legacy → highest
});

test('planTier precedence: team.overrides > planTier > plan-aware > default; absent ⇒ unchanged', () => {
  const max = { host: 'claude', plan: 'max', useOpenCode: false };
  const free = { host: 'claude', plan: 'free', useOpenCode: false };
  // planTier replaces the static/plan-aware default for that role
  assert.equal(effectiveTierForRole('high', 'senior-frontend', null, null, 'cheapest'), 'cheapest');
  assert.equal(effectiveTierForRole('high', 'senior-frontend', null, max, 'cheapest'), 'cheapest');
  // a user override still wins over the orchestrator's per-prompt planTier
  assert.equal(effectiveTierForRole('high', 'senior-frontend', { 'senior-frontend': 'highest' }, null, 'cheapest'), 'highest');
  // planTier beats the plan-aware tier (free high frontend would be 'balanced')
  assert.equal(effectiveTierForRole('high', 'senior-frontend', null, free, 'highest'), 'highest');
  // null/undefined planTier ⇒ behavior identical to before
  assert.equal(effectiveTierForRole('high', 'senior-frontend', null, null, null), 'highest');
  // resolves to a host model id through modelForRoleHost
  assert.equal(modelForRoleHost('high', 'senior-frontend', 'claude', null, max, 'cheapest'), 'haiku');
});
