import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ensureProjectLocalTrafficOneGitignore,
  globalTrafficOneDir,
  isGlobalTrafficOneWritable,
  openCodeStateHome,
  normalizeElectronEnvForTrafficOne,
  projectLocalMachinePath,
  projectLocalPrefsPath,
  resolveTrafficOneEnv,
  trafficOneEnvShellPrefix,
  usesProjectLocalTrafficOnePaths,
} from '../traffic-one-paths';

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

test('resolveTrafficOneEnv: OpenCode falls back to app-support state when ~/.traffic-one is blocked', () => {
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
    assert.equal(env.XDG_STATE_HOME, openCodeStateHome({ HOME: home }));
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
    assert.equal(globalTrafficOneDir(env), path.join(openCodeStateHome({ HOME: home }), 'traffic-one'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveTrafficOneEnv: OpenCode uses project-local paths only after global and app-support are blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-local-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.traffic-one'), 'not-a-directory', 'utf8');
  fs.mkdirSync(path.dirname(openCodeStateHome({ HOME: home })), { recursive: true });
  fs.writeFileSync(openCodeStateHome({ HOME: home }), 'not-a-directory', 'utf8');
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const env = resolveTrafficOneEnv(cwd, 'opencode', { HOME: '/sandbox/home' });
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, projectLocalPrefsPath(cwd));
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, projectLocalMachinePath(cwd));
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

test('resolveTrafficOneEnv: other hosts use global paths when writable', () => {
  const cwd = '/tmp/my-project';
  const env = resolveTrafficOneEnv(cwd, 'cursor', { HOME: os.homedir() });
  if (isGlobalTrafficOneWritable({ HOME: os.homedir() })) {
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, undefined);
  }
});

test('resolveTrafficOneEnv: falls back to project-local when global dir is unwritable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-paths-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const blockedHome = path.join(dir, 'blocked-home');
  fs.writeFileSync(blockedHome, 'not-a-directory', 'utf8');
  try {
    const env = resolveTrafficOneEnv(cwd, 'claude', { HOME: blockedHome });
    assert.equal(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, projectLocalPrefsPath(cwd));
    assert.equal(env.TRAFFIC_ONE_STATE_PATH, projectLocalMachinePath(cwd));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trafficOneEnvShellPrefix: OpenCode prefixes app-support XDG fallback when needed', () => {
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
    assert.match(prefix, /XDG_STATE_HOME=/);
    assert.doesNotMatch(prefix, /TRAFFIC_ONE_PROJECT_PREFS_PATH=/);
    assert.doesNotMatch(prefix, /TRAFFIC_ONE_STATE_PATH=/);
    assert.match(prefix, /'/, 'shell values are single-quoted');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trafficOneEnvShellPrefix includes project-local env when global is blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefix-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const blockedHome = path.join(dir, 'blocked-home');
  fs.writeFileSync(blockedHome, 'not-a-directory', 'utf8');
  const prevHome = process.env.HOME;
  process.env.HOME = blockedHome;
  try {
    const prefix = trafficOneEnvShellPrefix(cwd, 'claude');
    assert.match(prefix, /TRAFFIC_ONE_PROJECT_PREFS_PATH=/);
    assert.match(prefix, /TRAFFIC_ONE_STATE_PATH=/);
    assert.match(prefix, /preferences\.json/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureProjectLocalTrafficOneGitignore appends missing lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gitignore-'));
  try {
    ensureProjectLocalTrafficOneGitignore(dir);
    const text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.match(text, /\.traffic-one\/preferences\.json/);
    assert.match(text, /\.traffic-one\/machine\.json/);
    ensureProjectLocalTrafficOneGitignore(dir);
    const again = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.equal((again.match(/preferences\.json/g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usesProjectLocalTrafficOnePaths treats OpenCode default paths as global', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-uses-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(usesProjectLocalTrafficOnePaths('/x', 'opencode', resolveTrafficOneEnv('/x', 'opencode', { HOME: '/sandbox/home' })), false);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
