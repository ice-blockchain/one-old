import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readOneSettings } from '../../one-settings';
import { initializeTrafficOneEnv } from '../runtime-env';
import { defaultProjectPrefsPath, readProjectPrefs } from '../local-prefs';

test('initializeTrafficOneEnv migrates completed legacy Cursor answers before deleting project-local state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runtime-env-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const stateDir = path.join(cwd, '.traffic-one');
  const env: NodeJS.ProcessEnv = { HOME: home };
  fs.mkdirSync(path.join(stateDir, 'onboarding', 'cursor'), { recursive: true });
  fs.mkdirSync(path.dirname(defaultProjectPrefsPath(cwd, env)), { recursive: true });

  fs.writeFileSync(defaultProjectPrefsPath(cwd, env), JSON.stringify({
    toolchain: { gitnexus: { installedVersion: '1.6.9' } },
  }), 'utf8');
  fs.writeFileSync(path.join(stateDir, 'preferences.json'), JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-13T08:56:01Z' },
    pluginUse: { enabled: true, source: 'prompted', decidedAt: '2026-07-13T08:56:02Z' },
    retiredJunk: { mustNotMigrate: true },
    hosts: {
      cursor: {
        performance: { level: 'balanced', source: 'prompted' },
        team: { mode: 'subagents', source: 'prompted', approved: true },
        configuredFor: { plan: 'pro', modelsUpdatedAt: '2026-07-13' },
      },
    },
  }), 'utf8');
  fs.writeFileSync(path.join(stateDir, 'machine.json'), JSON.stringify({
    schemaVersion: 3,
    codeGraphProvider: 'gitnexus',
  }), 'utf8');
  fs.writeFileSync(path.join(stateDir, 'onboarding', 'cursor', 'server.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(stateDir, '.one.json'), JSON.stringify({ onboardingComplete: true }), 'utf8');

  try {
    initializeTrafficOneEnv(cwd, 'cursor', env);

    const prefs = readProjectPrefs(cwd, env);
    const cursor = (prefs.hosts as Record<string, Record<string, unknown>>).cursor;
    assert.ok(cursor);
    assert.deepEqual(cursor.performance, { level: 'balanced', source: 'prompted' });
    assert.deepEqual(cursor.team, { mode: 'subagents', source: 'prompted', approved: true });
    const gitnexus = (prefs.toolchain as Record<string, Record<string, unknown>>).gitnexus;
    assert.ok(gitnexus);
    assert.equal(gitnexus.installedVersion, '1.6.9');
    assert.deepEqual(prefs.pluginUse, {
      enabled: true,
      source: 'prompted',
      decidedAt: '2026-07-13T08:56:02Z',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(prefs, 'retiredJunk'), false);

    const machine = readOneSettings(env);
    assert.equal(machine.codeGraphProvider, 'gitnexus');

    assert.equal(fs.existsSync(path.join(stateDir, 'preferences.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'machine.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'onboarding')), false);
    assert.equal(fs.existsSync(path.join(stateDir, '.one.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
