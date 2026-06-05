import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalHost, canonicalPlan, canonicalTier, recommendTierForPlan, resolveModel, tierModelTable } from '../model-tiers';

test('canonicalTier maps ids + aliases and rejects unknown/non-strings', () => {
  assert.equal(canonicalTier('highest'), 'highest');
  assert.equal(canonicalTier('high'), 'highest');
  assert.equal(canonicalTier('HIGH'), 'highest');
  assert.equal(canonicalTier('balance'), 'balanced');
  assert.equal(canonicalTier('cheap'), 'cheapest');
  assert.equal(canonicalTier('nope'), null);
  assert.equal(canonicalTier(5), null);
});

test('resolveModel resolves per host', () => {
  assert.equal(resolveModel('highest', 'claude'), 'opus');
  assert.equal(resolveModel('balanced', 'codex'), 'gpt-5.4');
  assert.equal(resolveModel('cheapest', 'cursor'), 'haiku');
  assert.equal(resolveModel('bad', 'claude'), null);
});

test('canonicalHost defaults to claude for unknowns', () => {
  assert.equal(canonicalHost('codex'), 'codex');
  assert.equal(canonicalHost('weird'), 'claude');
});

test('tierModelTable returns all host columns', () => {
  assert.deepEqual(tierModelTable('highest'), {
    tier: 'highest', claude: 'opus', codex: 'gpt-5.5', cursor: 'opus',
  });
  assert.equal(tierModelTable('bad'), null);
});

test('canonicalPlan resolves ids/aliases per host and falls back to the host default', () => {
  assert.equal(canonicalPlan('claude', 'max'), 'max');
  assert.equal(canonicalPlan('claude', 'MAX'), 'max');
  assert.equal(canonicalPlan('claude', 'maximum'), 'max');
  assert.equal(canonicalPlan('claude', 'team'), 'team');
  assert.equal(canonicalPlan('codex', 'plus'), 'plus');
  assert.equal(canonicalPlan('codex', 'prolite'), 'plus'); // ChatGPT Go / Pro-Lite → Plus
  assert.equal(canonicalPlan('codex', 'Pro-Lite'), 'plus'); // separators + case normalized
  assert.equal(canonicalPlan('cursor', 'business'), 'business');
  // cross-host / unknown / non-string → host default
  assert.equal(canonicalPlan('claude', 'plus'), 'free'); // plus isn't a claude plan → claude default
  assert.equal(canonicalPlan('codex', 'max'), 'free'); // max isn't a codex plan → codex default
  assert.equal(canonicalPlan('cursor', 'nope'), 'free'); // unknown → cursor default
  assert.equal(canonicalPlan('claude', 5), 'free'); // non-string → default
});

test('recommendTierForPlan maps plan → tier, bumps one step with OpenCode, clamps at top', () => {
  assert.equal(recommendTierForPlan('claude', 'free'), 'cheapest');
  assert.equal(recommendTierForPlan('claude', 'free', true), 'balanced');
  assert.equal(recommendTierForPlan('claude', 'pro'), 'balanced');
  assert.equal(recommendTierForPlan('claude', 'pro', true), 'highest');
  assert.equal(recommendTierForPlan('claude', 'max'), 'highest');
  assert.equal(recommendTierForPlan('claude', 'max', true), 'highest'); // already top
  assert.equal(recommendTierForPlan('codex', 'plus'), 'balanced');
  assert.equal(recommendTierForPlan('codex', 'business', true), 'highest');
  // unknown plan → the host default plan's tier (codex default = free)
  assert.equal(recommendTierForPlan('codex', 'mystery'), 'cheapest');
});
