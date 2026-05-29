import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalHost, canonicalTier, resolveModel, tierModelTable } from '../model-tiers';

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
  assert.equal(resolveModel('balanced', 'codex'), 'gpt-5');
  assert.equal(resolveModel('cheapest', 'cursor'), 'haiku');
  assert.equal(resolveModel('bad', 'claude'), null);
});

test('canonicalHost defaults to claude for unknowns', () => {
  assert.equal(canonicalHost('codex'), 'codex');
  assert.equal(canonicalHost('weird'), 'claude');
});

test('tierModelTable returns all host columns', () => {
  assert.deepEqual(tierModelTable('highest'), {
    tier: 'highest', claude: 'opus', codex: 'gpt-5-codex', cursor: 'opus',
  });
  assert.equal(tierModelTable('bad'), null);
});
