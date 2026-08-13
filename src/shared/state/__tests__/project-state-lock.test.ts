import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ONE_MCP_REPORT_ID_LOCK_STALE_MS } from '../../../config/reporting';
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
// hook process. `reapAbandonedLock` could not help: it reaps the lock path
// itself, and a `.pending` dir is not one. One
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

// The three shapes the sibling-directory reaper still walked past after the lock
// path's own reaper stopped requiring emptiness, all of them for the SAME two
// reasons the lock path's did: it removed only the strict reader's single owner
// file and then `rmdir`ed (so anything else in the directory made the removal
// fail silently), and it matched only the `.pending` suffix.
//
//   a TORN owner file      — the SIGKILL-mid-write shape this reaper exists for,
//                            left as litter forever;
//   a STRAY beside a dead  — a `.DS_Store` or a crashed sibling's second owner,
//     owner                  same outcome;
//   a `.released` orphan   — `releaseProjectStateLock` renames the held lock
//                            aside and THEN removes it, so a process killed
//                            between those two lines leaves a directory that
//                            matched no prefix and was never reaped at all.
//
// The two negatives are what stops the widened removal from becoming a new
// defect. Once the removal actually WORKS, a live acquirer's staging directory is
// something this reaper can destroy — and its rename then fails ENOENT, which is
// not in its contended set and throws out of a hook.
test('the sibling-directory reaper clears every orphan shape, and only orphans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-lock-orphans-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const lockPath = path.join(dir, '.traffic-one', '.one.json.report-id.lock');
    const stale = Date.now() - 60_000;
    const DEAD_PID = 0x7FFFFFFF;
    assert.throws(() => process.kill(DEAD_PID, 0), /ESRCH/, 'FIXTURE the dead pid must be provably absent');

    const plant = (
      name: string,
      write: (dirPath: string) => void,
      mtime: number = stale,
    ): string => {
      const target = `${lockPath}.${name}`;
      fs.mkdirSync(target, { recursive: true });
      write(target);
      fs.utimesSync(target, new Date(mtime), new Date(mtime));
      return target;
    };
    const owner = (pid: number, token: string): string => JSON.stringify({ pid, token, createdAt: stale });

    const torn = plant('torntoken.pending', (p) => {
      // Every proper prefix of the record a killed writer was publishing.
      fs.writeFileSync(path.join(p, 'owner-torntoken.json'), '{"pid":214748364', 'utf8');
    });
    const strayed = plant('straytoken.pending', (p) => {
      fs.writeFileSync(path.join(p, 'owner-straytoken.json'), owner(DEAD_PID, 'straytoken'), 'utf8');
      fs.writeFileSync(path.join(p, '.DS_Store'), '', 'utf8');
    });
    const released = plant('releasedtoken.released', (p) => {
      fs.writeFileSync(path.join(p, 'owner-releasedtoken.json'), owner(DEAD_PID, 'releasedtoken'), 'utf8');
    });

    // NEGATIVE 1: a stray beside a LIVE owner. The strict reader refuses this
    // listing exactly as it refuses the dead one above, so liveness has to be
    // read from ANY owner-named file or this is a live acquisition being deleted.
    const liveStrayed = plant('livestraytoken.pending', (p) => {
      fs.writeFileSync(path.join(p, 'owner-livestraytoken.json'), owner(process.pid, 'livestraytoken'), 'utf8');
      fs.writeFileSync(path.join(p, '.DS_Store'), '', 'utf8');
    });
    // NEGATIVE 2: a torn owner file whose directory carries an age NO CLOCK could
    // have produced. A torn record is indistinguishable from a writer that is
    // mid-`writeFileSync` right now (the entry is published before the bytes), so
    // the age is the only thing that can authorize the reap — and an unusable age
    // is not an authorization.
    const tornFuture = plant('tornfuturetoken.pending', (p) => {
      fs.writeFileSync(path.join(p, 'owner-tornfuturetoken.json'), '{"pid":214748364', 'utf8');
    }, Date.now() + 86_400_000);

    withProjectStateLock(dir, () => undefined);

    assert.equal(fs.existsSync(torn), false,
      'a stale staging dir with a TORN owner file must be reaped — the removal has to take every entry it '
      + 'observed, not just the one the strict reader recognised, or the rmdir fails and this litters '
      + 'forever. This is the exact shape the reaper exists for.');
    assert.equal(fs.existsSync(strayed), false,
      'nor may one stray entry beside a dead owner make a staging dir permanent');
    assert.equal(fs.existsSync(released), false,
      'a `<lock>.<token>.released` orphan must be reaped too: it matched no prefix at all, so a process '
      + 'killed between the release rename and the removal left a directory nothing would ever clear');
    assert.equal(fs.existsSync(liveStrayed), true,
      'a LIVE acquirer\'s staging dir must survive whatever landed beside its owner file: removing it '
      + 'makes that acquirer\'s own rename fail ENOENT, which is not in its contended set');
    assert.equal(fs.existsSync(tornFuture), true,
      'and an age no clock could have produced must not authorize reaping a MID-WRITE staging dir');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// THE AGE THIS REAPER READS IS A DISAGREEMENT BETWEEN TWO CLOCKS, and that is the
// defect this row is about. Every stamp it compares is an mtime, written by
// whatever clock the FILESYSTEM stamps with; `Date.now()` is the reaper's own
// process clock. An NFS-mounted home whose server runs ten seconds slow therefore
// makes every staging dir on it — including one created microseconds ago — read as
// older than a stale window, while the acquirer's own 1 000 ms deadline is
// computed from `Date.now()` at both ends and is unaffected. The victim is
// healthy; only the arithmetic says otherwise.
//
// DRIVEN, three reps each, load 82.49 → 88.00: a live acquirer's staging dir
// 0.7-1.6 s old by the filesystem clock, with an owner file this uid may not
// read, was DESTROYED 3/3 and its next rename then failed ENOENT — an errno
// outside the contended set, so a raw errno out of a hook, which is the
// "plan-guard.write gate failed (EPERM)" wedge class two rows of that set exist
// to prevent. Both halves of the conjunction live in one deployment: the
// unreadable half is the networked home the lock's own docblock already cites
// ("a transient ESTALE/EIO on a networked home in CI").
//
// The repair reads `now` out of the mtime of the staging directory the
// acquisition just created, so both sides of every subtraction come from ONE
// clock. That is why the reap moved to AFTER the staging dir exists.
//
// THE SKEW IS INJECTED INTO THE REAPER'S `Date.now`, NOT INTO THE MTIMES, and the
// direction matters: backdating an mtime cannot tell this defect apart from a
// genuinely old orphan, because it moves the stamp the VICTIM would be judged by
// too. Moving the reader's clock forward reproduces exactly "the filesystem is
// behind" while leaving the victim's own deadline where it was. The control below
// is the genuinely old orphan, which must still be reaped — that is the 16co
// litter this function exists for, and it is not protected by being unreadable.
test('a staging dir the FILESYSTEM calls young survives a reaper whose own clock runs ahead of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-lock-fsclock-'));
  const realNow = Date.now.bind(Date);
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    const lockPath = path.join(dir, '.traffic-one', '.one.json.report-id.lock');

    const plantVictim = (token: string, backdate: boolean): string => {
      const staging = `${lockPath}.${token}.pending`;
      const owner = path.join(staging, `owner-${token}.json`);
      fs.mkdirSync(staging, { recursive: true });
      // A LIVE acquirer — this process — whose owner file cannot be read, which
      // is what an ACL or a `chmod -R g-r` hardening pass leaves behind. mode
      // 0000 reproduces that access class on one uid; asserted, because a run as
      // root reads straight through it and would pass this row vacuously.
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token, createdAt: realNow() }), 'utf8');
      fs.chmodSync(owner, 0o000);
      let readCode = 'READABLE';
      try { fs.readFileSync(owner, 'utf8'); } catch (error) { readCode = (error as NodeJS.ErrnoException).code ?? '?'; }
      assert.equal(readCode, 'EACCES', `FIXTURE the victim's owner file must be genuinely unreadable (${token})`);
      if (backdate) {
        const stamp = new Date(realNow() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6);
        fs.utimesSync(staging, stamp, stamp);
      }
      return staging;
    };

    const young = plantVictim('youngbyfs', false);
    const genuinelyOld = plantVictim('oldbyfs', true);

    // The reaper's clock, one stale window ahead of the filesystem's.
    Date.now = () => realNow() + ONE_MCP_REPORT_ID_LOCK_STALE_MS + 1_000;
    try {
      withProjectStateLock(dir, () => undefined);
    } finally {
      Date.now = realNow;
    }

    assert.equal(
      fs.existsSync(young), true,
      'a staging dir the FILESYSTEM stamped moments ago must survive, whatever this process\'s clock says '
      + 'about it. Subtracting an mtime from `Date.now()` measures the skew between two clocks as if it '
      + 'were an age, and on a home whose server runs slow that reads every in-flight acquisition as '
      + 'ancient — so the next acquirer destroys a live one\'s staging dir and its rename then fails '
      + 'ENOENT, a raw errno out of a hook. The `now` here has to come from the same clock as the stamps '
      + 'it is compared with, which is the mtime of the staging dir this acquisition just created.',
    );
    assert.equal(
      fs.existsSync(genuinelyOld), false,
      'and the CONTROL must still be reaped: a staging dir older than a stale window BY THE FILESYSTEM\'S '
      + 'OWN CLOCK is litter — its acquirer has overrun its 1 000 ms deadline tenfold and cannot reach '
      + 'another rename — so protecting it would restore the 16co orphan pile this reaper exists for. '
      + 'Without this half, a reaper that simply never reaps anything passes the row above.',
    );
    assert.equal(fs.existsSync(lockPath), false, 'and the acquisition itself still released its lock');
  } finally {
    Date.now = realNow;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
