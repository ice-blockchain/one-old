import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

import { defaultConfig } from '../config/test-config';
import { buildCaseEnv, withCaseEnv } from './env';

test('case auth is pinned off despite ambient auth and on uses the isolated dead endpoint', () => {
  const ambientAuth = process.env.TRAFFIC_ONE_AUTH;
  process.env.TRAFFIC_ONE_AUTH = 'on';

  try {
    const offConfig = defaultConfig();
    const offEnv = buildCaseEnv(offConfig, path.join(os.tmpdir(), 't1-env-off'), '', 'pure-node');

    assert.equal(offEnv.TRAFFIC_ONE_AUTH, 'off');
    assert.equal(Object.hasOwn(offEnv, 'TRAFFIC_ONE_MCP_KEY_ENDPOINT'), false);
    withCaseEnv(offEnv, () => {
      assert.equal(process.env.TRAFFIC_ONE_AUTH, 'off');
    });
    assert.equal(process.env.TRAFFIC_ONE_AUTH, 'on', 'ambient auth is restored after the isolated case');

    const onConfig = defaultConfig();
    onConfig.auth = 'on';
    const onEnv = buildCaseEnv(onConfig, path.join(os.tmpdir(), 't1-env-on'), '', 'pure-node');

    assert.equal(onEnv.TRAFFIC_ONE_AUTH, 'on');
    assert.equal(onEnv.TRAFFIC_ONE_MCP_KEY_ENDPOINT, 'http://127.0.0.1:8787/mcp');
  } finally {
    if (ambientAuth === undefined) delete process.env.TRAFFIC_ONE_AUTH;
    else process.env.TRAFFIC_ONE_AUTH = ambientAuth;
  }
});

test('Codex E2E pins its model sidecar and sync disable inside the case folder', () => {
  const caseFolder = path.join(os.tmpdir(), 't1-env-codex-models');
  const env = buildCaseEnv(defaultConfig(), caseFolder, '', 'codex');
  assert.equal(
    env.TRAFFIC_ONE_MCP_CACHE_PATH,
    path.join(caseFolder, 'state', 'one-mcp.json'),
  );
  assert.equal(env.TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC, '1');
});
