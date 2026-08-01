import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withProjectStateLock } from '../project-state-lock';

// 3cl regression: macOS surfaces a transient EPERM on the lock-acquire rename
// when it races another hook process's release — by the time the loser looks,
// the lock dir is gone, so the old "EPERM is contended only while lockPath
// exists" classification rethrew and the pipeline turned it into a
// fail-closed deny ("plan-guard.write gate failed (EPERM)"). EPERM must retry
// like every other contention signal.
test('a transient EPERM on lock acquire retries instead of escaping the hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-lock-'));
  // Star-import namespaces are getter-only under tsx; patch the shared CJS
  // module object that the lock module actually calls through.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mutableFs = require('fs') as Record<string, unknown>;
  const realRename = fs.renameSync;
  let denied = 0;
  mutableFs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
    if (denied < 2 && String(to).endsWith('.report-id.lock')) {
      denied += 1;
      const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error; // lock dir does NOT exist at this moment — the raced-release shape
    }
    realRename(from, to);
  };
  try {
    const result = withProjectStateLock(dir, () => 'ran');
    assert.equal(result, 'ran');
    assert.equal(denied, 2, 'the stub actually exercised the EPERM path');
  } finally {
    mutableFs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The mkdir-then-rename handshake stages every acquisition in a sibling
// `<lock>.<token>.pending` dir, and the only thing that removed one was the
// `finally` in withProjectStateLock — which does not run when the host kills the
// hook process. `reapAbandonedEmptyLock` could not help: it reaps the lock path
// itself, and a `.pending` dir is never empty (it holds its owner file). One
// 16co run accumulated 22 of them, which is what made `.traffic-one` look like
// it was sprouting directories at random.
test('a later acquirer reaps pending staging dirs left by dead hook processes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-lock-reap-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const lockPath = path.join(dir, '.traffic-one', '.one.json.report-id.lock');
    const stale = Date.now() - 60_000;

    // Dead owner, old enough: must be reaped.
    const dead = `${lockPath}.deadtoken.pending`;
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(
      path.join(dead, 'owner-deadtoken.json'),
      // pid 0x7FFFFFFF is not a live process; process.kill would ESRCH.
      JSON.stringify({ pid: 0x7FFFFFFF, token: 'deadtoken', createdAt: stale }),
      'utf8',
    );
    fs.utimesSync(dead, new Date(stale), new Date(stale));

    // Negative row 1: same shape but owned by THIS process, which is alive.
    const live = `${lockPath}.livetoken.pending`;
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(
      path.join(live, 'owner-livetoken.json'),
      JSON.stringify({ pid: process.pid, token: 'livetoken', createdAt: stale }),
      'utf8',
    );
    fs.utimesSync(live, new Date(stale), new Date(stale));

    // Negative row 2: dead owner but FRESH — somebody may be mid-handshake.
    const fresh = `${lockPath}.freshtoken.pending`;
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(
      path.join(fresh, 'owner-freshtoken.json'),
      JSON.stringify({ pid: 0x7FFFFFFF, token: 'freshtoken', createdAt: Date.now() }),
      'utf8',
    );

    withProjectStateLock(dir, () => undefined);

    assert.equal(fs.existsSync(dead), false, 'a stale pending dir with a dead owner must be reaped');
    assert.equal(fs.existsSync(live), true, 'a live owner is somebody\'s in-flight acquisition');
    assert.equal(fs.existsSync(fresh), true, 'a fresh pending dir may be mid-handshake');
    // And the acquisition itself still worked.
    assert.equal(fs.existsSync(lockPath), false, 'the lock is released after the critical section');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
