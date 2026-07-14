import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOnboardingServer, formatWizardBanner } from '../ensure';
import {
  clearServerRecord,
  readServerRecord,
  serverLockPath,
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
      env: { ...env, TRAFFIC_ONE_DASHBOARD_URL: 'https://dash.example.test' },
      isAlive: () => true,
      launch: () => {
        launched = true;
        return 1;
      },
    });
    assert.equal(r.started, false);
    assert.equal(r.url, 'http://127.0.0.1:51000/?t=tok');
    // the dashboard deep link carries port + token in the fragment
    assert.equal(r.dashboardUrl, 'https://dash.example.test/onboarding/agent#p=51000&t=tok');
    assert.equal(launched, false);
  });
});

test('ensure: NO_SPAWN with no seeded record returns the inert placeholder (empty dashboardUrl)', () => {
  withProject((cwd, env) => {
    const r = ensureOnboardingServer(cwd, {
      env: { ...env, TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1' },
      isAlive: () => false,
      launch: () => { throw new Error('must not spawn'); },
    });
    assert.equal(r.started, false);
    assert.equal(r.port, 0);
    assert.equal(r.dashboardUrl, '');
  });
});

test('formatWizardBanner: appends the dashboard link on every host when non-empty; plain when empty', () => {
  const url = 'https://traffic.io/onboarding/agent#p=51000&t=tok';
  for (const host of ['claude', 'cursor', 'windsurf', 'opencode', 'codex']) {
    assert.equal(
      formatWizardBanner(host, url, 'setup required'),
      `setup required — open Traffic One setup: ${url}`,
    );
  }
  // empty dashboardUrl (placeholder / spawn failure) → plain banner, no dangling text
  assert.equal(formatWizardBanner('claude', '', 'setup required'), 'setup required');
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
        writeServerRecord(c, rec({ pid: 999, port: 52000, token: 'z', url: 'http://127.0.0.1:52000/?t=z' }), e);
        return 999;
      },
    });
    assert.equal(capturedHost, 'opencode');
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
    fs.writeFileSync(serverLockPath(cwd, env), JSON.stringify({ pid: 999999, at: Date.now() }));
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
    fs.writeFileSync(serverLockPath(cwd, env), JSON.stringify({ pid: 4242, at: Date.now() }));
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
