import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  authChoiceRequiredDenyReason,
  authEnforced,
  authGateForHook,
  parseTrafficOneApiKey,
  parseUnauthenticatedAuthChoice,
} from '../auth-gate';
import { AUTH_ENABLED } from '../../../config/auth';

// The gate is now a pure boolean read of the web-entered API key (the flat
// auth.json record beside one.json). A fresh entered key → authenticated
// true, no CLI spawn, no remote check. Mutates process.env because authGateForHook
// reads it directly; restored after.
function withFreshAuth<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authgate-'));
  const env = process.env;
  const prevState = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  const prevAuthFlag = env.TRAFFIC_ONE_AUTH;
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_AUTH = '1'; // these tests exercise the real authed path; pin enforcement on
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
  }), 'utf8');
  try {
    return fn(dir);
  } finally {
    if (prevState === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevState;
    if (prevAuthFlag === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevAuthFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('authGateForHook returns authenticated (no spawn) when the API key is entered', () => {
  withFreshAuth(() => {
    const gate = authGateForHook();
    assert.equal(gate.authenticated, true);
    assert.equal(gate.checkedRemote, false);
  });
});

test('authGateForHook returns unauthenticated when enforced but no key is entered', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authgate-none-'));
  const env = process.env;
  const prevState = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  const prevFlag = env.TRAFFIC_ONE_AUTH;
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'one.json'); // no file → no key
  env.TRAFFIC_ONE_AUTH = '1';
  try {
    assert.equal(authGateForHook().authenticated, false);
  } finally {
    if (prevState === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevState;
    if (prevFlag === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parse helpers + deny reason', () => {
  assert.equal(parseUnauthenticatedAuthChoice('1', { allowNumeric: true }), 'authenticate');
  assert.equal(parseUnauthenticatedAuthChoice('continue without traffic one'), 'continue-without-traffic-one');
  assert.equal(parseUnauthenticatedAuthChoice('build me an app'), null);
  assert.equal(parseTrafficOneApiKey('my key is abc12345'), 'abc12345');
  assert.equal(parseTrafficOneApiKey('hello world here'), null);
  assert.ok(authChoiceRequiredDenyReason().includes('Traffic One authentication choice required'));
});

test('authEnforced honors TRAFFIC_ONE_AUTH; falls back to the AUTH_ENABLED default', () => {
  assert.equal(authEnforced({ TRAFFIC_ONE_AUTH: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(authEnforced({ TRAFFIC_ONE_AUTH: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(authEnforced({ TRAFFIC_ONE_AUTH: 'off' } as NodeJS.ProcessEnv), false);
  assert.equal(authEnforced({ TRAFFIC_ONE_AUTH: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(authEnforced({} as NodeJS.ProcessEnv), AUTH_ENABLED);
});

test('authGateForHook bypasses (authenticated) when enforcement is disabled — no auth state needed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoff-'));
  const env = process.env;
  const prevFlag = env.TRAFFIC_ONE_AUTH;
  const prevState = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  env.TRAFFIC_ONE_AUTH = 'off';
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'nope.json'); // no file → unauthenticated
  try {
    const gate = authGateForHook();
    assert.equal(gate.authenticated, true);
    assert.equal(gate.checkedRemote, false);
  } finally {
    if (prevFlag === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevFlag;
    if (prevState === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
