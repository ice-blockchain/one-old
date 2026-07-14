import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOnboardingServer } from '../ensure';
import { writeLaunchConfig } from '../launch-config';
import {
  clearServerRecord,
  readServerRecord,
  serverLockPath,
  serverRecordPath,
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

test('registry: server records and launch locks are isolated per host', () => {
  withProject((cwd, env) => {
    writeServerRecord(cwd, rec({ port: 51001, token: 'cursor', url: 'http://127.0.0.1:51001/?t=cursor' }), env, 'cursor');
    writeServerRecord(cwd, rec({ port: 51002, token: 'codex', url: 'http://127.0.0.1:51002/?t=codex' }), env, 'codex');

    assert.notEqual(serverRecordPath(cwd, env, 'cursor'), serverRecordPath(cwd, env, 'codex'));
    assert.notEqual(serverLockPath(cwd, env, 'cursor'), serverLockPath(cwd, env, 'codex'));
    assert.equal(readServerRecord(cwd, env, 'cursor')?.token, 'cursor');
    assert.equal(readServerRecord(cwd, env, 'codex')?.token, 'codex');

    clearServerRecord(cwd, env, 'cursor');
    assert.equal(readServerRecord(cwd, env, 'cursor'), null);
    assert.equal(readServerRecord(cwd, env, 'codex')?.token, 'codex');
  });
});

test('registry: first host-scoped write removes ambiguous legacy runtime files', () => {
  withProject((cwd, env) => {
    const runtimeDir = path.dirname(env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string);
    const legacy = [
      path.join(runtimeDir, 'onboarding-server.json'),
      path.join(runtimeDir, 'onboarding-complete.json'),
      path.join(runtimeDir, 'onboarding-server.lock'),
    ];
    for (const file of legacy) fs.writeFileSync(file, '{}', 'utf8');
    writeServerRecord(cwd, rec(), env, 'codex');
    assert.deepEqual(legacy.map((file) => fs.existsSync(file)), [false, false, false]);
    assert.equal(readServerRecord(cwd, env, 'codex')?.host, 'codex');
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

test('ensure: forwards the active host to launch so the wizard server detects it (--host stamp)', () => {
  withProject((cwd, env) => {
    // Without this, the detached server runs detectHost() with no --host arg and no
    // env marker → defaults to claude → shows host-specific steps (e.g. the OpenCode
    // delegation opt-in) on the opencode host.
    let capturedHost: string | undefined = 'UNSET';
    ensureOnboardingServer(cwd, {
      env,
      isAlive: () => false,
      host: 'opencode',
      launch: (c, e, h) => {
        capturedHost = h;
        writeServerRecord(c, rec({ pid: 999, port: 52000, token: 'z', url: 'http://127.0.0.1:52000/?t=z' }), e, h);
        return 999;
      },
    });
    assert.equal(capturedHost, 'opencode');
  });
});

test('ensure: never reuses a live onboarding server created for another host', () => {
  withProject((cwd, env) => {
    writeServerRecord(cwd, rec({ pid: 4242, port: 51001, token: 'cursor', url: 'http://127.0.0.1:51001/?t=cursor' }), env, 'cursor');
    let launched = false;
    const result = ensureOnboardingServer(cwd, {
      env,
      host: 'codex',
      isAlive: () => true,
      launch: (c, e, host) => {
        launched = true;
        writeServerRecord(c, rec({ pid: 5252, port: 51002, token: 'codex', url: 'http://127.0.0.1:51002/?t=codex' }), e, host);
        return 5252;
      },
    });

    assert.equal(launched, true);
    assert.equal(result.token, 'codex');
    assert.equal(readServerRecord(cwd, env, 'cursor')?.token, 'cursor');
    assert.equal(readServerRecord(cwd, env, 'codex')?.token, 'codex');
  });
});

test('ensure: no-spawn mode returns a placeholder instead of another host\'s URL', () => {
  withProject((cwd, env) => {
    writeServerRecord(cwd, rec({ port: 51001, token: 'cursor', url: 'http://127.0.0.1:51001/?t=cursor' }), env, 'cursor');
    const result = ensureOnboardingServer(cwd, {
      env: { ...env, TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1' },
      host: 'codex',
      isAlive: () => true,
    });
    assert.equal(result.port, 0);
    assert.ok(result.url.includes(':0/'));
    assert.ok(!result.url.includes('cursor'));
  });
});

test('ensure: non-Claude hosts preserve Claude\'s single preview launch entry', () => {
  withProject((cwd, env) => {
    writeLaunchConfig(cwd, 51991);
    const launchPath = path.join(cwd, '.claude', 'launch.json');
    const before = fs.readFileSync(launchPath, 'utf8');
    ensureOnboardingServer(cwd, {
      env,
      host: 'cursor',
      isAlive: () => false,
      launch: (c, e, host) => {
        writeServerRecord(c, rec({ pid: 6001, port: 51992, token: 'cursor', url: 'http://127.0.0.1:51992/?t=cursor' }), e, host);
        return 6001;
      },
    });
    assert.equal(fs.readFileSync(launchPath, 'utf8'), before);
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

test('registry: writeServerRecord is atomic — leaves no .tmp file behind', () => {
  withProject((cwd, env) => {
    writeServerRecord(cwd, rec(), env);
    const runtimeDir = path.dirname(env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string);
    assert.deepEqual(fs.readdirSync(runtimeDir).filter((f) => f.includes('.tmp')), []);
    assert.equal(readServerRecord(cwd, env)?.port, 51000);
  });
});

test('ensure: releases the launch lock after spawning', () => {
  withProject((cwd, env) => {
    const r = ensureOnboardingServer(cwd, {
      env,
      isAlive: () => false,
      launch: (c, e) => { writeServerRecord(c, rec({ pid: 4242, port: 52000, token: 'z', url: 'http://127.0.0.1:52000/?t=z' }), e); return 4242; },
    });
    assert.equal(r.started, true);
    assert.equal(fs.existsSync(serverLockPath(cwd, env)), false); // lock released in finally
  });
});

test('ensure: steals a stale (dead-holder) launch lock and relaunches', () => {
  withProject((cwd, env) => {
    // A crashed launcher left its lock behind without ever publishing a record.
    const lockPath = serverLockPath(cwd, env);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));
    let launched = false;
    const r = ensureOnboardingServer(cwd, {
      env,
      isAlive: (pid) => pid !== 999999, // lock holder dead; the relaunched server is alive
      launch: (c, e) => { launched = true; writeServerRecord(c, rec({ pid: 4242, port: 53000, token: 'n', url: 'http://127.0.0.1:53000/?t=n' }), e); return 4242; },
    });
    assert.equal(launched, true);
    assert.equal(r.port, 53000);
    assert.equal(fs.existsSync(serverLockPath(cwd, env)), false);
  });
});

test('ensure: defers to a LIVE launcher — reuses its record, no second spawn, lock untouched', () => {
  withProject((cwd, env) => {
    // The single-launcher invariant: a concurrent live launcher holds the lock and
    // has published its record. A second ensure() must reuse it, never spawn a
    // duplicate (the port-churn bug), and never steal the live holder's lock.
    const lockPath = serverLockPath(cwd, env);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, at: Date.now() }));
    writeServerRecord(cwd, rec({ pid: 4242, port: 54000, token: 'live', url: 'http://127.0.0.1:54000/?t=live' }), env);
    let launched = false;
    const r = ensureOnboardingServer(cwd, {
      env,
      isAlive: () => true,
      launch: () => { launched = true; return 1; },
    });
    assert.equal(launched, false);
    assert.equal(r.started, false);
    assert.equal(r.port, 54000);
    assert.equal(fs.existsSync(serverLockPath(cwd, env)), true); // we never held it → never remove it
  });
});
