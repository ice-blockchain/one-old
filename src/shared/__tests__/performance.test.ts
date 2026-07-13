import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autoLaunchesTeam, effectiveTierForRole, modelForRole, modelForRoleHost, openCodeDelegationActive, teamModeForLevel } from '../performance';
import { OPENCODE_FREE_MODELS } from '../../config/model-tiers';

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
  assert.equal(modelForRoleHost('high', 'senior-tester', 'kilo'), 'kilo/kilo-auto/free');
  assert.equal(modelForRoleHost('high', 'senior-architect', 'windsurf'), 'SWE-1.6 Slow');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'claude', { 'senior-tester': 'highest' }), 'opus');
  assert.equal(modelForRoleHost('low', 'senior-architect', 'claude'), null);
  assert.deepEqual(modelForRole('balanced', 'senior-frontend'), {
    tier: 'balanced', claude: 'sonnet', codex: 'gpt-5.6-terra', cursor: 'gpt-5.6-terra', opencode: OPENCODE_FREE_MODELS[1], copilot: 'claude-sonnet-4.6', windsurf: 'SWE-1.6 Slow', kilo: 'kilo/kilo-auto/balanced',
  });
});

test('effectiveTierForRole: planCtx makes tiers plan-aware; overrides win; legacy unchanged', () => {
  const free = { host: 'claude', plan: 'free' };
  const max = { host: 'claude', plan: 'max' };
  // legacy (no planCtx) → PERFORMANCE_CONFIG default
  assert.equal(effectiveTierForRole('high', 'senior-architect'), 'highest');
  // Claude Free is not a Claude Code plan, so it canonicalizes to Pro.
  assert.equal(effectiveTierForRole('high', 'senior-architect', null, free), 'highest');
  assert.equal(effectiveTierForRole('high', 'senior-architect', null, max), 'highest');
  // a user override beats the plan
  assert.equal(effectiveTierForRole('high', 'senior-architect', { 'senior-architect': 'cheapest' }, max), 'cheapest');
  // low has no subagents → null regardless of plan
  assert.equal(effectiveTierForRole('low', 'senior-architect', null, max), null);
});

test('modelForRoleHost threads planCtx → plan-aware model id', () => {
  const free = { host: 'claude', plan: 'free' };
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude', null, free), 'opus'); // Free → Pro
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude', null, null), 'opus'); // legacy → highest
  const windsurfFree = { host: 'windsurf', plan: 'free' };
  assert.equal(modelForRoleHost('high', 'senior-architect', 'windsurf', null, windsurfFree), 'SWE-1.6 Slow');
  const windsurfPro = { host: 'windsurf', plan: 'pro' };
  assert.equal(modelForRoleHost('high', 'senior-architect', 'windsurf', null, windsurfPro), 'SWE-1.7 Beta');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'windsurf', null, windsurfPro), 'SWE-1.6 Slow');
  const kiloUndetected = { host: 'kilo', plan: 'free' };
  assert.equal(modelForRoleHost('balanced', 'senior-architect', 'kilo', null, kiloUndetected), 'kilo/kilo-auto/balanced');
  assert.equal(modelForRoleHost('high', 'senior-architect', 'kilo', null, kiloUndetected), 'kilo/kilo-auto/frontier');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'kilo', null, kiloUndetected), 'kilo/kilo-auto/free');
});

test('openCodeDelegationActive is disabled on OpenCode-compatible self hosts', () => {
  const state = { openCode: { enabled: true }, toolchain: { opencode: { installedVersion: '1.0.0' } } };
  assert.equal(openCodeDelegationActive(state, 'claude'), true);
  assert.equal(openCodeDelegationActive(state, 'opencode'), false);
  assert.equal(openCodeDelegationActive(state, 'kilo'), false);
});
