import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureOnboardingServer, formatWizardBanner, ONBOARDING_START_TIMEOUT_CODE } from '../ensure';
import { NO_LOCAL_FALLBACK, type LocalFallback } from '../wizard-links';
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
      env: { ...env, TRAFFIC_ONE_DASHBOARD_URL: 'https://dash.example.test' },
      isAlive: () => true,
      launch: () => {
        launched = true;
        return 1;
      },
    });
    assert.equal(r.started, false);
    assert.equal(r.redirectUrl, 'http://127.0.0.1:51000/?t=tok');
    assert.equal(r.localWizardUrl, 'http://127.0.0.1:51000/local?t=tok');
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
  const fallback = 'If the hosted page is unavailable or returns 404, open the local wizard directly: http://127.0.0.1:51000/local?t=tok' as LocalFallback;
  for (const host of ['claude', 'cursor', 'windsurf', 'opencode', 'codex']) {
    assert.equal(
      formatWizardBanner(host, url, fallback, 'setup required'),
      `setup required — open Traffic One setup: ${url} — ${fallback}`,
    );
    // A healthy hosted dashboard renders NO second URL and no dangling separator.
    assert.equal(
      formatWizardBanner(host, url, NO_LOCAL_FALLBACK, 'setup required'),
      `setup required — open Traffic One setup: ${url}`,
    );
  }
  // empty dashboardUrl (placeholder / spawn failure) → plain banner, no dangling text
  assert.equal(formatWizardBanner('claude', '', NO_LOCAL_FALLBACK, 'setup required'), 'setup required');
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
    assert.ok(result.redirectUrl.includes(':0/'));
    assert.ok(!result.redirectUrl.includes('cursor'));
  });
});

test('ensure: never writes .claude/launch.json — Traffic One does not open the wizard for the user', () => {
  withProject((cwd, env) => {
    for (const host of ['claude', 'cursor'] as const) {
      ensureOnboardingServer(cwd, {
        env,
        host,
        isAlive: () => false,
        launch: (c, e, h) => {
          writeServerRecord(c, rec({ pid: 6001, port: 51992, token: host, url: `http://127.0.0.1:51992/?t=${host}` }), e, h);
          return 6001;
        },
      });
    }
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'launch.json')), false,
      'the preview-pane entry is gone; onboarding surfaces a clickable link the USER opens');
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

// ── the two budgets ─────────────────────────────────────────────────────────
// These four tests are TIMED, so they assert LOWER bounds only: load can make an
// elapsed number bigger, never smaller, so nothing here flakes under a busy
// machine. Every one also carries a witness that the thing being timed actually
// HAPPENED (a spawn tally, a wait-loop iteration count, the measured moment
// launch() was called), because a timing assertion that a slow machine satisfies
// for the wrong reason is worse than no assertion at all.

const HOLDER_PID = 999_991;

// Seed a launch lock owned by a concurrent launcher that has published nothing.
function seedHeldLock(cwd: string, env: NodeJS.ProcessEnv): void {
  const lockPath = serverLockPath(cwd, env);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: HOLDER_PID, at: Date.now() }));
}

test('ensure: a fully consumed contention wait still leaves the readiness poll its OWN full budget', () => {
  // The defect: one deadline was computed before the lock-acquisition loop and
  // reused by the post-launch readiness poll, so contention — which ensure.ts
  // documents as NORMAL — spent the readiness budget and the first post-launch
  // check fired immediately. The budgets are independent now, and the way to
  // show it is to measure the READINESS half directly in two runs whose
  // CONTENTION halves differ, and find it unchanged.
  const LOCK_WAIT_MS = 400;
  const READY_MS = 700;

  interface Timing { toLaunchMs: number; readyMs: number; launches: number; aliveCalls: number }

  const run = (contended: boolean): Timing => {
    let out: Timing = { toLaunchMs: -1, readyMs: -1, launches: 0, aliveCalls: 0 };
    withProject((cwd, env) => {
      if (contended) seedHeldLock(cwd, env);
      const t0 = Date.now();
      let launches = 0;
      let launchAt = 0;
      let aliveCalls = 0;
      // The holder looks alive until the contention window is nearly gone, then
      // dies — so the lock is STOLEN late and we reach launch() having spent
      // essentially the whole wait window. Our own child is never alive, so the
      // readiness poll can only end at its deadline.
      const isAlive = (pid: number): boolean => {
        if (pid !== HOLDER_PID) return false;
        aliveCalls += 1;
        return Date.now() - t0 < LOCK_WAIT_MS - 60;
      };
      assert.throws(() => ensureOnboardingServer(cwd, {
        env,
        isAlive,
        lockWaitTimeoutMs: LOCK_WAIT_MS,
        readyTimeoutMs: READY_MS,
        launch: () => { launches += 1; launchAt = Date.now(); return 4242; },
      }));
      out = {
        toLaunchMs: launchAt - t0,
        readyMs: Date.now() - launchAt,
        launches,
        aliveCalls,
      };
    });
    return out;
  };

  const solo = run(false);
  const contended = run(true);

  // Witnesses first: without these, "readiness took 700ms" could be satisfied by
  // a machine that was merely slow somewhere else entirely.
  assert.equal(solo.launches, 1, 'uncontended run must spawn exactly once');
  assert.equal(contended.launches, 1, 'contended run must spawn exactly once — never a second server');
  assert.ok(contended.aliveCalls >= 3,
    `the wait loop must actually have iterated against the live holder (isAlive calls: ${contended.aliveCalls})`);
  assert.ok(solo.toLaunchMs < LOCK_WAIT_MS / 2,
    `uncontended run must reach launch() promptly, took ${solo.toLaunchMs}ms`);
  assert.ok(contended.toLaunchMs >= LOCK_WAIT_MS - 60,
    `contended run must spend the contention window before launching, spent only ${contended.toLaunchMs}ms`);

  // The claim itself: the readiness half is the same in both, because it is a
  // budget of its own. With one shared deadline the contended run's readiness
  // poll gets ~0ms and throws on its first check.
  assert.ok(solo.readyMs >= READY_MS * 0.9,
    `uncontended readiness budget was ${solo.readyMs}ms, expected ~${READY_MS}ms`);
  assert.ok(contended.readyMs >= READY_MS * 0.9,
    `contention consumed the readiness budget: the post-launch poll got only ${contended.readyMs}ms of ${READY_MS}ms`);
  // Hang ceiling, not a timing assertion: a poll that never terminates must fail
  // rather than run out the test runner's clock.
  assert.ok(contended.readyMs < 20_000, 'readiness poll did not terminate');
});

test('ensure: a launcher that runs out of time throws a TIMEOUT, never an unclassified failure', () => {
  // Both timeout exits, because both used to raise a plain Error that
  // bootstrap.ts classified as START_FAILED — "reinstall the plugin" — for what
  // is a fact about the clock.
  withProject((cwd, env) => {
    // (a) a live concurrent holder kept the lock for the whole window.
    seedHeldLock(cwd, env);
    let launches = 0;
    assert.throws(
      () => ensureOnboardingServer(cwd, {
        env,
        isAlive: (pid) => pid === HOLDER_PID,
        lockWaitTimeoutMs: 150,
        readyTimeoutMs: 150,
        launch: () => { launches += 1; return 1; },
      }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, ONBOARDING_START_TIMEOUT_CODE, 'lock contention is a TIMEOUT');
        assert.match(error.message, /another launcher holds the lock/);
        return true;
      },
    );
    assert.equal(launches, 0, 'never double-launch behind a live holder');
  });

  withProject((cwd, env) => {
    // (b) our own child never published.
    let launches = 0;
    assert.throws(
      () => ensureOnboardingServer(cwd, {
        env,
        isAlive: () => false,
        lockWaitTimeoutMs: 150,
        readyTimeoutMs: 150,
        launch: () => { launches += 1; return 4242; },
      }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, ONBOARDING_START_TIMEOUT_CODE, 'a silent child is a TIMEOUT');
        return true;
      },
    );
    assert.equal(launches, 1, 'the readiness timeout must be reached through a real spawn');
  });
});

test('ensure: a contention timeout never hands back a DEAD launcher\'s URL', () => {
  // The `if (rec) return …` guard on the lock-contention exit ran only after
  // reuseIfLive() had already proved that record's pid dead, so the one thing it
  // reliably did was return a link to a corpse stamped `started: true` — which
  // the agent then posts to the user.
  withProject((cwd, env) => {
    seedHeldLock(cwd, env);
    writeServerRecord(cwd, rec({ pid: 999_992, port: 55001, token: 'dead', url: 'http://127.0.0.1:55001/?t=dead' }), env);
    assert.throws(
      () => ensureOnboardingServer(cwd, {
        env,
        // The holder is alive (so the lock is never stolen); the RECORD's pid is not.
        isAlive: (pid) => pid === HOLDER_PID,
        lockWaitTimeoutMs: 150,
        readyTimeoutMs: 150,
        launch: () => { throw new Error('must not spawn behind a live holder'); },
      }),
      (error: NodeJS.ErrnoException) => error.code === ONBOARDING_START_TIMEOUT_CODE,
    );
  });

  // …and the microsecond race the guard actually exists for still works: a LIVE
  // record published by the holder is handed back rather than thrown away.
  withProject((cwd, env) => {
    seedHeldLock(cwd, env);
    writeServerRecord(cwd, rec({ pid: HOLDER_PID, port: 55002, token: 'live', url: 'http://127.0.0.1:55002/?t=live' }), env);
    const result = ensureOnboardingServer(cwd, {
      env,
      isAlive: (pid) => pid === HOLDER_PID,
      lockWaitTimeoutMs: 150,
      readyTimeoutMs: 150,
      launch: () => { throw new Error('must not spawn behind a live holder'); },
    });
    assert.equal(result.port, 55002);
  });
});

test('ensure: a MISSING runner stays a terminal ENOENT and is never mistaken for a timeout', () => {
  // `node <absent file>` spawns fine and dies asynchronously, so the only
  // symptom of a broken install used to be the readiness timeout. Now that a
  // timeout is retryable, retrying a missing runner would be pointless — so the
  // one check that separates the two runs before the spawn.
  withProject((cwd, env) => {
    const missing = path.join(cwd, 'no-such-onboarding-server.cjs');
    assert.throws(
      () => ensureOnboardingServer(cwd, {
        env: { ...env, TRAFFIC_ONE_ONBOARDING_SERVER_ENTRY: missing },
        isAlive: () => false,
        lockWaitTimeoutMs: 100,
        readyTimeoutMs: 100,
      }),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 'ENOENT', 'a missing runner is a packaging failure, not a clock');
        assert.notEqual(error.code, ONBOARDING_START_TIMEOUT_CODE);
        assert.match(error.message, /runner is missing/);
        return true;
      },
    );
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
