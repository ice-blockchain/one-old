// src/runners/qa-evidence/__tests__/run-lock-stale.test.ts
// The run lock's two tests have to COMPOSE, and until this round they did not.
//
// `lockStale` short-circuited on liveness before it ever reached the age branch,
// so the 15-minute window governed exactly one case — a lock whose payload could
// not be read — and a readable holder was governed by liveness ALONE. The
// comment promised "15 minutes, plus a liveness probe"; the code implemented
// liveness INSTEAD OF age.
//
// The gap is reachable and its consequence is unbounded: a pid is not a durable
// name, and once the pid space wraps, the number a dead runner wrote can belong
// to any live stranger. `processAlive` cannot tell one from the other — it asks
// whether SOMETHING answers, the only question the kernel answers portably.
// Measured before this change: a lock six hours old naming a live stranger still
// reported `already-running`, with no time bound at all. Run ids are supplied by
// the caller and reused across retries of the same run, so nothing about that is
// self-healing.
//
// All four rows are here because the fix is a COMPOSITION: three of them are the
// behaviour that had to be preserved, and a change that reclaimed too eagerly
// would re-arm the 8co failure this lock exists to prevent (four runner
// instances over one run directory, reading a mix of two runs' artifacts).

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { acquireQaRunLock, releaseQaRunLock } from '../lock';
import { qaDir } from '../run-context';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * The longest run this runner can legitimately produce, from its own declared
 * bounds: a native leg is adapter 300 s (`MAX_TIMEOUT_MS`) + result-bundle
 * parser 60 s (`XCRESULTTOOL_MAX_TIMEOUT_MS`) + two substituted stack checks
 * (`SUBSTITUTED_STACK_CHECK_IDS`) at 300 s each, and the lock is held across
 * all of it. 960 s against a 900 s window is why the rows below exist.
 */
const FULL_NATIVE_BOUNDS_MS = 960 * 1000;

function withRunDir(fn: (projectRoot: string, lockPath: string) => void): void {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-runlock-')));
  try {
    const dir = qaDir(projectRoot, 'R');
    fs.mkdirSync(dir, { recursive: true });
    fn(projectRoot, path.join(dir, '.runner.lock'));
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

/**
 * The same fixture for the one row that has to let REAL time pass inside it.
 * Deliberately a second function rather than a `void | Promise<void>` widening
 * of the one above: widening it would make the cleanup of every existing row
 * depend on the caller remembering to await, and a row that forgot would still
 * report green while asserting against a deleted directory.
 */
async function withRunDirAsync(
  fn: (projectRoot: string, lockPath: string) => Promise<void>,
): Promise<void> {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-runlock-')));
  try {
    const dir = qaDir(projectRoot, 'R');
    fs.mkdirSync(dir, { recursive: true });
    await fn(projectRoot, path.join(dir, '.runner.lock'));
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

/** Matches `lock-dispossession.test.ts`: real ticks, a sixth of a second. */
const FAST_RENEW_MS = 20;

/** Long enough for several real renewal ticks, short enough to be free. */
function afterRenewals(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, FAST_RENEW_MS * 8); });
}

/**
 * A lock as a runner PREDATING RENEWAL wrote it: a pid and a start, and no
 * `refreshedAt`. Every row that was already here keeps using it, so the legacy
 * payload stays exercised on both sides of the window rather than becoming an
 * untested fallback the moment renewal landed.
 */
function seed(lockPath: string, pid: number, startedAtMs: number): void {
  fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: new Date(startedAtMs).toISOString() }));
}

/** A lock as the current runner writes it: started then, last seen alive then. */
function seedRenewing(lockPath: string, pid: number, startedAtMs: number, refreshedAtMs: number): void {
  fs.writeFileSync(lockPath, JSON.stringify({
    pid,
    startedAt: new Date(startedAtMs).toISOString(),
    refreshedAt: new Date(refreshedAtMs).toISOString(),
  }));
}

/**
 * A pid that has exited AND been reaped, so `kill(pid, 0)` raises ESRCH.
 *
 * Asserted rather than assumed: a hard-coded high pid is only PROBABLY free, and
 * a live one would make the row below pass for the opposite reason.
 */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
  assert.ok(typeof pid === 'number' && pid > 1, 'fixture guard: the probe child must have a pid');
  assert.throws(() => process.kill(pid, 0), 'fixture guard: the probe child must be gone and reaped');
  return pid;
}

// THE FIX. This process is the live holder — the same evidence a recycled pid
// presents, and the runner cannot tell them apart — but the lock is six hours
// old, which no legitimate run is.
test('a lock older than the stale window is reclaimed even though its pid answers', () => {
  withRunDir((projectRoot, lockPath) => {
    seed(lockPath, process.pid, Date.now() - SIX_HOURS_MS);
    const result = acquireQaRunLock(projectRoot, 'R');
    assert.equal(
      result.ok,
      true,
      'a liveness probe with no time bound wedges the run directory forever on a recycled pid',
    );
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number };
    assert.equal(holder.pid, process.pid, 'and the reclaim must leave the new holder named on disk');
  });
});

// THE PROTECTION THAT HAD TO SURVIVE IT, and the reason the window is not
// shorter: a full visual run legitimately takes minutes, and a second instance
// stealing the lock mid-run is the failure the lock was written for.
test('a live holder inside the stale window keeps the run directory', () => {
  withRunDir((projectRoot, lockPath) => {
    seed(lockPath, process.pid, Date.now() - 60_000);
    assert.equal(acquireQaRunLock(projectRoot, 'R').ok, false, 'one minute into a run is not a stale lock');
  });
});

// LIVENESS RECLAIMS EARLY, which is the half that already worked and the half
// the round-4 summary wrongly credited to the error listener: a holder that is
// gone is reclaimed at once, without waiting out the window.
test('a dead holder is reclaimed immediately, without waiting for the window', () => {
  withRunDir((projectRoot, lockPath) => {
    seed(lockPath, deadPid(), Date.now());
    assert.equal(acquireQaRunLock(projectRoot, 'R').ok, true, 'a crashed runner must never wedge the directory');
  });
});

// The case the window used to govern ALONE. It still governs it, and from the
// file's mtime, because a torn payload names no pid and no start time.
test('an unreadable lock is decided by age alone, in both directions', () => {
  withRunDir((projectRoot, lockPath) => {
    fs.writeFileSync(lockPath, '{ torn payload');
    assert.equal(acquireQaRunLock(projectRoot, 'R').ok, false, 'a lock written seconds ago may belong to a live run');
    const old = new Date(Date.now() - SIX_HOURS_MS);
    fs.writeFileSync(lockPath, '{ torn payload');
    fs.utimesSync(lockPath, old, old);
    assert.equal(acquireQaRunLock(projectRoot, 'R').ok, true, 'and nothing may hold a run directory unreadably forever');
  });
});

// ---------------------------------------------------------------------------
// AGE MEANS SILENCE, NOT DURATION.
// ---------------------------------------------------------------------------

// THE STEAL PROBE, re-run at the length that made it reachable. A native leg
// spending its full declared bounds is 960 s against a 900 s window, so the
// victim of the measured theft did not have to be unusual — merely ordinary and
// slow — and the second instance did not have to be an operator's, because run
// ids are reused across retries and the everyday relaunch of a run that looks
// stuck IS the second instance. Before renewal this row returned ok:true, the
// victim was never told, and two runners wrote one run directory.
test('a run spending its full declared bounds keeps its lock', () => {
  withRunDir((projectRoot, lockPath) => {
    const startedAtMs = Date.now() - FULL_NATIVE_BOUNDS_MS;
    seedRenewing(lockPath, process.pid, startedAtMs, Date.now() - 1_000);
    assert.ok(
      Date.now() - startedAtMs > 15 * 60 * 1000,
      'fixture guard: this row is only about the window if the run has actually outlived it',
    );

    const result = acquireQaRunLock(projectRoot, 'R');
    assert.equal(result.ok, false, 'a holder that renewed a second ago is alive, whatever its total duration');
    assert.equal(result.ok ? null : result.holder?.pid, process.pid, 'and the contender must be told who holds it');
  });
});

// The wedge the time bound exists for, unchanged by renewal: a pid answering is
// not evidence of THIS run, because the kernel may have handed that number to a
// stranger. Silence past the window reclaims, no matter how recently the run
// began — which is the direction that matters, since a renewal stamp is the
// only thing separating this row from the one above.
test('a holder silent past the window is reclaimed even if it started moments ago', () => {
  withRunDir((projectRoot, lockPath) => {
    seedRenewing(lockPath, process.pid, Date.now() - 1_000, Date.now() - SIX_HOURS_MS);
    assert.equal(
      acquireQaRunLock(projectRoot, 'R').ok,
      true,
      'a start stamp cannot vouch for liveness: only the last sign of life may',
    );
  });
});

// Both stamps are consulted in one direction only. A `refreshedAt` no clock
// could have produced — a lock copied forward by a restore, or written across a
// clock jump — must not become a lease into the future; `trustworthyAgeSince`
// rejects it and the fallback carries the decision to `startedAt`, which here
// is six hours old and reclaimable.
test('an impossible renewal stamp cannot extend a lock past the window', () => {
  withRunDir((projectRoot, lockPath) => {
    seedRenewing(lockPath, process.pid, Date.now() - SIX_HOURS_MS, Date.now() + SIX_HOURS_MS);
    assert.equal(
      acquireQaRunLock(projectRoot, 'R').ok,
      true,
      'a stamp from the future is as much evidence as none, and must not wedge the directory',
    );
  });
});

// RENEWAL IS WIRED TO ACQUISITION, not to the call site. The rows above all
// seed a stamp by hand and would pass in full against a runner that never
// renews at all — the fix would be inert and every one of them still green.
// A REAL interval through the `renewMs` seam rather than a mocked clock, for the
// reason `lock.ts` gives where that seam is declared: the guarantee rests on a
// `setInterval` turning on the holder's OWN event loop — the exact thing that
// stops turning when the holder blocks or dies — and a mocked clock substitutes
// for that mechanism instead of exercising it.
//
// Mocking `setInterval` alone cannot decide this row at all. Ticking a mocked
// timer does not move the wall clock, so the renewal restamps `refreshedAt`
// inside the same millisecond as acquisition and an ISO string cannot represent
// the difference; the row was then decided by whether a millisecond boundary
// happened to fall between two adjacent writes. It read as an intermittent flake
// until the machine became fast enough to lose that race every time.
test('acquiring the lock starts renewing it, and releasing stops', async () => {
  await withRunDirAsync(async (projectRoot, lockPath) => {
    const acquired = acquireQaRunLock(projectRoot, 'R', FAST_RENEW_MS);
    assert.equal(acquired.ok, true, 'fixture guard: the lock must be free at the start of this row');
    const first = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { startedAt: string; refreshedAt: string };
    assert.equal(first.refreshedAt, first.startedAt, 'acquisition stamps both, so every renewal is the same length');

    await afterRenewals();
    const renewed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid: number; startedAt: string; refreshedAt: string;
    };
    assert.ok(
      Date.parse(renewed.refreshedAt) > Date.parse(first.refreshedAt),
      'a held lock must prove its liveness without being asked',
    );
    assert.equal(renewed.startedAt, first.startedAt, 'and renewal must not rewrite when the run began');
    assert.equal(renewed.pid, process.pid);
    assert.equal(
      fs.readFileSync(lockPath, 'utf8').length,
      JSON.stringify(first).length,
      'same-length overwrite: a concurrent reader sees one stamp or the other, never a tail of both',
    );

    const heldBytes = fs.readFileSync(lockPath, 'utf8');
    releaseQaRunLock(acquired.ok ? acquired.lockPath : lockPath);
    await afterRenewals();
    assert.equal(fs.existsSync(lockPath), false, 'a released lock must stay released');

    // The line above is necessary and NOT sufficient, and saying so is the point:
    // it cannot fail however badly release is broken. `renewLock` opens an
    // EXISTING path and returns early on an unreadable holder, so a renewal that
    // outlives its release can never resurrect the file — deleting
    // `clearInterval` outright leaves the absence check green. What that check
    // grades is `renewLock`'s own guard, not `stopRenewal`.
    //
    // So the timer is made observable instead: re-plant the tenancy this process
    // just released, byte for byte, and give a surviving interval several ticks
    // to find a readable holder wearing its own pid. Renewal rewrites
    // `refreshedAt` in place at a fixed length, so any tick at all shows up as a
    // change in these bytes — and "releasing stops" becomes a claim the row can
    // actually falsify.
    fs.writeFileSync(lockPath, heldBytes);
    await afterRenewals();
    assert.equal(
      fs.readFileSync(lockPath, 'utf8'),
      heldBytes,
      'a released holder must not keep stamping liveness onto the path it gave up',
    );
  });
});

// The renewal's own guard, and the only one that matters after a reclaim has
// already happened: the victim of a legitimate steal must not stamp its
// liveness onto the thief's lock. Same guard, same reason, as the one in
// `releaseQaRunLock` — which is what kept the measured theft from becoming a
// three-way race.
test('a renewal after another instance took the lock writes nothing', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    withRunDir((projectRoot, lockPath) => {
      assert.equal(acquireQaRunLock(projectRoot, 'R').ok, true, 'fixture guard: this process must hold it first');
      const thief = { pid: process.pid + 1, startedAt: new Date().toISOString(), refreshedAt: new Date().toISOString() };
      fs.writeFileSync(lockPath, JSON.stringify(thief));

      mock.timers.tick(10 * 60 * 1000);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(lockPath, 'utf8')),
        thief,
        'the former holder must not keep a lock alive on behalf of whoever holds it now',
      );
    });
  } finally {
    mock.timers.reset();
  }
});
