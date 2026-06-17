import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acceptableModelsFor, canonicalHost, canonicalPlan, canonicalTier, modelMatchesAny, modelMatchesExpected, recommendTierForPlan, resolveModel, tierModelTable } from '../model-tiers';

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
  // Cursor uses real Cursor model IDs, not Anthropic aliases.
  assert.equal(resolveModel('highest', 'cursor'), 'claude-opus-4-8-thinking-high');
  assert.equal(resolveModel('balanced', 'cursor'), 'claude-4.6-sonnet-medium-thinking');
  assert.equal(resolveModel('cheapest', 'cursor'), 'composer-2.5-fast');
  assert.equal(resolveModel('bad', 'claude'), null);
});

test('modelMatchesExpected accepts exact + same-family variants, rejects other families/empty', () => {
  // Exact match (Claude/Codex pass bare ids).
  assert.equal(modelMatchesExpected('gpt-5.5', 'gpt-5.5'), true);
  assert.equal(modelMatchesExpected('opus', 'opus'), true);
  // Cursor reasoning/speed variants of the same family.
  assert.equal(modelMatchesExpected('gpt-5.5-medium', 'gpt-5.5'), true);
  assert.equal(modelMatchesExpected('gpt-5.5-fast', 'gpt-5.5'), true);
  assert.equal(modelMatchesExpected('claude-4.6-sonnet-thinking', 'claude-4.6-sonnet'), true);
  assert.equal(modelMatchesExpected('composer-latest-fast', 'composer-latest'), true);
  // The agent's natural Opus spawn matches the Opus-family expected (the highest tier).
  assert.equal(modelMatchesExpected('claude-opus-4-8-thinking-max-fast', 'claude-opus-4-8'), true);
  // A DIFFERENT family never matches (tier enforcement holds).
  assert.equal(modelMatchesExpected('claude-opus-4-8-thinking-max-fast', 'gpt-5.5'), false);
  assert.equal(modelMatchesExpected('sonnet', 'opus'), false);
  // Empty/absent or non-string never matches (deny → inherit guard).
  assert.equal(modelMatchesExpected('', 'gpt-5.5'), false);
  assert.equal(modelMatchesExpected('gpt-5.5', ''), false);
  assert.equal(modelMatchesExpected(undefined, 'gpt-5.5'), false);
});

test('canonicalHost defaults to claude for unknowns', () => {
  assert.equal(canonicalHost('codex'), 'codex');
  assert.equal(canonicalHost('weird'), 'claude');
});

test('tierModelTable returns all host columns', () => {
  assert.deepEqual(tierModelTable('highest'), {
    tier: 'highest', claude: 'opus', codex: 'gpt-5.5', cursor: 'claude-opus-4-8-thinking-high',
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

test('acceptableModelsFor: Cursor folds in same-tier fallbacks; claude/codex stay exact', () => {
  // Cursor Task-tool slugs per Cursor's own tier labels: balanced sonnet ↔ gpt-5.5 fallback.
  const balanced = acceptableModelsFor('claude-4.6-sonnet-medium-thinking', 'cursor');
  assert.equal(balanced[0], 'claude-4.6-sonnet-medium-thinking', 'preferred slug stays first');
  assert.ok(balanced.includes('gpt-5.5-medium'));
  // composer-2.5-fast is the LAST-RESORT fallback on highest+balanced (survives API-budget
  // exhaustion — the only model in the included Composer bucket), ordered last.
  assert.equal(balanced[balanced.length - 1], 'composer-2.5-fast', 'composer is the last-resort fallback');
  const highest = acceptableModelsFor('claude-opus-4-8-thinking-high', 'cursor');
  assert.ok(highest.includes('claude-fable-5-thinking-high'));
  assert.equal(highest[highest.length - 1], 'composer-2.5-fast', 'composer is the last-resort fallback');
  // cheapest has no configured fallback → just itself.
  assert.deepEqual(acceptableModelsFor('composer-2.5-fast', 'cursor'), ['composer-2.5-fast']);
  // claude/codex have no alternates → strict single-model enforcement preserved.
  assert.deepEqual(acceptableModelsFor('sonnet', 'claude'), ['sonnet']);
  assert.deepEqual(acceptableModelsFor('gpt-5.4', 'codex'), ['gpt-5.4']);
  // A model with no configured alternates → just itself, even on Cursor.
  assert.deepEqual(acceptableModelsFor('some-unknown-slug', 'cursor'), ['some-unknown-slug']);
  assert.deepEqual(acceptableModelsFor('', 'cursor'), []);
});

test('modelMatchesAny: the preferred slug or any same-tier fallback satisfies the set', () => {
  const balanced = acceptableModelsFor('claude-4.6-sonnet-medium-thinking', 'cursor');
  assert.equal(modelMatchesAny('claude-4.6-sonnet-medium-thinking', balanced), true); // preferred
  assert.equal(modelMatchesAny('gpt-5.5-medium', balanced), true); // the same-tier fallback
  // A different-tier Cursor model (opus = highest) does NOT satisfy balanced.
  assert.equal(modelMatchesAny('claude-opus-4-8-thinking-high', balanced), false);
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
