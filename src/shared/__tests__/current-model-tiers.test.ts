import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { hostModelSnapshot } from '../model-tiers';
import {
  currentAcceptableModels,
  currentHostModelSnapshot,
  currentModelForTier,
  currentModelsForTier,
  resolveTierFallback,
} from '../current-model-tiers';
import { writeOneHostSettings } from '../one-settings';

test('runtime model resolution uses the active local host snapshot preferred + fallbacks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-current-models-'));
  const env = { TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json') } as NodeJS.ProcessEnv;
  try {
    const snapshot = {
      ...hostModelSnapshot('codex', 'pro'),
      updatedAt: '2026-07-13',
      tiers: {
        highest: ['remote-high', 'remote-high-fallback'],
        balanced: ['remote-balanced', 'remote-balanced-fallback'],
        cheapest: ['remote-cheap'],
      },
    };
    writeOneHostSettings('codex', snapshot, env);
    assert.equal(currentModelForTier('balanced', 'codex', 'pro', env), 'remote-balanced');
    assert.deepEqual(currentModelsForTier('balanced', 'codex', 'pro', env), [
      'remote-balanced',
      'remote-balanced-fallback',
    ]);
    assert.deepEqual(currentAcceptableModels('remote-balanced', 'codex', 'pro', env), [
      'remote-balanced',
      'remote-balanced-fallback',
    ]);
    assert.deepEqual(currentHostModelSnapshot('codex', 'pro', env), snapshot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime ignores a stale local snapshot from a different plan and uses bundled plan data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-current-models-'));
  const env = { TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json') } as NodeJS.ProcessEnv;
  try {
    writeOneHostSettings('cursor', hostModelSnapshot('cursor', 'free'), env);
    assert.deepEqual(
      currentHostModelSnapshot('cursor', 'pro', env),
      hostModelSnapshot('cursor', 'pro'),
    );
    assert.deepEqual(currentAcceptableModels('composer-2.5', 'cursor', 'pro', env), ['composer-2.5', 'gpt-5.4-mini', 'gemini-3.5-flash', 'claude-4.5-haiku']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fallback resolution is anchored to the role tier and returns an exact captured slug', () => {
  const captured = [
    'gpt-5.6-terra-medium',
    'claude-opus-4-8-thinking-high',
    'gpt-5.5-medium',
    'composer-2.5-fast',
  ];
  const highest = resolveTierFallback({
    tier: 'highest',
    exhaustedModels: ['gpt-5.6-terra-medium', 'claude-fable-5-thinking-high'],
    capturedModels: captured,
  }, 'cursor', 'pro');
  assert.deepEqual(highest, {
    family: 'claude-opus-4-8',
    model: 'claude-opus-4-8-thinking-high',
  }, 'a failed balanced-family model cannot move a highest role into the balanced row');

  const balanced = resolveTierFallback({
    tier: 'balanced',
    exhaustedModels: ['gpt-5.6-terra-medium'],
    unavailableModels: ['claude-sonnet-5'],
    capturedModels: captured,
  }, 'cursor', 'pro');
  assert.deepEqual(balanced, { family: 'gpt-5.5', model: 'gpt-5.5-medium' });
});

test('fallback resolution skips uncaptured models and reports exhaustion without changing tiers', () => {
  assert.deepEqual(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels: ['gpt-5.6-terra-medium'],
    capturedModels: ['composer-2.5-fast'],
  }, 'cursor', 'pro'), { family: 'composer-2.5', model: 'composer-2.5-fast' });

  assert.equal(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels: ['gpt-5.6-terra-medium', 'composer-2.5-fast'],
    capturedModels: ['composer-2.5-fast'],
  }, 'cursor', 'pro'), null);
});

test('fallback resolution rejects a bare captured prefix and returns only a gate-compatible exact slug', () => {
  const exhaustedModels = [
    'gpt-5.6-terra-medium',
    'claude-sonnet-5-thinking',
    'gpt-5.5-medium',
  ];

  assert.equal(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels,
    capturedModels: ['claude-4.6'],
  }, 'cursor', 'pro'), null, 'a shorter captured prefix is not a runnable variant of the tier family');

  assert.deepEqual(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels,
    capturedModels: ['claude-4.6', 'claude-4.6-sonnet-thinking-high'],
  }, 'cursor', 'pro'), {
    family: 'claude-4.6-sonnet',
    model: 'claude-4.6-sonnet-thinking-high',
  });
});
