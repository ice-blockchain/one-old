import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { defaultConfig } from '../config/test-config';
import { buildCaseEnv, withCaseEnv } from './env';

test('case auth is pinned independently of ambient auth without MCP endpoint overrides', () => {
  const ambientAuth = process.env.TRAFFIC_ONE_AUTH;
  process.env.TRAFFIC_ONE_AUTH = 'on';

  try {
    const offConfig = defaultConfig();
    const offEnv = buildCaseEnv(offConfig, path.join(os.tmpdir(), 't1-env-off'), '', 'pure-node');

    assert.equal(offEnv.TRAFFIC_ONE_AUTH, 'off');
    withCaseEnv(offEnv, () => {
      assert.equal(process.env.TRAFFIC_ONE_AUTH, 'off');
    });
    assert.equal(process.env.TRAFFIC_ONE_AUTH, 'on', 'ambient auth is restored after the isolated case');

    const onConfig = defaultConfig();
    onConfig.auth = 'on';
    const onEnv = buildCaseEnv(onConfig, path.join(os.tmpdir(), 't1-env-on'), '', 'pure-node');

    assert.equal(onEnv.TRAFFIC_ONE_AUTH, 'on');
  } finally {
    if (ambientAuth === undefined) delete process.env.TRAFFIC_ONE_AUTH;
    else process.env.TRAFFIC_ONE_AUTH = ambientAuth;
  }
});

test('Codex E2E isolates its model sidecar through the standard state home', () => {
  const caseFolder = path.join(os.tmpdir(), 't1-env-codex-models');
  const env = buildCaseEnv(defaultConfig(), caseFolder, '', 'codex');
  assert.equal(env.XDG_STATE_HOME, path.join(caseFolder, 'xdg-state'));
});

// isolateStateHome (default true) must pin HOME/USERPROFILE to the case folder.
// documentedBinDir() is `$HOME/.traffic-one/bin`; leaving HOME as the developer
// home is how ensureRunnerShims used to write the real bin directory.
test('default isolateStateHome pins HOME and USERPROFILE to the case folder', () => {
  const caseFolder = path.join(os.tmpdir(), 't1-env-home-pin');
  const isolated = buildCaseEnv(defaultConfig(), caseFolder, '', 'pure-node');
  const caseHome = path.join(caseFolder, 'home');
  assert.equal(isolated.HOME, caseHome);
  assert.equal(isolated.USERPROFILE, caseHome);

  const unisolated = buildCaseEnv(
    { ...defaultConfig(), isolateStateHome: false },
    caseFolder,
    '',
    'pure-node',
  );
  // Off omits the keys rather than pointing them at the real home.
  assert.equal(unisolated.HOME, undefined);
  assert.equal(unisolated.USERPROFILE, undefined);
});

test('isolateStateHome forwards rustup and cargo homes when HOME is remapped', () => {
  const realHome = process.env.TRAFFIC_ONE_TEST_UNPINNED_HOME || os.homedir();
  const defaultCargo = path.join(realHome, '.cargo');
  const defaultRustup = path.join(realHome, '.rustup');
  const caseFolder = path.join(os.tmpdir(), 't1-env-rustup');
  const isolated = buildCaseEnv(defaultConfig(), caseFolder, '', 'pure-node');
  if (fs.existsSync(defaultCargo)) {
    assert.equal(isolated.CARGO_HOME, defaultCargo);
  }
  if (fs.existsSync(defaultRustup)) {
    assert.equal(isolated.RUSTUP_HOME, defaultRustup);
  }
  assert.notEqual(isolated.CARGO_HOME, path.join(caseFolder, 'home', '.cargo'));
  assert.notEqual(isolated.RUSTUP_HOME, path.join(caseFolder, 'home', '.rustup'));
});

test('isolateStateHome forwards a real Playwright browser cache when HOME is remapped', () => {
  const realHome = process.env.TRAFFIC_ONE_TEST_UNPINNED_HOME || os.homedir();
  const defaultCache = process.platform === 'win32'
    ? path.join(realHome, 'AppData', 'Local', 'ms-playwright')
    : process.platform === 'darwin'
      ? path.join(realHome, 'Library', 'Caches', 'ms-playwright')
      : path.join(realHome, '.cache', 'ms-playwright');
  const caseFolder = path.join(os.tmpdir(), 't1-env-pw-browsers');
  const isolated = buildCaseEnv(defaultConfig(), caseFolder, '', 'pure-node');
  if (fs.existsSync(defaultCache)) {
    assert.equal(isolated.PLAYWRIGHT_BROWSERS_PATH, defaultCache);
  }
  assert.notEqual(isolated.PLAYWRIGHT_BROWSERS_PATH, path.join(caseFolder, 'home'));
});

// The qa-evidence stack runner spawns `pytest`/`ruff` by bare name, so the
// runs-root venv is only reachable if it leads PATH. Prepended, never appended:
// an ambient interpreter of the wrong version must not win over the toolchain
// the runs root pins.
test('the runs-root venv leads PATH so bare-name check commands resolve to it', () => {
  const ambientPath = process.env.PATH;
  process.env.PATH = '/ambient/bin';

  try {
    const config = defaultConfig();
    config.runsRoot = path.join(os.tmpdir(), 't1-env-runs');
    const env = buildCaseEnv(config, path.join(os.tmpdir(), 't1-env-venv'), '', 'pure-node');

    assert.equal(
      env.PATH,
      [path.join(config.runsRoot, '.venv', 'bin'), '/ambient/bin'].join(path.delimiter),
    );
    withCaseEnv(env, () => {
      assert.equal(process.env.PATH, env.PATH);
    });
    assert.equal(process.env.PATH, '/ambient/bin', 'the ambient PATH is restored after the case');
  } finally {
    if (ambientPath === undefined) delete process.env.PATH;
    else process.env.PATH = ambientPath;
  }
});
