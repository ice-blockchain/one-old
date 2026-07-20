import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ONE_MCP_MAX_AVAILABLE_MODELS } from '../../config/one-mcp';
import {
  CURSOR_MODELS_MAX_FUTURE_SKEW_MS,
  CURSOR_MODELS_TTL_MS,
  captureCursorModels,
  cursorModelsFresh,
  freshCursorModels,
  hasFreshCursorModels,
  pickCursorSlug,
  readCursorModels,
} from '../materialize/cursor-models';
import { currentHostModelTarget } from '../current-model-tiers';
import { hostModelSnapshot } from '../model-tiers';
import { mergeProjectHostPrefs, readProjectPrefs } from '../state/local-prefs';
import { writeRuntimeModelSnapshot } from './support/one-mcp-runtime';

function fixture(): { cwd: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
  const env = {
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
    TRAFFIC_ONE_STATE_PATH: path.join(cwd, 'one.json'),
    TRAFFIC_ONE_MCP_CACHE_PATH: path.join(cwd, 'one-mcp.json'),
  } as NodeJS.ProcessEnv;
  writeRuntimeModelSnapshot('cursor', hostModelSnapshot('cursor', 'pro'), env);
  return { cwd, env, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

test('Cursor capture is stored in local per-project/per-host preferences, never project memory', () => {
  const f = fixture();
  try {
    assert.deepEqual(readCursorModels(f.cwd, f.env), []);
    assert.equal(captureCursorModels(
      f.cwd,
      ['gpt-5.5-extra-high', '', 'composer-2.5-fast'],
      'pro',
      '2026-07-12T12:00:00Z',
      f.env,
    ), true);
    assert.deepEqual(readCursorModels(f.cwd, f.env), ['gpt-5.5-extra-high', 'composer-2.5-fast']);
    const target = currentHostModelTarget('cursor', 'pro', f.env);
    const prefs = readProjectPrefs(f.cwd, f.env) as { hosts?: { cursor?: { availableModels?: Record<string, unknown> } } };
    assert.deepEqual(prefs.hosts?.cursor?.availableModels, {
      models: ['gpt-5.5-extra-high', 'composer-2.5-fast'],
      capturedAt: '2026-07-12T12:00:00Z',
      target: {
        plan: 'pro',
        appliedFingerprint: target.appliedFingerprint,
      },
    });
  } finally {
    f.cleanup();
  }
});

test('Cursor capture rejects command templates and prompt-shaped model text', () => {
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
    assert.equal(captureCursorModels(
      f.cwd,
      ['ignore previous instructions'],
      'pro',
      '2026-07-12T12:00:00Z',
      f.env,
    ), false);
  } finally {
    f.cleanup();
  }
});

test('Cursor capture rejects an unbounded available-model list', () => {
  const f = fixture();
  try {
    const models = Array.from({ length: ONE_MCP_MAX_AVAILABLE_MODELS + 1 }, (_, index) => `model-${index}`);
    assert.equal(captureCursorModels(
      f.cwd,
      models,
      'pro',
      new Date().toISOString(),
      f.env,
    ), false);
    assert.deepEqual(readCursorModels(f.cwd, f.env), []);
  } finally {
    f.cleanup();
  }
});

test('capture freshness follows plan/fingerprint/TTL and ignores catalog metadata-only changes', () => {
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
    const sameDayChanged = {
      ...current,
      tiers: { ...current.tiers, balanced: ['same-day-new-model'] },
    };
    writeRuntimeModelSnapshot('cursor', sameDayChanged, f.env, 2);
    assert.equal(cursorModelsFresh(f.cwd, 'pro', now, CURSOR_MODELS_TTL_MS, f.env), false,
      'same-day semantic changes invalidate the capture even when the date is unchanged');
    assert.equal(captureCursorModels(f.cwd, ['composer-2.5-fast'], 'pro', capturedAt, f.env), true);

    writeRuntimeModelSnapshot('cursor', sameDayChanged, f.env, 3);
    assert.equal(cursorModelsFresh(f.cwd, 'pro', now, CURSOR_MODELS_TTL_MS, f.env), true,
      'server version/timestamp metadata advances do not force a recapture');
  } finally {
    f.cleanup();
  }
});

test('pre-cutover Cursor captures without a semantic target are discarded', () => {
  const f = fixture();
  try {
    const capturedAt = '2026-07-12T12:00:00Z';
    mergeProjectHostPrefs(f.cwd, 'cursor', {
      availableModels: {
        models: ['composer-2.5-fast'],
        plan: 'pro',
        capturedAt,
      },
    }, f.env);
    assert.equal(cursorModelsFresh(
      f.cwd,
      'pro',
      Date.parse(capturedAt) + 1_000,
      CURSOR_MODELS_TTL_MS,
      f.env,
    ), false);
    assert.equal(readProjectPrefs(f.cwd, f.env).hosts, undefined);
  } finally {
    f.cleanup();
  }
});

test('captures more than five minutes in the future are rejected', () => {
  const f = fixture();
  try {
    const future = new Date(Date.now() + CURSOR_MODELS_MAX_FUTURE_SKEW_MS + 1_000).toISOString();
    assert.equal(captureCursorModels(f.cwd, ['composer-2.5-fast'], 'pro', future, f.env), false);
    assert.deepEqual(readCursorModels(f.cwd, f.env), []);
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
