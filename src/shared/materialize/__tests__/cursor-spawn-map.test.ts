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
import { captureCursorModels } from '../cursor-models';
import { readEffectiveState } from '../../state';
import { currentHostModelTarget } from '../../current-model-tiers';
import { ensureRunModelPolicy } from '../../run-model-policy';

function withProj(fn: (dir: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-spawnmap-')));
  const env = process.env;
  const pp = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const sp = env.TRAFFIC_ONE_STATE_PATH;
  const pl = env.TRAFFIC_ONE_USER_PLAN;
  const ph = env.TRAFFIC_ONE_HOST;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  env.TRAFFIC_ONE_HOST = 'cursor';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    hosts: {
      cursor: {
        performance: {
          level: 'high', source: 'prompted',
          target: { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 },
        },
        team: { mode: 'subagents', source: 'prompted', approved: true },
      },
    },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true,
  }), 'utf8');
  try { fn(dir); } finally {
    if (pp === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = pp;
    if (sp === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = sp;
    if (pl === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = pl;
    if (ph === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = ph;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveCursorTierSlug maps family anchor to captured build slug', () => {
  withProj((dir) => {
    assert.equal(captureCursorModels(
      dir,
      ['claude-opus-4-8-thinking-medium', 'composer-2.5-fast'],
      'pro',
      new Date().toISOString(),
    ), true);
    assert.equal(resolveCursorTierSlug(dir, 'claude-opus-4-8', 'pro'), 'claude-opus-4-8-thinking-medium');
  });
});

test('isBareCursorTierFamily distinguishes family anchor from build slug', () => {
  assert.equal(isBareCursorTierFamily('claude-opus-4-8', 'claude-opus-4-8'), true);
  assert.equal(isBareCursorTierFamily('claude-opus-4-8-thinking-medium', 'claude-opus-4-8'), false);
  assert.equal(isBareCursorTierFamily('composer-2.5', 'composer-2.5'), true);
});

test('buildCursorSpawnModelMap resolves exact slugs without persisting them in agent files', () => {
  withProj((dir) => {
    assert.equal(captureCursorModels(
      dir,
      ['claude-opus-4-8-thinking-medium', 'composer-2.5-fast'],
      'pro',
      new Date().toISOString(),
    ), true);
    const state = readEffectiveState(dir) as Record<string, unknown>;
    const map = buildCursorSpawnModelMap(dir, state);
    assert.equal(map['senior-architect'], 'claude-opus-4-8-thinking-medium');
    assert.ok(formatCursorSpawnMapBlock(map).includes('senior-architect → claude-opus-4-8-thinking-medium'));

    syncCursorSpawnAgentFiles(dir, state);
    const architect = fs.readFileSync(path.join(dir, '.cursor', 'agents', 'senior-architect.md'), 'utf8');
    assert.doesNotMatch(architect, /^model:/m);
  });
});

test('buildCursorSpawnModelMap ignores a later project availableModels mutation for an active run policy', () => {
  withProj((dir) => {
    const target = currentHostModelTarget('cursor', 'pro');
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')) as {
      hosts: { cursor: { performance: Record<string, unknown> } };
    };
    prefs.hosts.cursor.performance.target = {
      plan: 'pro', appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion,
    };
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    assert.equal(captureCursorModels(
      dir,
      ['claude-opus-4-8-thinking-medium', 'composer-2.5-fast'],
      'pro',
      new Date().toISOString(),
    ), true);
    const onePath = path.join(dir, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8')) as Record<string, unknown>;
    one.currentRunId = 'frozen-map';
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    const state = readEffectiveState(dir) as Record<string, unknown>;
    assert.ok(ensureRunModelPolicy(dir, 'frozen-map', 'cursor', state));
    const first = buildCursorSpawnModelMap(dir, state);
    assert.equal(first['senior-architect'], 'claude-opus-4-8-thinking-medium');

    assert.equal(captureCursorModels(
      dir,
      ['gpt-5.6-sol-new-build', 'composer-2.5-new-build'],
      'pro',
      new Date().toISOString(),
    ), true);
    const afterMutation = buildCursorSpawnModelMap(dir, readEffectiveState(dir) as Record<string, unknown>);
    assert.deepEqual(afterMutation, first);
  });
});
