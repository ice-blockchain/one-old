// src/shared/state/run-agent/locks.ts
// Generic owned-dir lock primitives: pid liveness, stale reclaim, acquire/
// release, and withOwnedDirLock. Domain wrappers keep their own
// SharedArrayBuffer wait singletons beside their stores.

import { obj } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';

import { readOwnerEntry } from '../../bounded-read';
import { trustworthyAgeSince } from '../../clock-skew';
import { ensureDir } from '../../fsjson';
import { type MutationResult, unavailable } from './mutation-result';

interface OwnedDirLock {
  dir: string;
  ownerFile: string;
}

function processDefinitelyDead(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return obj(error)?.code === 'ESRCH';
  }
}

/**
 * What a sentinel could be made to say, split by WHICH evidence survived.
 *
 * This used to be `{pid, acquiredAt} | null`, and that `null` collapsed four
 * different worlds: the file is absent, the file cannot be read, its bytes are
 * not JSON, and its JSON is not this shape. The reaper folded all four into
 * "refuse", which is right for exactly one of them — so a sentinel that merely
 * changed shape made its lock unreclaimable for the life of the directory.
 *
 * The split is by evidence rather than by cause because the reaper only ever
 * asks two questions of a sentinel, and they degrade independently:
 *   - `pid`        decides liveness, and is the guard that protects a holder;
 *   - `acquiredAt` decides staleness, and has a usable substitute (the lock
 *                  directory's own mtime, set by the mkdir that IS the lock).
 * A record missing only the timestamp therefore keeps the guard that matters.
 */
type OwnerSentinel =
  | { kind: 'owner'; pid: number; acquiredAt: number }
  | { kind: 'pid-only'; pid: number }
  | { kind: 'illegible' }
  | { kind: 'gone' };

function readOwnedLock(filePath: string): OwnerSentinel {
  let raw: string | null;
  try {
    // `readOwnerEntry`, not a bare read, and this is the file whose own errno
    // split that leaf was MODELLED on — the eighth copy of the owner-file shape,
    // one import away from it, and the last of them still reading bare. DRIVEN
    // before the change: a FIFO at `<lockDir>/.owner-*.json` SIGKILLed
    // `withOwnedDirLock` at 8 004 ms and a symlink to `/dev/zero` at 8 076 ms,
    // against a 318 ms regular-file control. O_NOFOLLOW is the right refusal
    // here for the reason the leaf's docblock gives: every owner file is written
    // by this protocol under a random token name, so a link at that name can only
    // be another lock's evidence answering for this one.
    raw = readOwnerEntry(filePath);
  } catch (error) {
    // Every errno but ENOENT is a sentinel that is THERE and unreadable, which
    // is not the same claim as "no sentinel" and must not reclaim on the same
    // terms. ENOENT itself is ambiguous — a holder releasing between the readdir
    // above and this read, or an entry that is still in the directory and points
    // at nothing — and lstat separates them without following the link.
    if (obj(error)?.code !== 'ENOENT') return { kind: 'illegible' };
    try { fs.lstatSync(filePath); } catch { return { kind: 'gone' }; }
    return { kind: 'illegible' };
  }
  // A sentinel that is THERE and is not a regular file — a FIFO, a device, a
  // directory. Present and unreadable, which is exactly `illegible`: it makes no
  // liveness claim, so the age guard below decides, and the reclaim it licenses
  // is the same one a torn sentinel gets.
  if (raw === null) return { kind: 'illegible' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { return { kind: 'illegible' }; }
  const record = obj(parsed);
  if (!record || typeof record.pid !== 'number') return { kind: 'illegible' };
  if (typeof record.acquiredAt !== 'number') return { kind: 'pid-only', pid: record.pid };
  return { kind: 'owner', pid: record.pid, acquiredAt: record.acquiredAt };
}

// Reclaim only the exact owner sentinel observed in a stale directory. The
// successful unlink is the CAS: only that reaper may remove the now-empty
// directory, and neither an old owner nor a competing reaper can delete a new
// owner's replacement lease.
function reclaimStaleOwnedDirLock(lockDir: string, staleMs: number): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(lockDir); } catch { return false; }
  const owners = entries.filter((name) => name.startsWith('.owner-') && name.endsWith('.json'));
  if (owners.length === 1) {
    const ownerFile = path.join(lockDir, owners[0]!);
    const owner = readOwnedLock(ownerFile);
    // Nothing left to reclaim: the holder is releasing right now and the next
    // retry finds the directory freed. One retry tick, not a whole timeout.
    if (owner.kind === 'gone') return false;
    // An UNREADABLE sentinel is not a veto. Refusing on one costs every later
    // acquirer its entire timeout, on every attempt, for the life of the
    // directory — and the directory outlives the process that made it, so there
    // is no self-heal and no escape. Reclaiming instead can at worst take a
    // lease from a holder that is still working, so the two guards below are
    // kept as strong as the evidence allows rather than dropped together:
    //
    //   pid-only  — the timestamp is unreadable but the pid is not, so LIVENESS
    //               still decides exactly as it does for a whole record and a
    //               running holder keeps its lock. This is the shape a change to
    //               the record's field names produces, which is the only way a
    //               LIVE holder plausibly ends up illegible to a reader.
    //   illegible — no pid, so no liveness evidence at all, and the age is the
    //               only guard left. It is enough because it is measured from
    //               the mkdir that IS the lock: a torn sentinel means a writer
    //               mid-write, whose directory is milliseconds old and therefore
    //               nowhere near staleMs. Taking a lease here needs a holder
    //               that has held longer than staleMs AND cannot be read, and
    //               these locks wrap a single small JSON read-modify-write.
    //
    // One shape stays unreclaimable on purpose: a DIRECTORY at the sentinel
    // path, which `unlink` cannot remove. Widening the removal to reach it would
    // mean deleting entries this function never examined, and that is the CAS
    // itself — see the reclaim below. No writer here can produce that shape.
    //
    // A staleness window fails in the MIRROR direction of a freshness window: a
    // sentinel stamped ahead of now makes `Date.now() - acquiredAt` negative,
    // which is `<= staleMs` no matter how long the lock sits there, so the
    // reaper refuses forever and every later acquirer burns its whole timeout on
    // a lock whose owner is provably gone. An age no clock could have produced
    // therefore does not veto the reclaim — and it does not force one either:
    // the pid check below is still the thing that decides, so a LIVE owner keeps
    // its lock regardless of what its stamp says.
    let ownerAgeMs: number | null;
    if (owner.kind === 'owner') {
      ownerAgeMs = trustworthyAgeSince(owner.acquiredAt, Date.now());
    } else {
      // The substitute stamp. `fs.mkdirSync(lockDir)` below is the acquisition,
      // and a hold adds no entries to the directory, so this mtime dates the
      // lease as faithfully as the sentinel would have — and a reader cannot
      // corrupt it the way it can corrupt the sentinel's own field.
      let stat: fs.Stats;
      try { stat = fs.statSync(lockDir); } catch { return false; }
      ownerAgeMs = trustworthyAgeSince(stat.mtimeMs, Date.now());
    }
    // No pid, no liveness claim: `illegible` cannot assert a holder is alive, so
    // it must not be able to veto on one either.
    const ownerMayBeAlive = owner.kind !== 'illegible' && !processDefinitelyDead(owner.pid);
    // A SIGKILLed holder is gone at any age — the stamp only delayed a reclaim
    // that liveness already authorized. Illegible sentinels still need the age
    // gate: a torn mid-write is milliseconds old and must not be stolen.
    if (ownerMayBeAlive) return false;
    if (owner.kind === 'illegible' && ownerAgeMs !== null && ownerAgeMs <= staleMs) return false;
    // Unchanged, and load-bearing: unlinking the EXACT sentinel this reaper
    // observed is the compare-and-swap for the new paths too. A second reaper's
    // unlink raises ENOENT and it gives up, and a returning holder whose lease
    // was taken unlinks a name the new owner does not use.
    try {
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  }
  if (owners.length > 1) return false;

  // Compatibility with lock directories left by older builds/tests, which had
  // no owner sentinel. Serialize empty-directory reclamation with a fixed file;
  // malformed/non-empty directories are conservatively left to time out.
  let stat: fs.Stats;
  try { stat = fs.statSync(lockDir); } catch { return false; }
  // Same mirror, on an mtime this time. There is no owner sentinel to consult on
  // this legacy path, so the guard that keeps it safe is the emptiness check
  // below plus the `.reaper` CAS — neither of which a bad clock can weaken.
  const dirAgeMs = trustworthyAgeSince(stat.mtimeMs, Date.now());
  if ((dirAgeMs !== null && dirAgeMs <= staleMs) || entries.length !== 0) return false;
  const reaper = path.join(lockDir, '.reaper');
  let fd: number | undefined;
  try {
    fd = fs.openSync(reaper, 'wx');
    fs.closeSync(fd);
    fd = undefined;
    const after = fs.readdirSync(lockDir);
    if (after.length !== 1 || after[0] !== '.reaper') return false;
    fs.unlinkSync(reaper);
    fs.rmdirSync(lockDir);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ }
    try { fs.unlinkSync(reaper); } catch { /* not ours or already removed */ }
  }
}

function acquireOwnedDirLock(
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
  retryMs: number,
  waitArray: Int32Array,
): OwnedDirLock | null {
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ownerFile = path.join(lockDir, `.owner-${token}.json`);
  // The lock's PARENT (`.traffic-one/runs/<id>/`) is created through the consent
  // fence; the lock dir itself, below, must not be. This function already treated
  // an uncreatable parent as "not acquired", and a refused one means the same
  // thing more strongly — nothing inside it could be written either — so it
  // returns null here rather than falling into the retry loop, where a
  // non-recursive mkdir of a lock dir whose parent does not exist would spin
  // until the caller's whole timeout elapsed on a project that simply has not
  // opted in.
  try { if (!ensureDir(path.dirname(lockDir))) return null; } catch { return null; }
  // ONE attempt is owed to a reclaim that outlived the budget. See the branch at
  // the bottom of the loop for why, and what it cost to find out.
  let reclaimGraceUsed = false;
  while (true) {
    let madeDir = false;
    try {
      // Deliberately raw and NON-recursive: this mkdir is the compare-and-swap
      // that IS the lock (EEXIST = contended). A fenced, recursive equivalent
      // would never report contention and every contender would believe it won.
      // The fence above already refused the enclosing directory, so this line is
      // unreachable while consent is withheld.
      fs.mkdirSync(lockDir);
      madeDir = true;
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { flag: 'wx' });
      return { dir: lockDir, ownerFile };
    } catch {
      if (madeDir) {
        try { fs.unlinkSync(ownerFile); } catch { /* best-effort */ }
        try { fs.rmdirSync(lockDir); } catch { /* best-effort */ }
      }
      // THE DEADLINE IS TESTED ON EVERY PATH OUT OF THIS CATCH, and the reclaim
      // no longer jumps over it with a `continue`. A loop whose error or
      // fast-path branch skips its own deadline check is unbounded regardless of
      // what the reads inside it do — measured in the sibling copy of this
      // protocol (agent-model/exhausted-models.ts, whose `catch { continue; }`
      // spun a core for 130.9 s of CPU on a dangling symlink before this round).
      // A successful reclaim still skips the SLEEP, which is what made it worth
      // a separate branch.
      //
      // AND IT COST A SUITE ROW THAT WAS THEN FILED AGAINST ANOTHER LANE, which
      // is the part worth the paragraph. The bound above, written as `reclaim,
      // then return null if the budget is spent`, converts a reclaim that
      // outlives the budget into "the obstacle is GONE and the caller is told the
      // mutation did not happen". DRIVEN, deterministically, in a child with the
      // deadline enforced by the parent (`timeoutMs 0`): `held false`,
      // `ran false`, **stale lock REMOVED**. At the 250 ms budget of
      // `state/__tests__/future-skew-locks.test.ts` that is a coin flip under
      // concurrency — the reclaim is a read, two unlinks and an rmdir — and it is
      // why that suite's `a dead owner stamped in the PAST is reclaimed (the
      // control)` row went red 2 of 9 concurrent runs with this repair and 0 of 9
      // without it (measured by the round-4 peer, reproduced here). Round 4
      // recorded that red as somebody else's clock flake. It was this file's.
      //
      // So a SUCCESSFUL reclaim buys exactly ONE more attempt past the deadline,
      // once. That is not a return to the unbounded `continue`, and the
      // difference is the guard rather than the count: the grace is gated on
      // `reclaimed`, and `reclaimStaleOwnedDirLock` answers true only after
      // `unlinkSync(ownerFile)` AND `rmdirSync(lockDir)` have both SUCCEEDED —
      // i.e. only after the obstacle it was refusing has been removed. Every
      // shape that spins answers FALSE (the dangling symlink whose reads all
      // throw, the aged DIRECTORY at the sentinel path whose unlink raises EPERM,
      // a live holder) and still returns null at the deadline. And `once` bounds
      // the one case where a reclaim can keep succeeding: a CONCURRENT RECREATOR
      // re-planting an aged dead-pid lock. DRIVEN against exactly that (a child
      // re-planting the lock in a tight loop): with `timeoutMs 0` the single
      // grace attempt wins the directory and the call RETURNS (1 530 ms wall, no
      // signal); at `timeoutMs 250` it returns REFUSING, because the recreator's
      // lock is fresh and a reclaim that removes nothing cannot buy the retry.
      // Termination is the claim here, not the verdict — either answer is
      // bounded, which is what the round-4 repair was for.
      const reclaimed = reclaimStaleOwnedDirLock(lockDir, staleMs);
      if (Date.now() >= deadline) {
        if (!reclaimed || reclaimGraceUsed) return null;
        reclaimGraceUsed = true;
        continue;
      }
      if (!reclaimed) Atomics.wait(waitArray, 0, 0, retryMs);
    }
  }
}

function releaseOwnedDirLock(lease: OwnedDirLock): void {
  try {
    // The unique sentinel is the ownership token. If it vanished, this process
    // no longer owns the directory and must not remove anything else.
    fs.unlinkSync(lease.ownerFile);
  } catch {
    return;
  }
  try { fs.rmdirSync(lease.dir); } catch { /* a foreign/malformed entry stays fail-closed */ }
}

/**
 * Run `mutate` while holding `lockDir`. Returns whether the lock was held and the
 * mutation therefore ran — false covers a contended lock, an uncreatable one, and
 * a project whose consent fence refuses the lock's parent directory. Callers
 * already treat false as "this did not happen" (ledger.ts turns it into a
 * rejected transition), which is exactly right for the new case: a withheld
 * consent means the file the mutation would have written is refused too.
 */
export function withOwnedDirLock(
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
  retryMs: number,
  waitArray: Int32Array,
  mutate: () => void,
): boolean {
  const lease = acquireOwnedDirLock(lockDir, timeoutMs, staleMs, retryMs, waitArray);
  if (!lease) return false;
  try {
    mutate();
    return true;
  } finally {
    releaseOwnedDirLock(lease);
  }
}

/**
 * withOwnedDirLock, but reporting WHY nothing happened.
 *
 * The boolean above cannot: it returns false both when the lock was never
 * acquired (nothing was read, nothing decided — `unavailable`) and, via callers
 * that fold their own outcome into it, when the mutation ran and correctly
 * declined (`precondition-failed`). Those two demand opposite handling from a
 * claim mint or a ledger transition (see mutation-result.ts's split rule), so
 * `mutate` returns its own verdict here and only the acquisition failure is
 * turned into `unavailable`.
 */
export function withOwnedDirLockResult<T>(
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
  retryMs: number,
  waitArray: Int32Array,
  mutate: () => MutationResult<T>,
): MutationResult<T> {
  const lease = acquireOwnedDirLock(lockDir, timeoutMs, staleMs, retryMs, waitArray);
  // Indistinguishable from here, and deliberately reported as one thing: a
  // contended lock, an uncreatable lock dir, and a consent fence that refused
  // the lock's parent all mean "we did not get to find out". The gates that turn
  // this into a deny retry first, which separates the transient case in the only
  // way that is actually decisive — by trying again.
  if (!lease) return unavailable<T>('lock-unavailable');
  try {
    return mutate();
  } finally {
    releaseOwnedDirLock(lease);
  }
}

