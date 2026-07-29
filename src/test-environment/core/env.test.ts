import { test } from 'node:test';
import assert from 'node:assert/strict';
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
