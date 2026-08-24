import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readOneSettings } from '../../one-settings';
import { initializeTrafficOneEnv } from '../runtime-env';
import { defaultProjectPrefsPath, readProjectPrefs } from '../local-prefs';
import { projectWritesPermitted, resetPluginUseCache } from '../plugin-use';

// DECLARED, not inherited. The fixture guard below asserts that the consent
// fence PERMITS deleting under the project's state dir, and that answer is
// whatever `TRAFFIC_ONE_ASK_USE_PLUGIN` says for a project with no recorded
// choice: under the shipped default (ASK_USE_PLUGIN_FIRST = true) it is `false`
// and the guard fails while blaming the wrong thing. These fixtures mean "a
// project the user already said yes to" and cannot record it — the canonical
// prefs root must NOT exist, which is the very refusal being characterized — so
// the value is pinned here instead of being taken from src/build/test-preload.mjs
// without saying so. Enforced by shared/__tests__/durable-writer-rule.test.ts.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

test('initializeTrafficOneEnv migrates completed project-local Cursor answers before deleting retired storage', () => {
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
        performance: {
          level: 'balanced', source: 'prompted',
          target: { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 },
        },
        team: { mode: 'subagents', source: 'prompted', approved: true },
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
    assert.deepEqual(cursor.performance, {
      level: 'balanced', source: 'prompted',
      target: { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 },
    });
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
    assert.equal(prefs.codeGraphAcknowledged, true,
      'a completed project-local prefs file without the key is grandfathered, not re-asked');

    assert.equal(fs.existsSync(path.join(stateDir, 'preferences.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'machine.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'onboarding')), false);
    assert.equal(fs.existsSync(path.join(stateDir, '.one.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('first canonical write from a legacy project-local prefs file grandfathers codeGraphAcknowledged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runtime-env-ack-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const stateDir = path.join(cwd, '.traffic-one');
  const env: NodeJS.ProcessEnv = { HOME: home };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'preferences.json'), JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-13T08:56:01Z' },
    pluginUse: { enabled: true, source: 'prompted', decidedAt: '2026-07-13T08:56:02Z' },
    hosts: {
      cursor: {
        performance: {
          level: 'low', source: 'prompted',
          target: { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 },
        },
        team: { mode: 'main-agent', source: 'prompted' },
      },
    },
  }), 'utf8');

  try {
    assert.equal(fs.existsSync(defaultProjectPrefsPath(cwd, env)), false,
      'fixture guard: no canonical prefs file — grandfather must come from the legacy source');
    initializeTrafficOneEnv(cwd, 'cursor', env);
    const prefs = readProjectPrefs(cwd, env);
    assert.equal(prefs.codeGraphAcknowledged, true);
    const onDisk = JSON.parse(fs.readFileSync(defaultProjectPrefsPath(cwd, env), 'utf8'));
    assert.equal(onDisk.codeGraphAcknowledged, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of the bridge, and the reason its `return true` mattered.
//
// The three steps used to run unconditionally: migrate prefs, migrate machine
// settings, DELETE the project-local copies, report success. `updateProjectPrefs`
// refuses to create a per-project prefs root for a directory that belongs to an
// enclosing project — silently, by returning the unchanged current prefs — so in
// that shape the merge did nothing and the delete still ran, destroying the only
// copy of the user's onboarding answers and reporting a completed migration.
//
// The asymmetry is what made it a defect rather than a risk: an EACCES already
// took the safe branch (the `catch` keeps the legacy copy for a later retry), and
// only the refusal nobody anticipated got the unsafe one.
test('a project-local copy the canonical store DECLINED to accept is never deleted', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-runtime-env-nested-')));
  // The nested shape from updateProjectPrefs' own comment: a directory that owns
  // no project of its own (no manifest, no VCS) inside a repository that does.
  const repo = path.join(base, 'repo');
  const cwd = path.join(repo, 'packages', 'api');
  const home = path.join(base, 'home');
  const env: NodeJS.ProcessEnv = { HOME: home };
  const stateDir = path.join(cwd, '.traffic-one');
  const legacyPrefs = path.join(stateDir, 'preferences.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"repo"}\n', 'utf8');
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: elsewhere\n', 'utf8');
  const answers = {
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-13T08:56:01Z' },
    pluginUse: { enabled: true, source: 'prompted', decidedAt: '2026-07-13T08:56:02Z' },
  };
  fs.writeFileSync(legacyPrefs, JSON.stringify(answers), 'utf8');

  try {
    resetPluginUseCache();
    // Fixture guards. Without the first, this test could pass because the CONSENT
    // fence refused the delete for an unrelated reason; without the second, it
    // could pass because there was no canonical store to decline anything.
    assert.equal(projectWritesPermitted(cwd), true,
      'fixture guard: deleting under this project state dir is permitted, so a surviving file means the ORDER saved it');
    assert.equal(fs.existsSync(defaultProjectPrefsPath(cwd, env)), false,
      'fixture guard: no canonical prefs root yet — which is exactly what updateProjectPrefs declines to create here');

    initializeTrafficOneEnv(cwd, 'cursor', env);

    // The merge really was declined: nothing of the legacy copy reached the
    // canonical store. (If this ever starts passing the migration, the assertion
    // below stops being about preservation and this row must be re-derived.)
    const canonical = readProjectPrefs(cwd, env);
    assert.equal(Object.prototype.hasOwnProperty.call(canonical, 'pluginUse'), false,
      'fixture guard: the canonical store did not accept the answers');

    assert.equal(fs.existsSync(legacyPrefs), true,
      'the ONLY copy of the onboarding answers must survive a migration that did not land');
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyPrefs, 'utf8')), answers,
      'and survive byte-for-byte, so a later process can still complete the bridge');
  } finally {
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
