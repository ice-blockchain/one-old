// src/shared/state/__tests__/future-skew-locks.test.ts
// The MIRROR of the freshness bug, at the owned-dir lock primitive.
//
// A freshness window written `now - stamp < WINDOW` reads a future stamp as
// permanently fresh. A staleness window written `now - stamp > STALE` reads the
// same stamp as permanently YOUNG — so the lock it guards is never reclaimable
// and every later acquirer burns its whole timeout and reports contention, for
// as long as the sentinel sits on disk. The holder is provably dead; the lock
// outlives it anyway.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, test } from 'node:test';

import { withOwnedDirLock } from '../run-agent/locks';

// Above any live pid on macOS/Linux, so `process.kill(pid, 0)` raises ESRCH and
// `processDefinitelyDead` is satisfied. The staleness check is then the ONLY
// thing standing between the reaper and the lock.
const DEAD_PID = 4_194_303;
const STALE_MS = 1_000;
const TIMEOUT_MS = 250;
const RETRY_MS = 25;

const roots: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneB-skew-lock-'));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// Plant a lock directory owned by a process that no longer exists, whose
// `acquiredAt` is `offsetMs` away from now (negative = the past).
function plantDeadOwner(offsetMs: number): string {
  const lockDir = path.join(tmpRoot(), 'held.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, '.owner-planted.json'),
    JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() + offsetMs }),
  );
  return lockDir;
}

function tryAcquire(lockDir: string): { held: boolean; ran: boolean } {
  let ran = false;
  const held = withOwnedDirLock(
    lockDir, TIMEOUT_MS, STALE_MS, RETRY_MS,
    new Int32Array(new SharedArrayBuffer(4)),
    () => { ran = true; },
  );
  return { held, ran };
}

test('a dead owner stamped in the PAST is reclaimed (the control)', () => {
  const lockDir = plantDeadOwner(-60_000);
  const { held, ran } = tryAcquire(lockDir);
  assert.equal(held, true, 'a lock 60s stale with a dead owner must be reclaimable');
  assert.equal(ran, true, 'the mutation must actually run under the reclaimed lock');
});

test('a dead owner stamped in the FUTURE is reclaimable too', () => {
  // Before the fix this is the wedge: `Date.now() - acquiredAt` is −10min, which
  // is `<= staleMs`, so reclaimStaleOwnedDirLock refuses without ever consulting
  // the pid — and the lock is immortal even though its owner is gone.
  const lockDir = plantDeadOwner(10 * 60 * 1000);
  const { held, ran } = tryAcquire(lockDir);
  assert.equal(held, true, 'a stamp no clock could have produced must not make a dead owner\'s lock immortal');
  assert.equal(ran, true, 'the mutation must actually run under the reclaimed lock');
});

// Non-vacuity: the two tests above would both pass if `withOwnedDirLock` simply
// ignored existing locks. It does not — a LIVE owner is still respected, so the
// reclaim above is decided by the staleness rule and the pid check, not by an
// absent lock protocol.
test('a LIVE owner is never reclaimed, however old its stamp', () => {
  const lockDir = path.join(tmpRoot(), 'held.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, '.owner-planted.json'),
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 60 * 60 * 1000 }),
  );
  const { held, ran } = tryAcquire(lockDir);
  assert.equal(held, false, 'an hour-stale lock whose owner is still running must NOT be stolen');
  assert.equal(ran, false, 'the mutation must not run when the lock was never held');
});

// The cell where the two rules MEET, and the one the pair above leaves open: a
// live owner whose stamp is the untrustworthy kind. Both halves of this file are
// satisfied without it — a dead owner is reclaimed on an unusable age (above), a
// live owner is respected on a usable one (above) — so nothing pinned which of
// the two wins when a LIVE holder's stamp is also unusable.
//
// clock-skew.ts states the answer as a promise: an age no clock could have
// produced "does not force [a reclaim] either: the pid check below is still the
// thing that decides, so a LIVE owner keeps its lock regardless of what its stamp
// says". That promise is one operator-precedence edit away from being false, and
// MEASURED, the edit is invisible: regrouping locks.ts's guard from
// `(age !== null && age <= staleMs) || !dead` to
// `age !== null && (age <= staleMs || !dead)` steals this lease and leaves 45
// tests across future-skew-locks, live-holder-lock-theft, lock-staleness-clock-skew
// and clock-skew all green. The equivalent cell IS covered for the cache, prefs
// and qa-evidence locks (lock-staleness-clock-skew.test.ts, "a LIVE owner keeps
// its lock regardless of stamp direction"); this is the same row for the
// owned-dir primitive behind the four run-scoped stores.
//
// In-process on purpose: the holder is THIS process, so the pid is alive by
// construction and cannot flake, and a second process could not make the input
// any more real — every process on one machine reads the same clock, so skew has
// to be injected as a STAMP either way.
test('a LIVE owner whose stamp no clock could have produced still keeps its lock', () => {
  const lockDir = path.join(tmpRoot(), 'held.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  const ownerFile = path.join(lockDir, '.owner-planted.json');
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() + 10 * 60 * 1000 }));

  const { held, ran } = tryAcquire(lockDir);
  assert.equal(held, false,
    'an unusable age must not FORCE a reclaim: the pid check decides, and this owner is running');
  assert.equal(ran, false, 'the mutation must not run when the lock was never held');
  assert.ok(fs.existsSync(ownerFile),
    'the live owner\'s sentinel must survive — a reclaim unlinks it and rmdirs the lease');
});

// The same mirror on the legacy, sentinel-less path: an EMPTY lock directory
// left by an older build is reclaimed on its mtime alone, so a directory whose
// mtime sits ahead of now was equally immortal.
function plantEmptyLockDir(offsetMs: number): string {
  const lockDir = path.join(tmpRoot(), 'legacy.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  const when = (Date.now() + offsetMs) / 1000;
  fs.utimesSync(lockDir, when, when);
  return lockDir;
}

test('an empty legacy lock dir with a PAST mtime is reclaimed (the control)', () => {
  const lockDir = plantEmptyLockDir(-60_000);
  assert.equal(tryAcquire(lockDir).held, true);
});

test('an empty legacy lock dir with a FUTURE mtime is reclaimable too', () => {
  const lockDir = plantEmptyLockDir(10 * 60 * 1000);
  assert.ok(fs.statSync(lockDir).mtimeMs > Date.now(), 'the planted mtime must genuinely be ahead of now');
  assert.equal(tryAcquire(lockDir).held, true,
    'an mtime no clock could have produced must not make an abandoned lock dir immortal');
});

test('a NON-empty legacy lock dir is left alone whatever its mtime', () => {
  const lockDir = plantEmptyLockDir(10 * 60 * 1000);
  fs.writeFileSync(path.join(lockDir, 'foreign.txt'), 'not ours', 'utf8');
  assert.equal(tryAcquire(lockDir).held, false,
    'emptiness, not the clock, is what authorizes the legacy reclaim');
});

// Non-vacuity for the future case specifically: the planted sentinel must still
// be on disk and unchanged when the reclaim is refused, so a passing "immortal"
// observation cannot be an artefact of the file never having been written.
test('the planted future sentinel is a real, readable owner record', () => {
  const lockDir = plantDeadOwner(10 * 60 * 1000);
  const ownerFile = path.join(lockDir, '.owner-planted.json');
  const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid: number; acquiredAt: number };
  assert.equal(parsed.pid, DEAD_PID);
  assert.ok(parsed.acquiredAt > Date.now(), 'the sentinel must genuinely be stamped ahead of now');
  assert.throws(() => process.kill(DEAD_PID, 0), /ESRCH/, 'the planted pid must be provably dead');
});
