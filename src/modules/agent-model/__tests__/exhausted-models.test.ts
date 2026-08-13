import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import {
  EXHAUSTED_MODEL_TTL_MS,
  clearExhaustedModels,
  exhaustedModelsForRole,
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  modelIsExhausted,
  recordExhaustedModel,
} from '../exhausted-models';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-exhausted-models-')));
}

function storePath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
}

test('v2 store reads legacy role arrays, applies TTL, and preserves roles on atomic upgrade', () => {
  const cwd = tmp();
  const runId = 'run-v2';
  const now = Date.parse('2026-07-15T10:00:00.000Z');
  const p = storePath(cwd, runId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      'senior-backend': [
        { model: 'expired-model', at: new Date(now - EXHAUSTED_MODEL_TTL_MS - 1).toISOString() },
        { model: 'gpt-5.6-terra-medium', at: new Date(now - 1_000).toISOString() },
      ],
      'senior-frontend': ['legacy-model-without-timestamp'],
    }), 'utf8');

    assert.deepEqual(exhaustedModelsForRole(cwd, runId, 'senior-backend', now), ['gpt-5.6-terra-medium']);
    assert.equal(modelIsExhausted(cwd, runId, 'senior-backend', 'gpt-5.6-terra', now), true, 'family matching is retained');
    assert.deepEqual(exhaustedModelsForRole(cwd, runId, 'senior-frontend', now), ['legacy-model-without-timestamp']);

    recordExhaustedModel(cwd, runId, 'senior-backend', 'claude-sonnet-5-thinking-high', now);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    assert.equal(raw.version, 2);
    const roles = raw.roles as Record<string, { entries: Array<{ model: string }> }>;
    assert.deepEqual(roles['senior-backend']!.entries.map((entry) => entry.model), [
      'gpt-5.6-terra-medium',
      'claude-sonnet-5-thinking-high',
    ]);
    assert.deepEqual(roles['senior-frontend']!.entries.map((entry) => entry.model), ['legacy-model-without-timestamp']);
    assert.equal(fs.readdirSync(path.dirname(p)).some((name) => name.includes('.tmp') || name.endsWith('.lock')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('terminal marker is per role, survives model TTL, and full-run clear removes entries and terminals', () => {
  const cwd = tmp();
  const runId = 'run-terminal';
  const now = Date.parse('2026-07-15T10:00:00.000Z');
  try {
    recordExhaustedModel(cwd, runId, 'senior-backend', 'gpt-5.6-terra-medium', now);
    assert.equal(markModelExhaustionTerminal(cwd, runId, 'senior-backend', now), true);
    recordExhaustedModel(cwd, runId, 'senior-architect', 'claude-opus-4-8-thinking-high', now);

    assert.equal(modelExhaustionTerminalForRole(cwd, runId, 'senior-backend'), true);
    assert.equal(modelExhaustionTerminalForRole(cwd, runId, 'senior-architect'), false);
    assert.deepEqual(
      exhaustedModelsForRole(cwd, runId, 'senior-backend', now + EXHAUSTED_MODEL_TTL_MS + 1),
      [],
      'individual exhausted entries still expire',
    );
    assert.equal(
      modelExhaustionTerminalForRole(cwd, runId, 'senior-backend'),
      true,
      'terminal state does not dissolve with entry TTL',
    );

    clearExhaustedModels(cwd, runId);
    assert.deepEqual(exhaustedModelsForRole(cwd, runId, 'senior-architect'), []);
    assert.equal(modelExhaustionTerminalForRole(cwd, runId, 'senior-backend'), false);
    assert.equal(fs.existsSync(storePath(cwd, runId)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('all exhausted-model mutators stand down in plugin authoring roots', () => {
  const cwd = tmp();
  resetAuthoringRootCache();
  try {
    fs.mkdirSync(path.join(cwd, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'gen', 'index.ts'), '// generator', 'utf8');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    resetAuthoringRootCache();

    assert.deepEqual(recordExhaustedModel(cwd, 'run-stand-down', 'senior-backend', 'gpt-5.6-terra-medium'), []);
    assert.equal(markModelExhaustionTerminal(cwd, 'run-stand-down', 'senior-backend'), false);
    clearExhaustedModels(cwd, 'run-stand-down');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'no project state is created in the source repo');
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── the lock HOLDER read, which the census excused as a payload read ─────────
// `readLockHolder` is the ninth copy of the owner-file shape and the only one
// in a hook module. Its bound was converted to `readOwnerEntry` this round and
// the conversion SURVIVED mutation with 1 652 executions across seven suites —
// reachable and heavily exercised, but no row planted a shape that could not be
// read. These are that row.
//
// Driven at this call site with the bound reverted to `fs.readFileSync`
// (.tmp/bounded3/p3-drive.out, load 3.65 of 10 cpus): a FIFO at the lock path
// killed at 8 008 ms, a symlink to `/dev/zero` killed at 8 058 ms, a clean lock
// answering in 9 ms. With the bound: 501 ms and 4 ms, both returning.
//
// IN A CHILD under SIGKILL for the reason the workspace-declaration rows give:
// a blocking open holds the runner's own event loop, so `--test-timeout` could
// not bound it and an in-process row would wedge the whole suite on regression.
// spawnSync's default SIGTERM does interrupt `open(2)` on a FIFO on this
// platform, which is a platform assumption these rows do not need.
function recordInChild(cwd: string, label: string): { out: unknown; elapsedMs: number } {
  const driver = path.join(cwd, 'drive-record.cjs');
  fs.writeFileSync(driver, [
    'const mod = require(process.argv[2]);',
    'process.stdout.write(JSON.stringify(mod.recordExhaustedModel(process.argv[3], "r1", "senior-backend", "gpt-5.6-terra-medium")));',
  ].join('\n'), 'utf8');

  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', driver, path.join(__dirname, '..', 'exhausted-models.ts'), cwd],
    { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' },
  );
  assert.equal(run.signal, null,
    `${label}: recordExhaustedModel must RETURN rather than block reading the lock holder. Killed by signal `
    + `means the bound is gone, and agent-model carries PreToolUse subscriptions, so this is the spawn path. `
    + `stderr: ${run.stderr || ''}`);
  assert.equal(run.status, 0, `${label}: ${run.stderr || ''}`);
  return { out: JSON.parse(run.stdout), elapsedMs: Date.now() - started };
}

function lockFixture(): { cwd: string; lock: string } {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  return { cwd, lock: `${storePath(cwd, 'r1')}.lock` };
}

test('exhausted-models: a FIFO at the store lock does not wedge the recorder — SIGKILLed at 8 008 ms before', () => {
  if (process.platform === 'win32') return;
  const { cwd, lock } = lockFixture();
  try {
    try {
      execFileSync('mkfifo', [lock], { stdio: 'ignore' });
    } catch {
      return; // no mkfifo: the shape is unreachable here, not unpinned
    }
    assert.equal(fs.lstatSync(lock).isFIFO(), true, 'FIXTURE the planted lock must really be a FIFO');

    assert.deepEqual(recordInChild(cwd, 'FIFO lock').out, [],
      'no holder line is readable, so the recorder waits out its own 500 ms lease and reports the busy '
      + 'fallback — it does not invent a holder and it does not steal');
    assert.equal(fs.lstatSync(lock).isFIFO(), true,
      'and it does not RECLAIM the unreadable lock either: a shape it cannot read is not evidence that '
      + 'the holder is gone');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('exhausted-models: a symlink at the store lock is not a holder — SIGKILLed at 8 058 ms before', () => {
  if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) return;
  const { cwd, lock } = lockFixture();
  try {
    fs.symlinkSync('/dev/zero', lock);
    assert.equal(fs.statSync(lock).isCharacterDevice(), true,
      'FIXTURE the link must really resolve to a character device');

    // The acquisition is an `openSync(lockPath, 'wx')`, which creates a regular
    // file or fails, so NOTHING legitimate is ever a link here. O_NOFOLLOW is
    // what makes that true rather than merely intended: the linked object is
    // another file's evidence answering for this lock.
    //
    // THIS ROW USED TO ASSERT THE OPPOSITE OUTCOME, and the change that
    // falsified it is the fix for the lock STEAL two rows below. It read:
    //
    //   assert.deepEqual(…, ['gpt-5.6-terra-medium'],
    //     'the link is not a parseable holder, the mtime path finds it aged,
    //      and the recorder reclaims and writes')
    //
    // — true while the age came from `statSync`, which followed the link to
    // /dev/zero, whose mtime is boot time and therefore always "aged". The same
    // following is what let a link to a live holder backdated 60 s take that
    // holder's lease. `lstatSync` dates the object AT THIS PATH, so a link
    // planted a moment ago is a fresh lock whoever it points at, and the
    // recorder now waits its lease out instead of reclaiming.
    //
    // The record being deferred is the correct trade: this contender returns the
    // busy fallback, which every caller already handles, rather than the
    // protocol taking a lease on evidence it could not read.
    assert.deepEqual(recordInChild(cwd, '/dev/zero lock').out, [],
      'the link is not a parseable holder AND the object at this path is newly created, so nothing licenses '
      + 'a reclaim: the busy fallback, and the lock left alone');
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true,
      'a shape it could not read is not evidence that the holder is gone, so the link is not removed either');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── the polarity round 3 DECLINED, which resolves against it ─────────────────
// Round 3 was asked for a row where a symlink at the lock path steals a LIVE
// holder's lease, and declined on the ground that both arms refuse anyway, for
// different reasons. That is true of a holder stamped NOW and FALSE of an aged
// one, and the difference is not cosmetic — it is the entire protection the
// docblock credits the pid check with.
//
// The mechanism: `readLockHolder` returns null for a link (O_NOFOLLOW ELOOPs),
// and the reclaim condition is `aged && (!holder || processDefinitelyDead(pid))`,
// which SHORT-CIRCUITS on `!holder`. So the pid is never consulted, and whether
// a live holder keeps its lease comes down to `aged` alone — which used to be
// computed with `statSync`, following the link to the TARGET's mtime. A holder
// file backdated 60 s was therefore an aged lock, and the lease was taken from a
// process that was still running: 154 ms and the body ran, against 816 ms and a
// busy fallback for the same link to the same live holder stamped NOW.
//
// 154 ms rather than the 95 ms the peer's summary table quotes. Its own detail
// rows (report.md 371-372) say 154, and its line 512 attributes a ~95 ms figure
// to four arms that threw `body is not a function` — a broken driver, not a
// faster steal. Recorded because the smaller number is the one that travels.
//
// Both polarities are written because a single arm proves nothing here: the
// fresh one passed before the fix too.
function liveHolderLock(stampedMsAgo: number): { cwd: string; lock: string; target: string } {
  const { cwd, lock } = lockFixture();
  const target = path.join(cwd, '.traffic-one', 'runs', 'r1', 'real-holder');
  const at = Date.now() - stampedMsAgo;
  // process.pid is THIS process, which is unarguably alive — the point of the
  // row is that a live holder must keep its lease.
  fs.writeFileSync(target, `${process.pid} ${at} sometoken\n`, 'utf8');
  fs.utimesSync(target, new Date(at), new Date(at));
  fs.symlinkSync(target, lock);
  return { cwd, lock, target };
}

test('exhausted-models: a symlink to a FRESH live holder does not steal the lock', () => {
  if (process.platform === 'win32') return;
  const { cwd, lock, target } = liveHolderLock(0);
  try {
    assert.deepEqual(recordInChild(cwd, 'fresh live holder').out, [],
      'the busy fallback: the lease belongs to a running process and this contender waits out its own '
      + 'deadline rather than taking it');
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true, 'the lock is untouched');
    assert.ok(fs.existsSync(target), 'and so is the holder\'s own record');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('exhausted-models: a symlink to an AGED live holder does not steal the lock either — 154 ms STEAL before', () => {
  if (process.platform === 'win32') return;
  // 60 s, comfortably past STORE_LOCK_STALE_MS, which is what made the old
  // `statSync` read this as a lock whose holder had walked away.
  const { cwd, lock, target } = liveHolderLock(60_000);
  try {
    assert.equal(fs.statSync(lock).mtimeMs < Date.now() - 30_000, true,
      'FIXTURE following the link must reach an OLD mtime — this is the value the stolen version read');
    assert.equal(fs.lstatSync(lock).mtimeMs > Date.now() - 30_000, true,
      'FIXTURE while the LINK ITSELF is new — the two disagree, which is the whole row');

    assert.deepEqual(recordInChild(cwd, 'aged live holder').out, [],
      'the lock is dated by the object AT THIS PATH (lstat), not by whatever the link points at. Reading '
      + 'the target\'s age instead made this an aged lock, and `aged && (!holder || dead)` short-circuits on '
      + '`!holder` because a link cannot be read through O_NOFOLLOW — so the pid check never ran and a live '
      + 'holder\'s lease was taken in 154 ms');
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true,
      'and the proof it was not stolen: a steal unlinks the link and creates a REGULAR lock file in its place');
    assert.ok(fs.existsSync(target), 'the live holder\'s record is still there');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('exhausted-models: a DANGLING symlink at the lock does not SPIN the recorder — 130.86 s of CPU before', () => {
  if (process.platform === 'win32') return;
  // THE FIFTH DEFECT, and the only one in this lane that is not a read defect.
  // Every arm of the retry loop threw INSTANTLY on this shape — `openSync('wx')`
  // EEXIST, `readOwnerEntry` ELOOP, `statSync` ENOENT — and the `catch` around
  // the reclaim ended in `continue`, which re-entered the `while` ABOVE the
  // deadline test. Three instant throws and no progress is a spin: measured at
  // STAT R, 130.86 s of CPU over 136 s of wall clock, 76.9 % of a core, still
  // running when it was killed.
  //
  // No read bound could have fixed it. A loop whose error path skips its own
  // deadline check is unbounded whatever the reads do, so the repair was to make
  // every path out of the catch reach the deadline.
  //
  // THIS ROW USED TO CLAIM IT WAS "the one that fails if a future edit puts a
  // `continue` back". IT IS NOT, and the false version is recorded rather than
  // quietly corrected because it is the kind of claim a maintainer relies on
  // while deleting the thing it names. MEASURED (.tmp/bounded4b, mutation
  // M4-EXH-DEADLINE-REVERT): with the `continue` restored, this row stays GREEN.
  // The reason is the OTHER fix in the same function — `lstatSync` SUCCEEDS on a
  // dangling link where `statSync` threw ENOENT, so the reclaim branch now
  // completes instead of throwing, and this shape never reaches the `catch` at
  // all. What this row pins is that the shape is bounded and not reclaimed; the
  // row that pins the DEADLINE PLACEMENT is the aged-directory one below, which
  // is the shape that still throws inside the catch.
  //
  // Clone-deliverable: mode 120000 pointing at a path that does not exist, which
  // costs one `ln -s` and needs no cooperating process at all. That is how it was
  // found, and it is why "the two shapes we always test" was not a corpus.
  const { cwd, lock } = lockFixture();
  try {
    fs.symlinkSync(path.join(cwd, 'no-such-holder'), lock);
    assert.equal(fs.existsSync(lock), false, 'FIXTURE the link must dangle — existsSync follows it to nothing');
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true, 'FIXTURE while the link itself is there');

    const { out, elapsedMs } = recordInChild(cwd, 'dangling symlink lock');
    assert.deepEqual(out, [],
      'the busy fallback, reached through the deadline. The shape is unreadable and un-aged, so nothing '
      + 'licenses a reclaim, and the loop must WAIT ITS LEASE OUT rather than retry without bound');
    assert.ok(elapsedMs < 15_000,
      `the recorder must return in about its own lease, not spin — took ${elapsedMs} ms`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('exhausted-models: an AGED DIRECTORY at the lock does not SPIN — the row the dangling one was thought to be', () => {
  if (process.platform === 'win32') return;
  // THE SHAPE THAT STILL REACHES THE `catch`, and therefore the only one that
  // pins WHERE the deadline is tested. Every other hostile shape in this file is
  // now handled before it gets there, which is why the deadline fix was
  // unpinned until this row: a mutation restoring the `continue` left all five
  // of them green.
  //
  //   openSync(dir, 'wx')   EEXIST         → the contention branch
  //   readOwnerEntry(dir)   null           → fstat says not a regular file
  //   lstatSync(dir)        OK, backdated  → aged, and no holder claims it
  //   unlinkSync(dir)       THROWS EPERM   → the catch, with NOTHING removed
  //
  // Four instant syscalls, no progress, and a lock that cannot be cleared: a
  // spin if the catch re-enters the loop above the deadline test. DRIVEN both
  // ways (.tmp/bounded4b/spin-ageddir.out): the deadline in place returns the
  // busy fallback in 3 316 ms; with the `continue` restored the child was
  // SIGKILLed by its parent at 8 040 ms having produced nothing.
  //
  // Not clone-deliverable as such — git can carry a tree at this path, but the
  // lock lives under `.traffic-one/runs/`, so a local writer is the arrival
  // route. It stays worth a row because the cost is a burning core rather than a
  // hook that merely hangs, and because a directory where a file is expected is
  // what a crashed writer or a careless `mkdir -p` leaves behind.
  const { cwd, lock } = lockFixture();
  try {
    fs.mkdirSync(lock, { recursive: true });
    const aged = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, aged, aged);
    assert.equal(fs.lstatSync(lock).isDirectory(), true, 'FIXTURE the lock path must really be a directory');
    assert.equal(fs.lstatSync(lock).mtimeMs < Date.now() - 60_000, true,
      'FIXTURE and it must be aged past STORE_LOCK_STALE_MS, or the reclaim is never attempted and the '
      + 'unlink that throws is never reached');

    const { out, elapsedMs } = recordInChild(cwd, 'aged directory lock');
    assert.deepEqual(out, [],
      'the busy fallback, reached through the deadline: the reclaim is licensed, the unlink of a directory '
      + 'throws, and the catch must fall through to the deadline rather than retry a hopeless attempt');
    assert.ok(elapsedMs < 15_000,
      `the recorder must return in about its own lease, not spin — took ${elapsedMs} ms`);
    assert.equal(fs.lstatSync(lock).isDirectory(), true, 'and the directory it could not remove is still there');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
