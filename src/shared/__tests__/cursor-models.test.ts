import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CURSOR_MODELS_TTL_MS,
  cursorModelsCapturePrompted,
  cursorModelsFresh,
  freshCursorModels,
  hasFreshCursorModels,
  markCursorModelsCapturePrompted,
  pickCursorSlug,
  readCursorModels,
  stampCursorModels,
} from '../materialize/cursor-models';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
}
function writeModels(cwd: string, models: unknown, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'), JSON.stringify({ models, ...extra }), 'utf8');
}

test('readCursorModels: missing → []; malformed → []; valid trims + filters', () => {
  const cwd = tmp();
  try {
    assert.deepEqual(readCursorModels(cwd), []);
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'), '{ not json', 'utf8');
    assert.deepEqual(readCursorModels(cwd), []);
    writeModels(cwd, ['  gpt-5.5-extra-high  ', '', 42, 'composer-2.5-fast']);
    assert.deepEqual(readCursorModels(cwd), ['gpt-5.5-extra-high', 'composer-2.5-fast']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('cursorModelsFresh: self-heals on plan change + TTL; unstamped is fresh (just captured)', () => {
  const cwd = tmp();
  try {
    // No file → not fresh.
    assert.equal(cursorModelsFresh(cwd, 'pro'), false);
    // Agent wrote raw models, not yet stamped → treated as FRESH (just captured this moment).
    writeModels(cwd, ['claude-opus-4-8-thinking-high', 'composer-2.5-fast']);
    assert.equal(cursorModelsFresh(cwd, 'max'), true, 'unstamped capture is fresh');
    assert.equal(hasFreshCursorModels(cwd, 'max'), true);

    // Stamp it under plan "pro" → fresh for pro, STALE for max/business (plan changed).
    assert.equal(stampCursorModels(cwd, 'pro', new Date().toISOString()), true);
    assert.equal(cursorModelsFresh(cwd, 'pro'), true, 'same plan → fresh');
    assert.equal(cursorModelsFresh(cwd, 'max'), false, 'plan upgraded (pro→max) → stale → re-capture');
    assert.equal(cursorModelsFresh(cwd, 'business'), false, 'plan changed → stale');
    assert.deepEqual(freshCursorModels(cwd, 'max'), [], 'stale → consumers get [] (fall back to family)');
    assert.equal(freshCursorModels(cwd, 'pro').length, 2, 'fresh → models returned');

    // TTL: an old capturedAt (same plan) is stale.
    const old = new Date(Date.now() - CURSOR_MODELS_TTL_MS - 1000).toISOString();
    assert.equal(stampCursorModels(cwd, 'pro', old), true);
    assert.equal(cursorModelsFresh(cwd, 'pro'), false, 'expired TTL → stale even on same plan');
    // Explicit nowMs/ttlMs args honored.
    assert.equal(cursorModelsFresh(cwd, 'pro', Date.parse(old) + 1000, CURSOR_MODELS_TTL_MS), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('stampCursorModels: no-op without models; preserves models + adds plan/capturedAt', () => {
  const cwd = tmp();
  try {
    assert.equal(stampCursorModels(cwd, 'pro', new Date().toISOString()), false, 'no file → no-op');
    writeModels(cwd, ['composer-2.5-fast']);
    assert.equal(stampCursorModels(cwd, 'pro', '2026-06-20T00:00:00Z'), true);
    const raw = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'cursor-models.json'), 'utf8'));
    assert.deepEqual(raw.models, ['composer-2.5-fast']);
    assert.equal(raw.plan, 'pro');
    assert.equal(raw.capturedAt, '2026-06-20T00:00:00Z');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('pickCursorSlug: family-aware, preferred-first, composer floor, null when nothing fits', () => {
  // Screenshot-style higher-plan build: opus-4-8 present with a -thinking-max-fast suffix.
  const build = ['claude-opus-4-8-thinking-max-fast', 'claude-fable-5-thinking-max', 'gpt-5.5-extra-high', 'composer-2.5-fast'];
  // highest chain (claude-opus-4-8 → opus-4-7 → fable → composer): picks the opus-4-8 variant.
  assert.equal(pickCursorSlug(['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'composer-2.5'], build), 'claude-opus-4-8-thinking-max-fast');
  // balanced chain (claude-4.6-sonnet → gpt-5.5 → composer): no sonnet → falls to gpt-5.5 variant.
  assert.equal(pickCursorSlug(['claude-4.6-sonnet', 'gpt-5.5', 'composer-2.5'], build), 'gpt-5.5-extra-high');
  // composer is the universal floor.
  assert.equal(pickCursorSlug(['composer-2.5'], build), 'composer-2.5-fast');
  // Nothing in the chain offered → null.
  assert.equal(pickCursorSlug(['gemini-3'], build), null);
  assert.equal(pickCursorSlug([], build), null);
});

test('cursor-models capture once-marker is run-scoped and no-ops on empty runId', () => {
  const cwd = tmp();
  try {
    assert.equal(cursorModelsCapturePrompted(cwd, 'r1'), false);
    markCursorModelsCapturePrompted(cwd, 'r1');
    assert.equal(cursorModelsCapturePrompted(cwd, 'r1'), true);
    assert.equal(cursorModelsCapturePrompted(cwd, 'r2'), false);
    markCursorModelsCapturePrompted(cwd, '');
    assert.equal(cursorModelsCapturePrompted(cwd, ''), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
