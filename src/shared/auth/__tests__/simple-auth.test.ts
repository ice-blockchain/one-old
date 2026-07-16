import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { hostModelSnapshot } from '../../model-tiers';
import { readOneSettings, writeOneSection } from '../../one-settings';
import { clearAuthentication, isLocallyAuthenticated, readSimpleAuth, writeSimpleAuth } from '../simple-auth';

function withStore<T>(fn: (env: NodeJS.ProcessEnv, dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-simpleauth-'));
  const env = { TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json') } as NodeJS.ProcessEnv;
  try {
    return fn(env, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validAuth(apiKey: string): Record<string, unknown> {
  return {
    version: 1,
    authenticated: true,
    apiKey,
    updatedAt: '2026-07-15T00:00:00Z',
  };
}

test('missing one.json auth section is unauthenticated', () => {
  withStore((env) => {
    assert.equal(isLocallyAuthenticated(env), false);
    assert.equal(readSimpleAuth(env), null);
  });
});

test('writeSimpleAuth stores one.json.auth securely and preserves unrelated sections', () => {
  withStore((env, dir) => {
    const codex = hostModelSnapshot('codex', 'pro');
    writeOneSection('codeGraphProvider', 'graphify', env);
    writeOneSection('hosts', { codex }, env);
    writeSimpleAuth('sk-validated', env);

    const auth = readSimpleAuth(env);
    assert.equal(auth?.authenticated, true);
    assert.equal(auth?.apiKey, 'sk-validated');
    assert.ok(auth?.updatedAt);
    assert.equal(isLocallyAuthenticated(env), true);

    const settings = readOneSettings(env);
    assert.equal(settings.schemaVersion, 3);
    assert.equal(settings.auth?.apiKey, 'sk-validated');
    assert.equal(settings.codeGraphProvider, 'graphify');
    assert.deepEqual(settings.hosts.codex, codex);
    assert.equal(fs.statSync(path.join(dir, 'one.json')).mode & 0o777, 0o600);
  });
});

test('writeSimpleAuth rejects a blank key without creating state', () => {
  withStore((env, dir) => {
    assert.throws(() => writeSimpleAuth('   ', env), /must not be empty/i);
    assert.equal(fs.existsSync(path.join(dir, 'one.json')), false);
  });
});

test('clearAuthentication deletes only one.json.auth', () => {
  withStore((env) => {
    const codex = hostModelSnapshot('codex', 'pro');
    writeOneSection('codeGraphProvider', 'gitnexus', env);
    writeOneSection('hosts', { codex }, env);
    writeSimpleAuth('sk-validated', env);

    assert.equal(clearAuthentication(env), true);

    const settings = readOneSettings(env);
    assert.equal(readSimpleAuth(env), null);
    assert.equal(isLocallyAuthenticated(env), false);
    assert.equal(settings.auth, undefined);
    assert.equal(settings.codeGraphProvider, 'gitnexus');
    assert.deepEqual(settings.hosts.codex, codex);
  });
});

test('a future one.json schema fails closed without being downgraded or rewritten', () => {
  withStore((env, dir) => {
    const file = path.join(dir, 'one.json');
    const original = `${JSON.stringify({
      schemaVersion: 4,
      auth: validAuth('sk-future'),
      futureSection: { keep: true },
      hosts: {},
    }, null, 2)}\n`;
    fs.writeFileSync(file, original, 'utf8');

    assert.equal(readSimpleAuth(env), null);
    assert.throws(() => writeSimpleAuth('sk-replacement', env), /newer than supported schema/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
});

test('a malformed schemaVersion fails closed without authenticating or rewriting', () => {
  withStore((env, dir) => {
    const file = path.join(dir, 'one.json');
    const original = `${JSON.stringify({
      schemaVersion: '4',
      auth: validAuth('sk-must-not-load'),
      futureSection: { keep: true },
      hosts: {},
    }, null, 2)}\n`;
    fs.writeFileSync(file, original, 'utf8');

    assert.equal(readSimpleAuth(env), null);
    assert.throws(() => writeSimpleAuth('sk-replacement', env), /schemaVersion is malformed/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
});

test('auth with extra or untrimmed fields is rejected as non-canonical', () => {
  withStore((env, dir) => {
    const file = path.join(dir, 'one.json');
    for (const auth of [
      { ...validAuth('sk-extra'), unexpectedField: true },
      validAuth(' sk-untrimmed '),
    ]) {
      fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 3, auth, hosts: {} }, null, 2)}\n`, 'utf8');
      assert.equal(readSimpleAuth(env), null);
      assert.equal(isLocallyAuthenticated(env), false);
    }
  });
});

test('an existing envelope without schemaVersion fails closed without being rewritten', () => {
  withStore((env, dir) => {
    const file = path.join(dir, 'one.json');
    const original = `${JSON.stringify({
      auth: validAuth('sk-schema-missing'),
      hosts: {},
    }, null, 2)}\n`;
    fs.writeFileSync(file, original, 'utf8');

    assert.equal(readSimpleAuth(env), null);
    assert.throws(() => writeSimpleAuth('sk-replacement', env), /schemaVersion is missing/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
});

test('an obsolete one.json schema fails closed without being upgraded', () => {
  withStore((env, dir) => {
    const file = path.join(dir, 'one.json');
    const original = `${JSON.stringify({
      schemaVersion: 2,
      auth: validAuth('sk-obsolete'),
      hosts: {},
    }, null, 2)}\n`;
    fs.writeFileSync(file, original, 'utf8');

    assert.equal(readSimpleAuth(env), null);
    assert.throws(() => writeSimpleAuth('sk-replacement', env), /schema 2 is obsolete/i);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  });
});

test('clearAuthentication reports a lock failure instead of silently claiming invalidation', () => {
  withStore((env, dir) => {
    const file = path.join(dir, 'one.json');
    writeSimpleAuth('sk-rejected', env);
    const lockDir = `${file}.lock`;
    const token = 'badc0ffee';
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, `owner-${token}.json`),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      'utf8',
    );

    assert.equal(clearAuthentication(env), false);
    assert.equal(readSimpleAuth(env)?.apiKey, 'sk-rejected');
    fs.rmSync(lockDir, { recursive: true, force: true });
    assert.equal(clearAuthentication(env), true);
    assert.equal(readSimpleAuth(env), null);
  });
});
