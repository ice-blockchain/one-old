import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildCursorSpawnModelMap,
  formatCursorSpawnMapBlock,
  isBareCursorTierFamily,
  resolveCursorTierSlug,
  syncCursorSpawnAgentFiles,
} from '../cursor-spawn-map';
import { readEffectiveState } from '../../state';

function withProj(fn: (dir: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-spawnmap-')));
  const env = process.env;
  const pp = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const pl = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', approved: true },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true,
  }), 'utf8');
  try { fn(dir); } finally {
    if (pp === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = pp;
    if (pl === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = pl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveCursorTierSlug maps family anchor to captured build slug', () => {
  withProj((dir) => {
    fs.writeFileSync(path.join(dir, '.traffic-one', 'cursor-models.json'), JSON.stringify({
      models: ['claude-opus-4-8-thinking-medium', 'composer-2.5-fast'],
      plan: 'pro',
      capturedAt: new Date().toISOString(),
    }), 'utf8');
    assert.equal(resolveCursorTierSlug(dir, 'claude-opus-4-8', 'pro'), 'claude-opus-4-8-thinking-medium');
  });
});

test('isBareCursorTierFamily distinguishes family anchor from build slug', () => {
  assert.equal(isBareCursorTierFamily('claude-opus-4-8', 'claude-opus-4-8'), true);
  assert.equal(isBareCursorTierFamily('claude-opus-4-8-thinking-medium', 'claude-opus-4-8'), false);
  assert.equal(isBareCursorTierFamily('composer-2.5', 'composer-2.5'), true);
});

test('buildCursorSpawnModelMap + syncCursorSpawnAgentFiles pin exact slugs in agent files', () => {
  withProj((dir) => {
    fs.writeFileSync(path.join(dir, '.traffic-one', 'cursor-models.json'), JSON.stringify({
      models: ['claude-opus-4-8-thinking-medium', 'composer-2.5-fast'],
      plan: 'pro',
      capturedAt: new Date().toISOString(),
    }), 'utf8');
    const state = readEffectiveState(dir) as Record<string, unknown>;
    const map = buildCursorSpawnModelMap(dir, state);
    assert.equal(map['senior-architect'], 'claude-opus-4-8-thinking-medium');
    assert.ok(formatCursorSpawnMapBlock(map).includes('senior-architect → claude-opus-4-8-thinking-medium'));

    syncCursorSpawnAgentFiles(dir, state);
    const architect = fs.readFileSync(path.join(dir, '.cursor', 'agents', 'senior-architect.md'), 'utf8');
    assert.match(architect, /^model: claude-opus-4-8-thinking-medium$/m);
    assert.doesNotMatch(architect, /^model: claude-opus-4-8$/m);
  });
});
