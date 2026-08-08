// src/shared/state/__tests__/illegible-owner-lock-wedge.test.ts
// An owner sentinel the reaper cannot read must not make its lock immortal.
//
// `reclaimStaleOwnedDirLock` answered a single unreadable sentinel with
// `if (!owner) return false`, and `readOwnedLock`'s null covered four different
// worlds at once: torn bytes, a field renamed, a pid stored as a string, and a
// file no uid can read. None of them is "this lease is still held", but all four
// were treated as if they were — and because the code below that early return is
// then unreachable, there was no self-heal and no escape. MEASURED on pristine
// 3bdc1227, at each consumer's own knobs, every one of those four shapes made
// every later acquirer burn its ENTIRE timeout and IDENTICALLY again on retry:
// ~2 011 ms for the five run-scoped stores (run ledger, agent registry,
// run-agent claims, fallback claims, cursor spawn observations) and ~305 ms for
// the decision log's hook-sequence counter, forever, for the life of the
// directory. Under retryWhileUnavailable (context-resolve, codex-liveness) one
// call pays that twice: ~4 050 ms.
//
// The repair cannot simply be "reclaim anything unreadable", because a sentinel
// belonging to a LIVE holder would then lose its lease once the directory aged
// past staleMs. It is split by which EVIDENCE survived instead:
//
//   - the pid survives (a renamed timestamp field) — liveness still decides, so
//     a running holder keeps its lock exactly as it does today;
//   - nothing survives — the lock DIRECTORY's mtime is the age, which is the
//     stamp of the mkdir that IS the lock.
//
// The second one is what makes a torn sentinel safe rather than merely
// reclaimable: torn bytes mean a writer mid-write, and that writer's directory
// is milliseconds old, nowhere near a 5 s or 15 s staleMs. Both halves are
// pinned below, and the live-holder halves use a REAL child process whose pid is
// proven alive by `kill(pid, 0)` on both sides of the attempt.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { withOwnedDirLock } from '../run-agent/locks';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const CHILD = path.join(__dirname, 'illegible-owner-lock-child.ts');

// Above any pid this kernel issues, so `kill(pid, 0)` raises ESRCH and the
// liveness guard is satisfied without killing anything. Asserted, not assumed.
const DEAD_PID = 4_194_303;
const STALE_MS = 1_000;
// Long enough that a REFUSAL is unmistakable next to the sub-millisecond
// reclaim, short enough that the refusal cases do not dominate the suite.
const TIMEOUT_MS = 400;
const RETRY_MS = 25;
const AGED_MS = 60_000;

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    // 0o000 fixtures below would defeat a plain rm, so restore what we clamped.
    try { fs.chmodSync(path.join(dir, 'held.lock', '.owner-planted.json'), 0o600); } catch { /* not that fixture */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A lock directory holding exactly one sentinel, aged `AGED_MS` past staleMs
 *  unless `fresh`. Ageing the DIRECTORY (not the record) is the point: the
 *  directory's mtime is the only age an illegible sentinel leaves behind. */
function plant(name: string, write: (ownerFile: string) => void, fresh = false): { lockDir: string; ownerFile: string } {
  const lockDir = path.join(tempDir(`t1-illegible-${name}-`), 'held.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  const ownerFile = path.join(lockDir, '.owner-planted.json');
  write(ownerFile);
  if (!fresh) {
    const when = (Date.now() - AGED_MS) / 1000;
    fs.utimesSync(lockDir, when, when);
  }
  return { lockDir, ownerFile };
}

function tryAcquire(lockDir: string): { held: boolean; ran: boolean; elapsedMs: number } {
  let ran = false;
  const startedAt = Date.now();
  const held = withOwnedDirLock(
    lockDir, TIMEOUT_MS, STALE_MS, RETRY_MS,
    new Int32Array(new SharedArrayBuffer(4)),
    () => { ran = true; },
  );
  return { held, ran, elapsedMs: Date.now() - startedAt };
}

/** The fixture is only worth anything if the reaper genuinely cannot read it.
 *  Asserted per fixture rather than assumed, because two of these shapes are
 *  readable to some uids and one of them is readable to root. */
function assertUnreadable(ownerFile: string, expected: string): void {
  let code = '';
  try { fs.readFileSync(ownerFile, 'utf8'); } catch (error) { code = (error as NodeJS.ErrnoException).code ?? '?'; }
  assert.equal(code, expected,
    `fixture guard: the planted sentinel must be genuinely unreadable (${expected}), but the read `
    + `${code ? `raised ${code}` : 'SUCCEEDED'} — this test would otherwise pass without exercising anything`);
}

test('the dead pid this file plants is provably dead', () => {
  assert.throws(() => process.kill(DEAD_PID, 0), /ESRCH/,
    'every "dead owner" fixture below depends on this pid not existing');
});

// ── the wedge, one shape per way a sentinel can stop being readable ──────────

test('a TORN owner sentinel does not wedge its lock for the life of the directory', () => {
  const { lockDir, ownerFile } = plant('torn', (f) => fs.writeFileSync(f, '{"pid":4194303,"acquire'));
  assert.throws(() => JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as unknown,
    'fixture guard: the planted bytes must genuinely not parse');

  const first = tryAcquire(lockDir);
  assert.equal(first.held, true,
    `a lock whose sentinel is torn must still be reclaimable once the directory is stale — it burned `
    + `${first.elapsedMs} ms instead, and would burn it again on every later attempt, forever`);
  assert.equal(first.ran, true, 'the mutation must actually run under the reclaimed lock');
});

test('an owner sentinel whose TIMESTAMP FIELD was renamed is reclaimed when its pid is dead', () => {
  // The exact shape a change to the writer's record produces, and the one the
  // previous lane shipped at locks.ts:130 with the whole suite green.
  const { lockDir } = plant('renamed', (f) => fs.writeFileSync(f, JSON.stringify({ pid: DEAD_PID, heldSince: Date.now() - AGED_MS })));
  const attempt = tryAcquire(lockDir);
  assert.equal(attempt.held, true,
    `a record the reaper cannot date, whose owner is provably gone, must not be immortal (burned ${attempt.elapsedMs} ms)`);
  assert.equal(attempt.ran, true, 'the mutation must actually run under the reclaimed lock');
});

test('an owner sentinel whose PID IS A STRING is reclaimed', () => {
  const { lockDir } = plant('pidstr', (f) => fs.writeFileSync(f, JSON.stringify({ pid: String(DEAD_PID), acquiredAt: Date.now() - AGED_MS })));
  const attempt = tryAcquire(lockDir);
  assert.equal(attempt.held, true,
    `a pid of the wrong TYPE carries no liveness evidence, so the directory's age must decide (burned ${attempt.elapsedMs} ms)`);
  assert.equal(attempt.ran, true, 'the mutation must actually run under the reclaimed lock');
});

test('an UNREADABLE owner sentinel does not wedge its lock', () => {
  const { lockDir, ownerFile } = plant('eacces', (f) => {
    fs.writeFileSync(f, JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() - AGED_MS }));
    fs.chmodSync(f, 0o000);
  });
  // A 0o000 file is EACCES for an ordinary uid and read straight through by
  // root, so this guard is the difference between a test and a decoration. It
  // fails LOUDLY under root rather than skipping: a green run that proved
  // nothing is the outcome this whole file exists to avoid.
  assertUnreadable(ownerFile, 'EACCES');

  const attempt = tryAcquire(lockDir);
  assert.equal(attempt.held, true,
    `a sentinel that exists and cannot be read is not evidence of a live holder (burned ${attempt.elapsedMs} ms)`);
  assert.equal(attempt.ran, true, 'the mutation must actually run under the reclaimed lock');
});

test('a DANGLING SYMLINK sentinel is illegible, not absent', () => {
  // The one shape that reads back ENOENT while the directory entry is still
  // there. Folding it in with a genuinely absent file would leave the lock
  // wedged AND would leave the entry behind for the next reaper to trip on, so
  // the read's errno alone cannot decide it — lstat has to.
  const { lockDir, ownerFile } = plant('dangling', (f) => fs.symlinkSync(path.join(path.dirname(f), 'nothing-here.json'), f));
  assertUnreadable(ownerFile, 'ENOENT');
  assert.ok(fs.lstatSync(ownerFile).isSymbolicLink(), 'fixture guard: the entry must still be in the directory');

  const attempt = tryAcquire(lockDir);
  assert.equal(attempt.held, true,
    `a sentinel pointing at nothing must not be mistaken for a holder (burned ${attempt.elapsedMs} ms)`);
  assert.equal(attempt.ran, true, 'the mutation must actually run under the reclaimed lock');
});

// ── the two properties the repair is not allowed to cost ─────────────────────

/** A real, running process whose pid the fixture can plant. `sleep` and not a
 *  node child: it needs no runtime to boot before the pid means something. */
function liveHolder(): { pid: number; stop: () => void; child: ChildProcess } {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(typeof pid === 'number' && pid > 0, 'the control needs a real child pid');
  assert.doesNotThrow(() => process.kill(pid, 0), 'the control holder must be alive BEFORE the attempt');
  return { pid, child, stop: () => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } };
}

test('a LIVE owner whose timestamp field was renamed KEEPS its lock', () => {
  // The cell that decides whether this repair is safe at all. The record is
  // undateable, the directory is a minute old — every reason to reclaim is
  // present except the one that matters, and the pid is still the thing that
  // decides. A fix that fails here is worse than the wedge it removes.
  const holder = liveHolder();
  try {
    const { lockDir, ownerFile } = plant('live-renamed', (f) => fs.writeFileSync(f, JSON.stringify({ pid: holder.pid, heldSince: Date.now() - AGED_MS })));
    const attempt = tryAcquire(lockDir);
    assert.doesNotThrow(() => process.kill(holder.pid, 0),
      'the holder must still be alive AFTER the attempt, or the refusal proved nothing');
    assert.equal(attempt.held, false, 'a RUNNING holder must not be evicted because its record changed shape');
    assert.equal(attempt.ran, false, 'the mutation must not run when the lock was never held');
    assert.ok(fs.existsSync(ownerFile), "the live owner's sentinel must survive — a reclaim unlinks it");
  } finally {
    holder.stop();
  }
});

test('a LIVE owner mid-write, whose sentinel is still TORN, keeps its lock', () => {
  // The realistic torn case, and the reason the directory mtime is a sufficient
  // guard for a shape that carries no pid: a half-written sentinel means a
  // writer that is writing RIGHT NOW, so its lock directory is milliseconds old.
  // Nothing here is backdated — that freshness is the fixture.
  const holder = liveHolder();
  try {
    const { lockDir, ownerFile } = plant('live-torn', (f) => fs.writeFileSync(f, `{"pid":${holder.pid},"acquire`), true);
    const attempt = tryAcquire(lockDir);
    assert.doesNotThrow(() => process.kill(holder.pid, 0),
      'the holder must still be alive AFTER the attempt, or the refusal proved nothing');
    assert.equal(attempt.held, false,
      'a lock directory younger than staleMs must not be reclaimed, whatever its sentinel says');
    assert.equal(attempt.ran, false, 'the mutation must not run when the lock was never held');
    assert.ok(fs.existsSync(ownerFile), 'the mid-write sentinel must survive');
  } finally {
    holder.stop();
  }
});

// ── the compare-and-swap ─────────────────────────────────────────────────────

test('competing PROCESSES reclaiming one illegible lock never overlap in the critical section', async () => {
  // The reclaim's unlink of the exact observed sentinel is the CAS, and it is
  // the only thing stopping two reapers that both read the same illegible
  // sentinel from both entering `mutate`. Real processes, because the claim is
  // about two of them; the log they share has to read as strict IN/OUT pairs.
  //
  // What this does NOT prove, stated because a reader will assume otherwise:
  // it does not isolate the unlink. MEASURED — swapping the reclaim's
  // `unlink(observed sentinel) + rmdir` for a recursive remove of the whole
  // directory leaves this test green, at 4 and at 8 contenders, with a start
  // barrier and with a sentinel large enough to take milliseconds to read. The
  // raw `mkdir` in the acquire loop is a second compare-and-swap and it masks
  // the first: a contender only races the reclaim during the two syscalls
  // between its own read and its own removal, and the illegible sentinel that
  // gets it there is destroyed by whichever reaper wins. The test below —
  // 'a reclaim never destroys what it did not observe' — is the one that pins
  // the unlink, deterministically. This one pins the property that actually
  // matters to a caller, end to end and across real processes.
  const { lockDir } = plant('cas', (f) => fs.writeFileSync(f, '{"pid":4194303,"acquire'));
  const log = path.join(path.dirname(lockDir), 'critical-section.log');
  fs.writeFileSync(log, '');

  const contenders = 4;
  const holdMs = 60;
  const barrier = tempDir('t1-illegible-cas-barrier-');
  const go = path.join(barrier, 'go');
  const children = Array.from({ length: contenders }, (_unused, index) => spawn(
    process.execPath,
    [
      '--import', pathToFileURL(PRELOAD).href,
      '--import', 'tsx',
      CHILD,
      JSON.stringify({
        lockDir, log, go, ready: path.join(barrier, `ready-${index}`),
        holdMs, timeoutMs: 20_000, staleMs: 5_000, retryMs: 5,
      }),
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  ));

  // Release them together, once all four are loaded and waiting.
  const readyBy = Date.now() + 60_000;
  while (fs.readdirSync(barrier).filter((name) => name.startsWith('ready-')).length < contenders) {
    assert.ok(Date.now() < readyBy, 'the contenders never reached the start barrier');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  fs.writeFileSync(go, '');

  const outcomes = await Promise.all(children.map((child) => new Promise<string>((resolve) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('close', () => resolve(out || `(no stdout) ${err}`));
  })));
  assert.deepEqual(outcomes, Array.from({ length: contenders }, () => 'held'),
    `every contender must eventually get the lock: ${JSON.stringify(outcomes)}`);

  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, contenders * 2,
    `every contender must get in exactly once: ${JSON.stringify(lines)}`);
  for (let i = 0; i < lines.length; i += 2) {
    const [inTag, inPid] = lines[i]!.split(' ');
    const [outTag, outPid] = lines[i + 1]!.split(' ');
    assert.equal(inTag, 'IN', `expected an entry at line ${i + 1}: ${JSON.stringify(lines)}`);
    assert.equal(outTag, 'OUT',
      `two processes were inside the critical section at once — the reclaim's compare-and-swap did not hold: ${JSON.stringify(lines)}`);
    assert.equal(inPid, outPid,
      `a contender left the critical section that another had entered: ${JSON.stringify(lines)}`);
  }
  assert.equal(fs.existsSync(lockDir), false, 'the last contender out must leave no lock directory behind');
});

test('a reclaim never destroys what it did not observe', () => {
  // The unlink IS the compare-and-swap, and this is the cell that says so
  // without needing two processes to interleave. The reaper examines exactly one
  // thing — the single `.owner-*.json` it found — so removing anything else is
  // removing something it never looked at, and the obvious repair for the one
  // sentinel shape unlink cannot delete (a DIRECTORY at the sentinel path, still
  // wedged and deliberately so) is a recursive remove that would do precisely
  // that. Here the bystander is a plain file; in a lock directory whose lease
  // has already been replaced it is the NEW owner's sentinel, and destroying it
  // puts two processes inside the critical section at once.
  // Both entries are written BEFORE the directory is aged: creating a file in a
  // directory refreshes that directory's mtime, and the mtime is the age this
  // reclaim now runs on, so a bystander added afterwards would make the lock too
  // young to reclaim and the test would pass without reaching the removal.
  const { lockDir } = plant('bystander', (f) => {
    fs.writeFileSync(f, '{"pid":4194303,"acquire');
    fs.writeFileSync(path.join(path.dirname(f), 'not-ours.json'), '{"kept":true}');
  });
  const bystander = path.join(lockDir, 'not-ours.json');

  const attempt = tryAcquire(lockDir);
  assert.ok(fs.existsSync(bystander),
    'the reaper deleted a directory entry it never examined — whatever else it got right, it can now '
    + "delete a new owner's replacement lease, which is the exact fault the unlink CAS exists to prevent");
  assert.deepEqual(JSON.parse(fs.readFileSync(bystander, 'utf8')) as unknown, { kept: true },
    'and the bystander must be untouched, not merely present');
  // Fail-closed, matching the legacy path's own rule that a non-empty lock
  // directory is left to time out rather than guessed about.
  assert.equal(attempt.held, false, 'an unrecognised entry must make the reclaim refuse, not improvise');
});
