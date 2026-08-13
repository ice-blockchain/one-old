// src/runners/qa-evidence/lock.ts
// Single-instance lock for the QA evidence runner.
//
// Observed 8co: four runner instances launched over the same
// `.traffic-one/reports/qa/<runId>/` directory raced each other — per-file
// writes are atomic (temp+rename) but the artifact SET is not, so validation
// read a mix of two runs' outputs. One O_EXCL lock file per run directory:
// the loser exits immediately with an `already-running` JSON instead of
// competing (same shape as the onboarding-server launch lock).

import * as fs from 'fs';
import * as path from 'path';

import { trustworthyAgeSince } from '../../shared/clock-skew';
import { emitProgress } from './report-publish';
import { qaDir } from './run-context';
import { readRegularFileOrThrow } from '../../shared/bounded-read';

/**
 * How long a lock may go WITHOUT A SIGN OF LIFE before another instance may
 * take it.
 *
 * It used to bound the run itself, and that was a bound this runner exceeds by
 * construction: the lock is held across `native` and `browser`, and a native
 * run's own declared bounds sum to 960 s — adapter 300 s (`MAX_TIMEOUT_MS`),
 * result-bundle parser 60 s (`XCRESULTTOOL_MAX_TIMEOUT_MS`), plus the two
 * substituted stack checks (`SUBSTITUTED_STACK_CHECK_IDS`) at 300 s each — none
 * of which needs an unusual project to reach. Measured against a genuinely live
 * child at 16 minutes: the steal succeeded, the victim was never told, and it
 * went on writing the same run directory. The pid guard in
 * `releaseQaRunLock` kept the two from destroying each other's lock file, so no
 * THIRD contender got in, but mutual exclusion — the whole point, and the 8co
 * failure — was gone for the rest of that run.
 *
 * `QA_RUN_LOCK_RENEW_MS` is what makes the window mean something a live run
 * cannot exceed. The holder re-stamps `refreshedAt` on a timer, so age now
 * reads "silent for fifteen minutes" rather than "started fifteen minutes ago",
 * and the property the code always wanted — a live holder keeps its lock, a
 * dead one's is reclaimable — no longer depends on runs being short. That is
 * the same rule four sibling locks landed this week
 * (shared/state/__tests__/live-holder-lock-theft.test.ts: elapsed time cannot
 * decide whether a holder is still running); the renewal is what lets this one
 * keep a TIME BOUND as well, which those sites do not need and this one does —
 * see `lockStale` for the pid-reuse wedge that bound closes.
 *
 * WHAT THE WINDOW MUST NOW EXCEED is the longest stretch this process can go
 * without turning its event loop, not the longest run. That is a much smaller
 * quantity and a much better-founded one: `runBoundedProcess` is promise-based,
 * so a child taking five minutes costs no renewals at all. The renewal cadence
 * divides the window thirty times, so twenty-nine consecutive missed renewals
 * still hold the lock.
 *
 * THE ENUMERATION THAT USED TO STAND HERE WAS WRONG, and it was the fix's
 * load-bearing premise, so it is worth the correction in full. It said "the only
 * synchronous stretches left are local fs work — the build-output manifest, the
 * artifact content hashes". There are three synchronous NON-fs stretches, all of
 * them bounded and all of them measured:
 *
 *   process-group.ts `blockFor`   Atomics.wait, REAP_SWEEP_GAP_MS (5 ms) per
 *                                 sweep, REAP_SWEEPS (3) of them
 *   process-group.ts tree kill    spawnSync taskkill, TREE_KILL_TIMEOUT_MS
 *                                 (5 s), Windows only
 *   qa-report-v2/build.ts         spawnSync HTTP probe of the served build,
 *                                 HTTP_PROBE_TIMEOUT_MS + 500 (1.5 s)
 *
 * The conclusion survives the correction and is stronger for being stated from
 * the real set: the longest synchronous stretch this runner can produce is 5 s
 * against a 900 s window, a 180x margin. The mechanism the enumeration was
 * defending against is real — renewal is a `setInterval` on the holder's own
 * event loop (see `startRenewal`), and a holder blocked in one synchronous call
 * was measured freezing `refreshedAt` for 90 s while alive — so the margin is
 * the whole of the defence, and a margin nothing verifies is a margin that
 * erodes silently.
 *
 * __tests__/renewal-premise.test.ts is what verifies it, and it verifies the
 * PARAGRAPH ABOVE as well as the constants: it recomputes the margin from the
 * imported bounds and fails if the figure written here is not the one they
 * produce, so raising `TREE_KILL_TIMEOUT_MS` makes this sentence a test
 * failure rather than a lie. It also counts the blocking call sites in the
 * runner's own modules — which must be exactly the three above — and, over
 * every module the entry point can reach, holds a roster that a fourth site
 * anywhere reds until someone records what bounds it. Raise a bound or add a
 * synchronous hashing pass and something is red before the guarantee is gone.
 *
 * That roster is also where the scope of "this runner" is written down
 * honestly. The import graph reaches synchronous calls this runner never makes
 * — `exec.run`'s 60 s `spawnSync` is the one worth naming, reachable as a
 * module through spawn-tool and on no path from here — and the roster records
 * each as not-called with the reason rather than folding it into the margin or
 * pretending it is not there.
 */
export const QA_RUN_LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * How often the holder re-stamps its own liveness.
 *
 * A TIMER RATHER THAN THE PROGRESS HEARTBEAT, which was the shape first
 * proposed and is one property short. Progress is emitted by the stack, native
 * and browser legs at their own cadences, so a phase that emits nothing — the
 * manifest walk, the Lighthouse audit's own silence, a scenario between routes
 * — would stop renewing while the run is perfectly alive, and the renewal
 * would then be as phase-dependent as the thing it replaces. A timer renews in
 * every phase and stops at exactly the same instant a heartbeat would in the
 * case that matters: both need the event loop, and a process that is gone turns
 * neither.
 *
 * `unref`ed, so a renewal can never be the reason this process stays alive —
 * the same rule as the bounded-run heartbeat: it reports on work, it is not
 * work.
 */
export const QA_RUN_LOCK_RENEW_MS = 30 * 1000;

export interface QaRunLockHolder {
  pid: number;
  startedAt: string;
  /**
   * When the holder last proved it was still turning its event loop. Absent
   * only on a lock written by a runner older than renewal, where `startedAt`
   * is the only stamp there has ever been.
   */
  refreshedAt?: string;
}

export type QaRunLockResult =
  | { ok: true; lockPath: string }
  | { ok: false; holder: QaRunLockHolder | null };

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(lockPath: string): QaRunLockHolder | null {
  try {
    const raw = JSON.parse(readRegularFileOrThrow(lockPath)) as Record<string, unknown>;
    if (!Number.isSafeInteger(raw.pid) || typeof raw.startedAt !== 'string') return null;
    return {
      pid: Number(raw.pid),
      startedAt: raw.startedAt,
      ...(typeof raw.refreshedAt === 'string' ? { refreshedAt: raw.refreshedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * How long since the last sign of life, by the most direct evidence available?
 *
 * `refreshedAt` first: it is the holder saying "I was still turning my event
 * loop at this instant", which is the only stamp that answers the question
 * `lockStale` actually asks. `startedAt` is the fallback, both for a lock
 * written before renewal existed and for one whose renewal stamp no clock could
 * have produced — a run stating when it began is still better evidence than a
 * file's mtime, which a backup, an rsync or an editor can move without the run
 * knowing. mtime is the last resort, and is all there is for an unreadable
 * payload.
 *
 * Null means "no age this clock could have produced" (see
 * `trustworthyAgeSince`), and every caller folds that toward reclaiming: an
 * impossible age is as much evidence as none, and the alternative is a
 * directory wedged permanently by a clock jump.
 */
function lockAgeMs(lockPath: string, holder: QaRunLockHolder | null): number | null {
  const now = Date.now();
  for (const stamp of [holder?.refreshedAt, holder?.startedAt]) {
    if (typeof stamp !== 'string') continue;
    const stampMs = Date.parse(stamp);
    if (!Number.isFinite(stampMs)) continue;
    const ageMs = trustworthyAgeSince(stampMs, now);
    if (ageMs !== null) return ageMs;
  }
  return trustworthyAgeSince(fs.statSync(lockPath).mtimeMs, now);
}

/**
 * Is this lock reclaimable?
 *
 * The two tests COMPOSE, and until this was corrected they did not: liveness
 * short-circuited before age was ever consulted, so the 15-minute window
 * applied to exactly one case — a lock whose payload could not be read — and a
 * readable holder was governed by liveness ALONE, with no time bound at all.
 * The comment above promised "15 minutes, plus a liveness probe" and the code
 * implemented liveness INSTEAD OF age.
 *
 * That gap is reachable, and its consequence is unbounded. A pid is not a
 * durable name: once the pid space wraps, the number a dead runner wrote can
 * belong to any live stranger, and `processAlive` cannot tell one from the
 * other — it asks whether SOMETHING answers, which is the only question the
 * kernel will answer portably. Measured before this change: a lock six hours
 * old naming a live stranger still reported `already-running`, forever. Run ids
 * are supplied by the caller and REUSED across retries of the same run, so the
 * wedge is not self-healing — it is the same run id that keeps being asked for.
 *
 * So age is the outer bound and liveness reclaims early inside it:
 *
 *   dead holder                     reclaim NOW   (liveness)
 *   live holder, renewing           respect       (the 8co protection)
 *   live holder, silent past window reclaim       (the pid-reuse bound)
 *   unreadable payload, past window reclaim
 *
 * THE THIRD ROW USED TO SAY "live holder, past window", AND THAT WAS THE BUG
 * THIS COMPOSITION INTRODUCED. Its defence — that stealing "needs an operator
 * to have launched a second instance a quarter of an hour into the first" —
 * was false as written, on two counts. A native run's declared bounds sum to
 * 960 s against a 900 s window (see `QA_RUN_LOCK_STALE_MS`), so the victim does
 * not have to be unusual, merely ordinary and slow; and the second instance
 * does not have to be an operator's, because a run id is supplied by the caller
 * and REUSED across retries, so the everyday relaunch of a run that looks stuck
 * is exactly the second instance. Measured against a genuinely live child at 16
 * minutes: the steal succeeded, the victim was never told, and two runners
 * wrote one run directory for the remainder of that run.
 *
 * The window's meaning is what changed, not its length. `refreshedAt` is
 * re-stamped every `QA_RUN_LOCK_RENEW_MS` by the holder itself, so the age this
 * tests is time since the last sign of life. A live run of any length keeps its
 * lock; a dead runner's lock — including one whose pid the kernel has since
 * handed to a live stranger, which is the wedge the bound exists for and the
 * one thing `processAlive` structurally cannot see — is reclaimable a window
 * after it stopped renewing.
 *
 * The trade that remains is the honest one: a runner ALIVE but not turning its
 * event loop for fifteen minutes is treated as dead. The longest synchronous
 * stretch this runner can produce is the 5 s Windows tree kill — see the
 * enumeration under `QA_RUN_LOCK_STALE_MS`, which used to claim there were none
 * outside fs work and was wrong about that — so the condition is not met by any
 * run this code can produce, with a 180x margin that
 * __tests__/renewal-premise.test.ts keeps from eroding unobserved. A process
 * SIGSTOPped for the window is reclaimed, and that is correct: fifteen minutes
 * of suspension is indistinguishable from death by any portable means.
 */
function lockStale(lockPath: string, holder: QaRunLockHolder | null): boolean {
  if (holder && !processAlive(holder.pid)) return true;
  try {
    const ageMs = lockAgeMs(lockPath, holder);
    // A live holder gets the benefit of an unreadable age; an absent one does
    // not. The pid is evidence that SOMETHING is running, so with no usable
    // clock reading the conservative answer is to leave it alone — and the
    // holder-less branch has no such evidence, which is why null reclaims
    // there.
    if (ageMs === null) return holder === null;
    return ageMs > QA_RUN_LOCK_STALE_MS;
  } catch {
    // Vanished between reading the holder and stating the file — reclaimable,
    // and the create below is the real arbiter anyway: it is O_EXCL.
    return true;
  }
}

function holderPayload(startedAt: string, refreshedAt: string): string {
  return JSON.stringify({ pid: process.pid, startedAt, refreshedAt });
}

function tryCreate(lockPath: string): boolean {
  try {
    const now = new Date().toISOString();
    const fd = fs.openSync(lockPath, 'wx');
    // `refreshedAt` is stamped at acquisition too, equal to `startedAt`. It
    // costs nothing and it makes every later renewal a same-length overwrite —
    // see `renewLock`, which relies on that to keep a concurrent reader from
    // ever seeing a payload with a stale tail.
    fs.writeFileSync(fd, holderPayload(now, now));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** The renewal timer per lock this process holds. */
const RENEW_FLAGS = fs.constants.O_RDWR | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);

const renewals = new Map<string, NodeJS.Timeout>();

/**
 * Locks this process acquired and then found named to someone else.
 *
 * `renewLock` is the ONLY place in the system that learns "the lock I hold now
 * names another instance", and until this existed its entire response was to
 * cancel its own timer and return — which is verbatim the failure the docblock
 * at the top of this file condemns in the pre-fix state: "the steal succeeded,
 * the victim was never told, and it went on writing the same run directory."
 * Renewal made the steal RARE; it did nothing about being uninformed of one.
 * Measured: a contender acquired against a live holder whose lock carried a
 * pre-renewal payload, and one interval later the victim had silently stood
 * down and kept running.
 *
 * BOTH HALVES OF THE SHAPE, because they point opposite ways and only the pair
 * decides. Reachability is BOUNDED: the only writer of a payload without
 * `refreshedAt` is a runner binary older than renewal, so the window is a
 * version upgrade. The consequence is OPEN-ENDED: mutual exclusion — the whole
 * point of the file, and the 8co failure — is gone for the remainder of that
 * run, and every artifact either instance writes afterwards is a mix of two
 * runs' outputs that validation cannot tell apart.
 *
 * A stderr line AND a non-zero exit, not one or the other. The line is what
 * reaches a human watching the run; the exit code is what reaches the caller,
 * and it is the half that matters, because a dispossessed run that exits 0 has
 * certified evidence it no longer owns the directory for. Deliberately NOT an
 * abort mid-write: the contender is already writing, and tearing down here
 * would leave a half-written artifact set on top of a live one. Finish, then
 * refuse to be believed.
 */
const dispossessed = new Set<string>();

/** Did this process lose a lock it holds to another instance mid-run? */
export function qaRunLockDispossessed(lockPath: string): boolean {
  return dispossessed.has(lockPath);
}

/**
 * Re-stamp OUR OWN lock, in place.
 *
 * Two properties, and both are about what happens when this process is wrong
 * about still holding the lock.
 *
 * The pid is re-read first, so a renewal that arrives after another instance
 * legitimately reclaimed the file writes nothing — the same guard, for the same
 * reason, as `releaseQaRunLock`'s.
 *
 * And the write goes through `r+` ON THE OPEN DESCRIPTOR rather than through a
 * fresh create or a temp+rename. If a contender unlinked this file between the
 * read and the write, the bytes land in an inode nobody can reach and are
 * discarded by the kernel; a rename would have replaced the contender's brand
 * new lock with ours and handed the run directory back to a runner the
 * contender had already ruled dead. Overwriting at offset 0 with a payload of
 * exactly the same length also means a reader either sees the old stamp or the
 * new one, never a torn one — and even a torn read is safe, because
 * `readHolder` answers null and `lockStale` then measures a freshly written
 * mtime.
 */
function renewLock(lockPath: string): void {
  try {
    const holder = readHolder(lockPath);
    if (!holder || holder.pid !== process.pid) {
      stopRenewal(lockPath);
      // A readable payload naming ANOTHER pid is a theft and is reported. A
      // null is not: the file is gone (an ordinary release, whose `stopRenewal`
      // means this tick should not have run at all) or its payload is torn,
      // and neither is evidence that a second instance is in the directory.
      if (holder) {
        dispossessed.add(lockPath);
        emitProgress(
          `run lock LOST: ${lockPath} now names pid ${holder.pid} (this process is ${process.pid}). `
          + 'A second instance is writing this run directory, so nothing produced from here on is '
          + 'exclusively this run\'s. Re-run the sweep alone once the other instance has finished.',
        );
      }
      return;
    }
    const payload = holderPayload(holder.startedAt, new Date().toISOString());
    // O_RDWR on the lock path, spelled in flags rather than as `'r+'` so the
    // O_NONBLOCK and O_NOFOLLOW are sayable: this is a renewal of OUR OWN lease,
    // so nothing legitimate at this path is ever a link, and a hostile shape
    // must not be able to stall the renewal timer.
    const fd = fs.openSync(lockPath, RENEW_FLAGS);
    try {
      const written = fs.writeSync(fd, payload, 0, 'utf8');
      fs.ftruncateSync(fd, written);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Best effort. A renewal that cannot be written is exactly the silence the
    // stale window is for.
  }
}

function stopRenewal(lockPath: string): void {
  const timer = renewals.get(lockPath);
  if (!timer) return;
  clearInterval(timer);
  renewals.delete(lockPath);
}

/**
 * Start renewing, and do it HERE rather than at the call site.
 *
 * There is one caller of this lock today, and a lock whose liveness depends on
 * that caller remembering to renew is a lock with a second way to fail that
 * nothing tests. Acquisition and renewal are one act.
 */
function startRenewal(lockPath: string, everyMs: number): void {
  stopRenewal(lockPath);
  // A fresh acquisition is a fresh tenancy: whatever happened to the last holder
  // of this path in this process is not this one's dispossession.
  dispossessed.delete(lockPath);
  renewals.set(lockPath, setInterval(() => renewLock(lockPath), everyMs).unref());
}

/**
 * `renewMs` is a TEST SEAM and is not a knob: no runner passes it, and the
 * default is the constant the window's arithmetic is built on.
 *
 * It exists because the alternative was worse. What has to be exercised is the
 * REAL wiring — a `setInterval` on the holder's own loop, which is the exact
 * thing that stops turning when the process is blocked or gone — and a test
 * cannot wait thirty seconds for one tick. A mocked clock would exercise a
 * different mechanism than the one the guarantee rests on; a shorter real
 * interval keeps every property the production path has and adds no branch to
 * it.
 */
export function acquireQaRunLock(
  projectRoot: string,
  runId: string,
  renewMs: number = QA_RUN_LOCK_RENEW_MS,
): QaRunLockResult {
  const dir = qaDir(projectRoot, runId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, holder: null };
  }
  const lockPath = path.join(dir, '.runner.lock');
  if (tryCreate(lockPath)) {
    startRenewal(lockPath, renewMs);
    return { ok: true, lockPath };
  }
  const holder = readHolder(lockPath);
  if (lockStale(lockPath, holder)) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Another contender reclaimed it first.
    }
    if (tryCreate(lockPath)) {
      startRenewal(lockPath, renewMs);
      return { ok: true, lockPath };
    }
  }
  return { ok: false, holder: readHolder(lockPath) };
}

/**
 * The `stopRenewal` here is TIDINESS, NOT SAFETY, and the difference is worth
 * writing down because a mutation campaign finds it: delete it and nothing
 * fails, because `renewLock` re-reads the file first and a released lock is
 * gone, so the next tick answers null, cancels itself and writes nothing. What
 * the call buys is one wasted tick and no timer outliving its subject. If it
 * were the only thing preventing a released lock from being recreated, the
 * window between release and the next tick would already be a hole.
 */
export function releaseQaRunLock(lockPath: string): void {
  stopRenewal(lockPath);
  try {
    const holder = readHolder(lockPath);
    if (holder && holder.pid !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Best effort — the stale window reclaims an orphaned lock.
  }
}
