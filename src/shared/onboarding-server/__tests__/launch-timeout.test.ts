import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { claimLaunchTimeoutRetry, LAUNCH_TIMEOUT_RETRY_TTL_MS } from '../launch-timeout';
import { serverLockPath } from '../registry';

function withProject(fn: (cwd: string, env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbdl-claim-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'prefs.json') };
  try {
    fn(dir, env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function claimFile(cwd: string, env: NodeJS.ProcessEnv, host?: string): string {
  return path.join(path.dirname(serverLockPath(cwd, env, host)), 'launch-timeout.claim');
}

test('the launch-timeout retry is handed out exactly ONCE per window', () => {
  withProject((cwd, env) => {
    const t0 = 1_000_000;
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'claude', t0), true, 'first timeout may prescribe a retry');
    // Every subsequent attempt inside the window — however many, however fast —
    // gets the terminal answer instead. This is the bound: prose can be ignored,
    // being handed a different message cannot.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal(
        claimLaunchTimeoutRetry(cwd, env, 'claude', t0 + attempt * 1000),
        false,
        `attempt ${attempt + 2} inside the window must not prescribe another retry`,
      );
    }
    assert.equal(
      claimLaunchTimeoutRetry(cwd, env, 'claude', t0 + LAUNCH_TIMEOUT_RETRY_TTL_MS - 1),
      false,
      'the last millisecond of the window is still inside it',
    );
    assert.equal(
      claimLaunchTimeoutRetry(cwd, env, 'claude', t0 + LAUNCH_TIMEOUT_RETRY_TTL_MS + 1),
      true,
      'past the window a genuinely new timeout re-arms',
    );
  });
});

test('the retry budget is per (project, host), not global', () => {
  withProject((cwd, env) => {
    const t0 = 2_000_000;
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'claude', t0), true);
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'claude', t0), false);
    // A different host drives a different launcher and a different lock.
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'codex', t0), true);
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'codex', t0), false);
    assert.notEqual(claimFile(cwd, env, 'claude'), claimFile(cwd, env, 'codex'));
  });
});

test('a claim that cannot be dated is treated as HELD, never as expired', () => {
  // Fail-closed matters in exactly one direction here: a wrongly-terminal
  // timeout costs one retry the user types themselves, a wrongly-retryable one
  // is the unbounded loop this module exists to make unreachable. A planted or
  // torn claim must not re-arm the retry on every attempt.
  withProject((cwd, env) => {
    const file = claimFile(cwd, env, 'claude');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all', 'utf8');
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'claude', Date.now()), false,
      'an undateable claim falls back to its mtime, which is now');
    // …but it is not permanent: the mtime fallback still expires.
    assert.equal(
      claimLaunchTimeoutRetry(cwd, env, 'claude', Date.now() + LAUNCH_TIMEOUT_RETRY_TTL_MS + 1000),
      true,
      'the mtime fallback re-arms like any other claim',
    );
  });
});

test('a runtime dir that cannot hold the claim refuses the retry rather than granting an unbounded one', () => {
  withProject((cwd, env) => {
    // A regular file where the host runtime directory must be: the claim can
    // never be persisted here, so no bound can be enforced.
    const dir = path.dirname(claimFile(cwd, env, 'claude'));
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'blocked', 'utf8');
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'claude', Date.now()), false);
    assert.equal(claimLaunchTimeoutRetry(cwd, env, 'claude', Date.now()), false);
  });
});

test('two concurrent hooks cannot both spend the one retry', () => {
  // The claim is an O_EXCL create, like the launch lock, so the second process
  // to arrive loses even when both observe the same timeout in the same instant.
  withProject((cwd, env) => {
    const now = 3_000_000;
    const winners = [
      claimLaunchTimeoutRetry(cwd, env, 'claude', now),
      claimLaunchTimeoutRetry(cwd, env, 'claude', now),
      claimLaunchTimeoutRetry(cwd, env, 'claude', now),
    ].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one claimant');
  });
});
