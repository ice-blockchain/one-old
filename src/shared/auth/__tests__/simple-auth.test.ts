import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { clearAuthentication, isLocallyAuthenticated, readSimpleAuth, simpleAuthPath, writeSimpleAuth } from '../simple-auth';

// Isolate the settings dir to a temp folder via the one.json override — auth.json
// derives its directory from it, so writes never touch the real ~/.traffic-one.
function withStateDir<T>(fn: (env: NodeJS.ProcessEnv, dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-simpleauth-'));
  const env = { TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json') } as NodeJS.ProcessEnv;
  try {
    return fn(env, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('auth.json lives beside one.json, not inside it', () => {
  withStateDir((env, dir) => {
    assert.equal(simpleAuthPath(env), path.join(dir, 'auth.json'));
  });
});

test('no file → unauthenticated, null read', () => {
  withStateDir((env) => {
    assert.equal(isLocallyAuthenticated(env), false);
    assert.equal(readSimpleAuth(env), null);
  });
});

test('writeSimpleAuth stores the key + marks authenticated', () => {
  withStateDir((env, dir) => {
    writeSimpleAuth('sk-telemetry-abc', env);
    const auth = readSimpleAuth(env);
    assert.equal(auth?.authenticated, true);
    assert.equal(auth?.apiKey, 'sk-telemetry-abc');
    assert.ok(auth?.updatedAt);
    assert.equal(isLocallyAuthenticated(env), true);
    // 0o600 on the auth file — the key is plaintext-at-rest.
    assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
  });
});

test('entering the key never creates the cross-project one.json', () => {
  withStateDir((env, dir) => {
    writeSimpleAuth('sk-telemetry-abc', env);
    assert.equal(fs.existsSync(path.join(dir, 'one.json')), false);
  });
});

test('clearAuthentication flips authenticated false but preserves the key', () => {
  withStateDir((env) => {
    writeSimpleAuth('sk-telemetry-abc', env);
    clearAuthentication(env);
    const auth = readSimpleAuth(env);
    assert.equal(auth?.authenticated, false);
    assert.equal(auth?.apiKey, 'sk-telemetry-abc'); // preserved for prefill
    assert.equal(isLocallyAuthenticated(env), false);
  });
});

test('a retired one.json auth section reads as unauthenticated (clean cutover)', () => {
  withStateDir((env, dir) => {
    // The old model stored auth as a one.json section; the new model never reads it.
    fs.writeFileSync(path.join(dir, 'one.json'), JSON.stringify({
      version: 1,
      auth: { authenticated: true, apiKey: 'sk-old', sessionToken: 'tok_x.sig' },
    }), 'utf8');
    assert.equal(isLocallyAuthenticated(env), false);
  });
});
