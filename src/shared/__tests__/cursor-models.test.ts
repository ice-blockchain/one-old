import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CURSOR_MODELS_TTL_MS,
  LEGACY_CURSOR_MODELS_REL,
  captureCursorModels,
  cleanupLegacyCursorModels,
  cursorModelsCapturePrompted,
  cursorModelsFresh,
  freshCursorModels,
  hasFreshCursorModels,
  markCursorModelsCapturePrompted,
  pickCursorSlug,
  readCursorModels,
} from '../materialize/cursor-models';
import { hostModelSnapshot } from '../model-tiers';
import { readProjectPrefs } from '../state/local-prefs';
import { writeOneHostSettings } from '../one-settings';

function fixture(): { cwd: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const env = {
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
    TRAFFIC_ONE_STATE_PATH: path.join(cwd, 'one.json'),
  } as NodeJS.ProcessEnv;
  writeOneHostSettings('cursor', hostModelSnapshot('cursor', 'pro'), env);
  return { cwd, env, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test('Cursor capture is stored in local per-project/per-host preferences, never project memory', () => {
  const f = fixture();
  try {
    const catalogUpdatedAt = hostModelSnapshot('cursor', 'pro').updatedAt;
    assert.deepEqual(readCursorModels(f.cwd, f.env), []);
    assert.equal(captureCursorModels(
      f.cwd,
      ['  gpt-5.5-extra-high  ', '', 'composer-2.5-fast'],
      'pro',
      '2026-07-12T12:00:00Z',
      f.env,
    ), true);
    assert.deepEqual(readCursorModels(f.cwd, f.env), ['gpt-5.5-extra-high', 'composer-2.5-fast']);
    const prefs = readProjectPrefs(f.cwd, f.env) as { hosts?: { cursor?: { availableModels?: Record<string, unknown> } } };
    assert.deepEqual(prefs.hosts?.cursor?.availableModels, {
      models: ['gpt-5.5-extra-high', 'composer-2.5-fast'],
      plan: 'pro',
      modelsUpdatedAt: catalogUpdatedAt,
      capturedAt: '2026-07-12T12:00:00Z',
    });
    assert.equal(fs.existsSync(path.join(f.cwd, LEGACY_CURSOR_MODELS_REL)), false);
  } finally {
    f.cleanup();
  }
});

test('Cursor capture rejects an unedited command template', () => {
  const f = fixture();
  try {
    assert.equal(captureCursorModels(
      f.cwd,
      ['EXACT_MODEL_ID_1', 'EXACT_MODEL_ID_2', 'MORE_EXACT_MODEL_IDS'],
      'pro',
      '2026-07-12T12:00:00Z',
      f.env,
    ), false);
    assert.deepEqual(readCursorModels(f.cwd, f.env), []);
  } finally {
    f.cleanup();
  }
});

test('capture freshness invalidates on plan, catalog date, and seven-day TTL', () => {
  const f = fixture();
  try {
    const capturedAt = '2026-07-12T12:00:00Z';
    captureCursorModels(f.cwd, ['composer-2.5-fast'], 'pro', capturedAt, f.env);
    const now = Date.parse(capturedAt) + 1_000;
    assert.equal(cursorModelsFresh(f.cwd, 'pro', now, CURSOR_MODELS_TTL_MS, f.env), true);
    assert.equal(hasFreshCursorModels(f.cwd, 'pro', now, CURSOR_MODELS_TTL_MS, f.env), true);
    assert.equal(cursorModelsFresh(f.cwd, 'max', now, CURSOR_MODELS_TTL_MS, f.env), false);
    assert.deepEqual(freshCursorModels(f.cwd, 'max', now, CURSOR_MODELS_TTL_MS, f.env), []);
    assert.equal(cursorModelsFresh(f.cwd, 'pro', now + CURSOR_MODELS_TTL_MS + 1, CURSOR_MODELS_TTL_MS, f.env), false);

    const current = hostModelSnapshot('cursor', 'pro');
    const nextCatalogDate = new Date(Date.parse(`${current.updatedAt}T00:00:00Z`) + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    writeOneHostSettings('cursor', { ...current, updatedAt: nextCatalogDate }, f.env);
    assert.equal(cursorModelsFresh(f.cwd, 'pro', now, CURSOR_MODELS_TTL_MS, f.env), false);
  } finally {
    f.cleanup();
  }
});

test('legacy project capture is never imported and cleanup removes only the known Traffic One shape', () => {
  const f = fixture();
  try {
    const legacy = path.join(f.cwd, LEGACY_CURSOR_MODELS_REL);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ models: ['composer-2.5-fast'], plan: 'pro', capturedAt: '2026-07-12T00:00:00Z' }));
    assert.deepEqual(readCursorModels(f.cwd, f.env), [], 'legacy capture is not imported');
    assert.equal(cleanupLegacyCursorModels(f.cwd), true);
    assert.equal(fs.existsSync(legacy), false);

    fs.writeFileSync(legacy, JSON.stringify({ models: ['custom'], owner: 'user' }));
    assert.equal(cleanupLegacyCursorModels(f.cwd), false);
    assert.equal(fs.existsSync(legacy), true, 'unknown/user-authored shape is preserved');
  } finally {
    f.cleanup();
  }
});

test('pickCursorSlug is family-aware and preferred-first', () => {
  const build = ['claude-opus-4-8-thinking-max-fast', 'claude-fable-5-thinking-max', 'gpt-5.5-extra-high', 'composer-2.5-fast'];
  assert.equal(pickCursorSlug(['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'composer-2.5'], build), 'claude-opus-4-8-thinking-max-fast');
  assert.equal(pickCursorSlug(['claude-4.6-sonnet', 'gpt-5.5', 'composer-2.5'], build), 'gpt-5.5-extra-high');
  assert.equal(pickCursorSlug(['composer-2.5'], build), 'composer-2.5-fast');
  assert.equal(pickCursorSlug(['gemini-3'], build), null);
});

test('cursor-models capture once-marker remains run-scoped', () => {
  const f = fixture();
  try {
    assert.equal(cursorModelsCapturePrompted(f.cwd, 'r1'), false);
    markCursorModelsCapturePrompted(f.cwd, 'r1');
    assert.equal(cursorModelsCapturePrompted(f.cwd, 'r1'), true);
    assert.equal(cursorModelsCapturePrompted(f.cwd, 'r2'), false);
  } finally {
    f.cleanup();
  }
});
