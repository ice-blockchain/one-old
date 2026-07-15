import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  globalTrafficOneDir,
  normalizeElectronEnvForTrafficOne,
  projectLocalMachinePath,
  projectLocalPrefsPath,
  removeLegacyProjectLocalTrafficOneRuntime,
  removeStrayProjectArtifactsFromGlobalDir,
  resolveTrafficOneEnv,
  trafficOneEnvShellPrefix,
} from '../traffic-one-paths';
import { sha256 } from '../../text';

test('removeStrayProjectArtifactsFromGlobalDir purges project artifacts, keeps machine state', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stray-'));
  try {
    const home = path.join(base, 'home');
    const dir = path.join(home, '.traffic-one');
    // Stray project artifacts (materialized by the pre-guard $HOME-session bug).
    fs.mkdirSync(path.join(dir, 'rules', 'common'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'skills', 'refactor'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.one.json'), '{"mode":"existing-codebase"}', 'utf8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'plan.md'), 'plan', 'utf8');
    // Machine-owned entries that must survive.
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'toolchains'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'one.json'), '{"schemaVersion":3}', 'utf8');
    fs.writeFileSync(path.join(dir, 'windsurf-plugin-root'), 'x', 'utf8');
    // The bogus "$HOME project" prefs bucket vs a real project's bucket.
    const homeHash = sha256(path.resolve(home));
    fs.mkdirSync(path.join(dir, 'projects', homeHash, 'onboarding', 'claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'projects', 'a-real-project-hash'), { recursive: true });

    removeStrayProjectArtifactsFromGlobalDir({ HOME: home } as NodeJS.ProcessEnv);

    for (const gone of ['.one.json', 'manifest.json', 'rules', 'skills', 'plan.md']) {
      assert.equal(fs.existsSync(path.join(dir, gone)), false, `${gone} purged`);
    }
    for (const kept of ['one.json', 'bin', 'toolchains', 'windsurf-plugin-root']) {
      assert.equal(fs.existsSync(path.join(dir, kept)), true, `${kept} kept`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'projects', homeHash)), false, 'home-project prefs purged');
    assert.equal(fs.existsSync(path.join(dir, 'projects', 'a-real-project-hash')), true, 'real project prefs kept');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveTrafficOneEnv: OpenCode uses ~/.traffic-one by default when writable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-home-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const env = resolveTrafficOneEnv(cwd, 'opencode', { HOME: '/sandbox/home' });
    assert.equal(env.HOME, home);
    assert.equal(env.XDG_STATE_HOME, undefined);
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
    assert.equal(globalTrafficOneDir(env), path.join(home, '.traffic-one'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTrafficOneEnv: OpenCode never redirects user state when ~/.traffic-one is blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-app-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.traffic-one'), 'not-a-directory', 'utf8');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const env = resolveTrafficOneEnv(cwd, 'opencode', { HOME: '/sandbox/home' });
    assert.equal(env.HOME, home);
    assert.equal(env.XDG_STATE_HOME, undefined);
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
    assert.equal(globalTrafficOneDir(env), path.join(home, '.traffic-one'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTrafficOneEnv: OpenCode never falls back to project-local state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-local-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.traffic-one'), 'not-a-directory', 'utf8');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const env = resolveTrafficOneEnv(cwd, 'opencode', { HOME: '/sandbox/home' });
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
    assert.equal(globalTrafficOneDir(env), path.join(home, '.traffic-one'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTrafficOneEnv: explicit overrides are preserved for every host', () => {
  const cwd = '/tmp/my-project';
  const base = {
    HOME: '/sandbox/home',
    XDG_STATE_HOME: '/sandbox/state',
    TRAFFIC_ONE_PROJECT_PREFS_PATH: '/custom/preferences.json',
    TRAFFIC_ONE_STATE_PATH: '/custom/one.json',
  };
  for (const host of ['opencode', 'cursor', 'codex', 'claude'] as const) {
    const env = resolveTrafficOneEnv(cwd, host, base);
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, '/custom/preferences.json', host);
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, '/custom/one.json', host);
  }
});

test('resolveTrafficOneEnv: stale project-local overrides are discarded', () => {
  const cwd = '/tmp/my-project';
  const env = resolveTrafficOneEnv(cwd, 'codex', {
    HOME: '/Users/example',
    TRAFFIC_ONE_PROJECT_PREFS_PATH: projectLocalPrefsPath(cwd),
    TRAFFIC_ONE_STATE_PATH: projectLocalMachinePath(cwd),
  });
  assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
  assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
  assert.equal(globalTrafficOneDir(env), '/Users/example/.traffic-one');
});

test('legacy cleanup removes forbidden project-local runtime state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-local-cleanup-'));
  const cwd = path.join(dir, 'project');
  const stateDir = path.join(cwd, '.traffic-one');
  const prefs = projectLocalPrefsPath(cwd);
  const machine = projectLocalMachinePath(cwd);
  const onboarding = path.join(stateDir, 'onboarding', 'codex');
  fs.mkdirSync(onboarding, { recursive: true });
  fs.writeFileSync(prefs, '{}\n', 'utf8');
  fs.writeFileSync(machine, '{}\n', 'utf8');
  fs.writeFileSync(path.join(onboarding, 'server.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(stateDir, '.one.json'), '{"mode":"new-project"}\n', 'utf8');
  try {
    removeLegacyProjectLocalTrafficOneRuntime(cwd);
    assert.equal(fs.existsSync(prefs), false);
    assert.equal(fs.existsSync(machine), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'onboarding')), false);
    assert.equal(fs.existsSync(path.join(stateDir, '.one.json')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeElectronEnvForTrafficOne: pins real HOME and removes sandbox XDG state', () => {
  const prevHome = process.env.HOME;
  process.env.HOME = '/real/home';
  const env = normalizeElectronEnvForTrafficOne({
    HOME: '/sandbox/home',
    XDG_STATE_HOME: '/sandbox/state',
    TRAFFIC_ONE_PROJECT_PREFS_PATH: '/proj/.traffic-one/preferences.json',
    TRAFFIC_ONE_STATE_PATH: '/proj/.traffic-one/machine.json',
  }, 'opencode');
  assert.equal(env.HOME, '/real/home');
  assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, '/proj/.traffic-one/preferences.json');
  assert.equal(env.TRAFFIC_ONE_STATE_PATH, '/proj/.traffic-one/machine.json');
  assert.equal(env.XDG_STATE_HOME, undefined);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

test('resolveTrafficOneEnv: other hosts always use global paths', () => {
  const cwd = '/tmp/my-project';
  const env = resolveTrafficOneEnv(cwd, 'cursor', { HOME: os.homedir() });
  assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
  assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
});

test('resolveTrafficOneEnv: an unwritable home never enables project-local state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-paths-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const blockedHome = path.join(dir, 'blocked-home');
  fs.writeFileSync(blockedHome, 'not-a-directory', 'utf8');
  try {
    const env = resolveTrafficOneEnv(cwd, 'claude', { HOME: blockedHome });
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
    assert.equal(globalTrafficOneDir(env), path.join(blockedHome, '.traffic-one'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trafficOneEnvShellPrefix: OpenCode does not redirect state when its home is blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-prefix-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.traffic-one'), 'not-a-directory', 'utf8');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const prevXdg = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  try {
    const prefix = trafficOneEnvShellPrefix('/tmp/proj', 'opencode');
    assert.doesNotMatch(prefix, /TRAFFIC_ONE_PROJECT_PREFS_PATH=/);
    assert.doesNotMatch(prefix, /TRAFFIC_ONE_STATE_PATH=/);
    assert.equal(prefix, '');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trafficOneEnvShellPrefix never includes project-local state paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefix-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const blockedHome = path.join(dir, 'blocked-home');
  fs.writeFileSync(blockedHome, 'not-a-directory', 'utf8');
  const prevHome = process.env.HOME;
  process.env.HOME = blockedHome;
  try {
    const prefix = trafficOneEnvShellPrefix(cwd, 'claude');
    assert.doesNotMatch(prefix, /TRAFFIC_ONE_PROJECT_PREFS_PATH=/);
    assert.doesNotMatch(prefix, /TRAFFIC_ONE_STATE_PATH=/);
    assert.equal(prefix, '');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
