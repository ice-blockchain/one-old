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
