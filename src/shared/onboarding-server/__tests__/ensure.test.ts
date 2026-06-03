import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOnboardingServer } from '../ensure';
import {
  clearServerRecord,
  readServerRecord,
  serverRecordExists,
  writeServerRecord,
  type ServerRecord,
} from '../registry';

function withProject(fn: (cwd: string, env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsrv-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json') };
  try {
    fn(dir, env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function rec(over: Partial<ServerRecord> = {}): ServerRecord {
  return {
    pid: 4242,
    port: 51000,
    token: 'tok',
    url: 'http://127.0.0.1:51000/?t=tok',
    startedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

test('registry: write → read roundtrip', () => {
  withProject((cwd, env) => {
    writeServerRecord(cwd, rec(), env);
    const r = readServerRecord(cwd, env);
    assert.equal(r?.port, 51000);
    assert.equal(r?.token, 'tok');
    assert.equal(r?.url, 'http://127.0.0.1:51000/?t=tok');
    assert.ok(serverRecordExists(cwd, env));
    clearServerRecord(cwd, env);
    assert.equal(serverRecordExists(cwd, env), false);
  });
});

test('registry: missing → null; malformed (no token) → null', () => {
  withProject((cwd, env) => {
    assert.equal(readServerRecord(cwd, env), null);
    writeServerRecord(cwd, rec({ token: '' }), env);
    assert.equal(readServerRecord(cwd, env), null);
  });
});

test('ensure: reuses a live record without launching', () => {
  withProject((cwd, env) => {
    writeServerRecord(cwd, rec(), env);
    let launched = false;
    const r = ensureOnboardingServer(cwd, {
      env,
      isAlive: () => true,
      launch: () => {
        launched = true;
        return 1;
      },
    });
    assert.equal(r.started, false);
    assert.equal(r.url, 'http://127.0.0.1:51000/?t=tok');
    assert.equal(launched, false);
  });
});

test('ensure: relaunches when no record exists', () => {
  withProject((cwd, env) => {
    const r = ensureOnboardingServer(cwd, {
      env,
      isAlive: () => false,
      launch: (c, e) => {
        writeServerRecord(c, rec({ pid: 999, port: 52000, token: 'z', url: 'http://127.0.0.1:52000/?t=z' }), e);
        return 999;
      },
    });
    assert.equal(r.started, true);
    assert.equal(r.port, 52000);
    assert.equal(r.token, 'z');
  });
});

test('ensure: clears a stale (dead-pid) record and relaunches', () => {
  withProject((cwd, env) => {
    writeServerRecord(cwd, rec(), env);
    let launchedPid = 0;
    const r = ensureOnboardingServer(cwd, {
      env,
      isAlive: () => false,
      launch: (c, e) => {
        const pid = 7777;
        writeServerRecord(c, rec({ pid, port: 53000, token: 'n', url: 'http://127.0.0.1:53000/?t=n' }), e);
        launchedPid = pid;
        return pid;
      },
    });
    assert.equal(r.started, true);
    assert.equal(r.port, 53000);
    assert.equal(launchedPid, 7777);
  });
});
