import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  FRESHNESS_REASON,
  authRemoteCheckDue,
  authStateFreshness,
  endpointFromEnv,
  isAuthenticatedLocal,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
} from '../index';

const ENDPOINT = 'http://127.0.0.1:8787/mcp';
function freshState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    endpoint: ENDPOINT,
    sessionToken: 'tok_abc.sig',
    expiresAt: '2099-01-01T00:00:00Z',
    lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
    ...over,
  };
}

test('authStateFreshness reports the precise reason', () => {
  assert.equal(authStateFreshness(null, {}).reason, FRESHNESS_REASON.MISSING);
  assert.equal(authStateFreshness(freshState({ version: 2 }), {}).reason, FRESHNESS_REASON.VERSION_MISMATCH);
  assert.equal(authStateFreshness(freshState({ sessionToken: 'nope' }), {}).reason, FRESHNESS_REASON.MALFORMED_TOKEN);
  assert.equal(authStateFreshness(freshState({ expiresAt: 123 }), {}).reason, FRESHNESS_REASON.MALFORMED_EXPIRY);
  assert.equal(authStateFreshness(freshState({ endpoint: 'https://other/mcp' }), {}).reason, FRESHNESS_REASON.ENDPOINT_MISMATCH);
  assert.equal(authStateFreshness(freshState({ expiresAt: '2000-01-01T00:00:00Z' }), {}).reason, FRESHNESS_REASON.EXPIRED);
  const ok = authStateFreshness(freshState(), {});
  assert.equal(ok.reason, FRESHNESS_REASON.OK);
  assert.equal(ok.fresh, true);
});

test('endpointFromEnv: default + override', () => {
  assert.equal(endpointFromEnv({}), 'http://127.0.0.1:8787/mcp');
  assert.equal(endpointFromEnv({ TRAFFIC_ONE_MCP_KEY_ENDPOINT: 'https://x/mcp' }), 'https://x/mcp');
});

test('isAuthenticatedLocal reads the state file (no network)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-auth-'));
  try {
    const statePath = path.join(dir, 'auth.json');
    const env = { TRAFFIC_ONE_AUTH_STATE_PATH: statePath } as NodeJS.ProcessEnv;
    fs.writeFileSync(statePath, JSON.stringify(freshState()), 'utf8');
    assert.equal(isAuthenticatedLocal(env), true);
    fs.writeFileSync(statePath, JSON.stringify(freshState({ expiresAt: '2000-01-01T00:00:00Z' })), 'utf8');
    assert.equal(isAuthenticatedLocal(env), false);
    assert.equal(isAuthenticatedLocal({ TRAFFIC_ONE_AUTH_STATE_PATH: path.join(dir, 'nope.json') } as NodeJS.ProcessEnv), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('authRemoteCheckDue: fresh + stale check → due; recent → not; not-fresh → false', () => {
  assert.equal(authRemoteCheckDue(freshState({ lastRemoteCheckedAt: '2000-01-01T00:00:00Z' }), {}), true);
  assert.equal(authRemoteCheckDue(freshState({ lastRemoteCheckedAt: new Date().toISOString() }), {}), false);
  assert.equal(authRemoteCheckDue(null, {}), false);
});

test('command detectors match the auth + doctor scripts', () => {
  assert.equal(isTrafficOneAuthCommand('node scripts/traffic-one-auth.cjs status'), true);
  assert.equal(isTrafficOneAuthCommand('node scripts/traffic-one-auth.cjs'), false);
  assert.equal(isTrafficOneAuthCommand('ls -la'), false);
  assert.equal(isTrafficOneDoctorCommand('node scripts/doctor.cjs --session x'), true);
});
