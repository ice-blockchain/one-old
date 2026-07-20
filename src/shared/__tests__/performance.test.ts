import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  autoLaunchesTeam,
  effectiveTierForRole,
  modelForRole,
  modelForRoleHost,
  openCodeDelegationActive,
  roleModelSelection,
  teamModeForLevel,
} from '../performance';
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
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude'), 'claude-fable-5');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'codex'), 'gpt-5.6-terra'); // cheapest
  assert.equal(modelForRoleHost('high', 'senior-tester', 'kilo'), 'kilo/kilo-auto/free');
  assert.equal(modelForRoleHost('high', 'senior-architect', 'windsurf'), 'SWE-1.7');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'claude', { 'senior-tester': 'highest' }), 'claude-fable-5');
  assert.equal(modelForRoleHost('low', 'senior-architect', 'claude'), null);
  assert.deepEqual(modelForRole('balanced', 'senior-frontend'), {
    tier: 'balanced', claude: 'claude-sonnet-5', codex: 'gpt-5.6-terra', cursor: 'gpt-5.6-terra', opencode: OPENCODE_FREE_MODELS[1], copilot: 'gpt-5.6-terra', windsurf: 'SWE-1.7', kilo: 'kilo/kilo-auto/balanced',
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
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude', null, free), 'claude-fable-5');
  assert.equal(modelForRoleHost('high', 'senior-architect', 'claude', null, null), 'claude-fable-5'); // legacy → highest
  const windsurfFree = { host: 'windsurf', plan: 'free' };
  // Windsurf Free keeps the conservative PLAN_AGENT_TIERS policy even while
  // SWE-1.7 and SWE-1.6 are both quota-free during the preview window.
  assert.equal(modelForRoleHost('high', 'senior-architect', 'windsurf', null, windsurfFree), 'SWE-1.6');
  const windsurfPro = { host: 'windsurf', plan: 'pro' };
  assert.equal(modelForRoleHost('high', 'senior-architect', 'windsurf', null, windsurfPro), 'SWE-1.7');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'windsurf', null, windsurfPro), 'SWE-1.6');
  const kiloUndetected = { host: 'kilo', plan: 'free' };
  assert.equal(modelForRoleHost('balanced', 'senior-architect', 'kilo', null, kiloUndetected), 'kilo/kilo-auto/balanced');
  assert.equal(modelForRoleHost('high', 'senior-architect', 'kilo', null, kiloUndetected), 'kilo/kilo-auto/frontier');
  assert.equal(modelForRoleHost('high', 'senior-tester', 'kilo', null, kiloUndetected), 'kilo/kilo-auto/free');
});

test('role model selections reorder the effective row and require a matching cross-tier override', () => {
  const planCtx = { host: 'claude', plan: 'max' };
  const sameTier = { 'senior-architect': 'claude-opus-4-8' };

  assert.deepEqual(
    roleModelSelection('high', 'senior-architect', 'claude', null, sameTier, planCtx),
    {
      tier: 'highest',
      preferredModel: 'claude-opus-4-8',
      acceptableModels: ['claude-opus-4-8', 'claude-fable-5', 'opus'],
    },
  );
  assert.equal(
    modelForRoleHost('high', 'senior-architect', 'claude', null, planCtx, process.env, sameTier),
    'claude-opus-4-8',
  );

  const crossTier = { 'senior-architect': 'claude-sonnet-5' };
  assert.equal(
    roleModelSelection('high', 'senior-architect', 'claude', null, crossTier, planCtx),
    null,
  );
  assert.equal(
    modelForRoleHost('high', 'senior-architect', 'claude', null, planCtx, process.env, crossTier),
    null,
    'an explicit cross-tier model must fail closed instead of falling back to the tier default',
  );

  assert.deepEqual(
    roleModelSelection(
      'high',
      'senior-architect',
      'claude',
      { 'senior-architect': 'balanced' },
      crossTier,
      planCtx,
    ),
    {
      tier: 'balanced',
      preferredModel: 'claude-sonnet-5',
      acceptableModels: ['claude-sonnet-5', 'claude-sonnet-4-6', 'sonnet'],
    },
    'the selected model becomes valid once the same submission moves the role to its tier',
  );

  assert.equal(
    modelForRoleHost(
      'high',
      'senior-tester',
      'claude',
      null,
      planCtx,
      process.env,
      { 'senior-tester': 'claude-sonnet-4-6' },
    ),
    'claude-sonnet-4-6',
    'an id shared by multiple catalog rows is valid when it belongs to the role\'s effective row',
  );
});

test('openCodeDelegationActive is disabled on OpenCode-compatible self hosts', () => {
  const state = { openCode: { enabled: true }, toolchain: { opencode: { installedVersion: '1.0.0' } } };
  assert.equal(openCodeDelegationActive(state, 'claude'), true);
  assert.equal(openCodeDelegationActive(state, 'opencode'), false);
  assert.equal(openCodeDelegationActive(state, 'kilo'), false);
});
