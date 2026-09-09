// Cross-process serialization for canonical `.traffic-one/.one.json` mutations.
//
// The One MCP report id lives inside that shared state file. Serializing only the
// mint operation is insufficient: an ordinary writer can read before the mint and
// publish its stale whole-state snapshot afterwards, erasing the durable id. Every
// canonical writer therefore uses this same lock and re-reads the current file
// while holding it before publishing.

import * as fs from 'fs';
import * as path from 'path';

import {
  ONE_MCP_REPORT_ID_LOCK_RETRY_MS,
  ONE_MCP_REPORT_ID_LOCK_STALE_MS,
  ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS,
  ONE_UID_FIELD,
  isValidOneMcpReportId,
} from '../../config/reporting';
import { STATE_FILE } from '../../config/paths';
import { readOwnerEntry } from '../bounded-read';
import { trustworthyAgeSince } from '../clock-skew';
import { ensureDir } from '../fsjson';
import { safeRunIdSegment } from './run-id-segment';

interface ProjectStateLock {
  readonly dirPath: string;
  readonly ownerPath: string;
  readonly token: string;
  /** `<dev>:<ino>` of the acquired lock directory, or null when it could not be
   *  stat'd. See `heldLockIds`. */
  readonly id: string | null;
}

interface ProjectStateLockOwner {
  readonly ownerPath: string;
  readonly token: string;
  readonly pid: number;
  /** Validated as part of the record's SHAPE, and read by no decision: neither
   *  reap arm consults a stamp any more. Kept because a record missing it is not
   *  one this protocol wrote, which is what the strict reader is for. */
  readonly createdAt: number;
}

let sleepArray: Int32Array | null | undefined;
const heldLocks = new Set<string>();

/**
 * `<dev>:<ino>` of every lock directory THIS process currently holds.
 *
 * `heldLocks` above is keyed by the lock path STRING and so is blind to a second
 * spelling of the same project — which is the whole reason the self-contention
 * branch in the retry loop exists. This set is keyed by the thing that IS the
 * lock rather than by a name for it, so it answers the branch's question
 * directly: "is the directory I just collided with one I already hold?"
 *
 * IT REPLACES A pid+token PAIR, and the replacement is a fix rather than a
 * simplification. That pair was keyed by the token ALONE (the pid was a second
 * conjunct, not part of the key), so it proved "this process minted this token
 * for SOME lock" and never "for THIS lock". Demonstrated: a byte-for-byte copy
 * of this process's own live owner file, planted at a DIFFERENT project's lock
 * path, was accepted as self-contention and the transaction ran with no hold at
 * all, in 1 ms. Writing that file needs nothing but write access to the other
 * project — the same access the whole lock is defending against — and the
 * failure is silent, which is strictly worse than what the branch replaced: a
 * bogus owner file used to cost a stall and a loud throw.
 *
 * A dev+ino pair has none of that shape. It is spelling-independent, which is
 * the entire point of the branch; it is LOCK-SPECIFIC, which a token is not;
 * and it needs no argument about pid reuse, token entropy or token
 * confidentiality, because it is not a claim anybody can make about themselves.
 * Forging it means making a second path resolve to the same directory inode,
 * which is a hardlinked directory or a mount — not something a writer of files
 * can do.
 *
 * A SYMLINK IS SOMETHING A WRITER OF FILES CAN DO, and an earlier draft of this
 * docblock dismissed it on a premise that is false as measured: it claimed
 * `rename` onto a symlink replaces it and succeeds, so a planted link could
 * never collide. `rename(dir, symlink-to-dir)` fails ENOTDIR on APFS
 * (__tests__/lock-identity-symlink.test.ts drives it), so the rename fails, the
 * loop reads contention, and the planted link reaches this branch on the FIRST
 * attempt. With a link-following stat the identity of project B's lock path is
 * the identity of whatever A's directory the link names, so holding A made B's
 * transaction re-enter with nothing held for B, in 1 ms, silently — the same
 * bypass as the token pair, in the same shape, reintroduced by the key that
 * closed it. Both halves of the repair are below: identity is taken with
 * `lstatSync`, so the link's OWN inode is what gets compared and it is never one
 * this process holds, and a planted NON-DIRECTORY is removed on contention
 * rather than spun against, because nothing in this protocol ever creates one
 * and the alternative is a permanent wedge (see `clearStrayLockObject`).
 *
 * The one residual: an inode freed and recycled to a different directory while
 * we believe we hold it. Reaching that state requires deleting the lock
 * directory this process is holding — which has already broken the lock, by a
 * route the branch below is not what defends against. APFS issues file ids
 * monotonically and did not recycle one in 200 create/delete cycles, but that is
 * a property of one filesystem: ext4, which CI and containers run on, reuses
 * inode numbers aggressively.
 */
const heldLockIds = new Set<string>();

interface LockObservation {
  /** `<dev>:<ino>` of the object AT the lock path. Null when it cannot be
   *  lstat'd — absent (the rename raced a release), or unreadable. Never
   *  guessed: a missing identity means the caller must not treat the collision
   *  as its own. */
  readonly id: string | null;
  /** The lock path holds something that is NOT a directory. Never something this
   *  protocol produced: every acquisition renames a directory into place. False
   *  when nothing could be lstat'd, because there is then nothing to clear. */
  readonly nonDirectory: boolean;
}

/**
 * Identify whatever is AT the lock path by what it IS, WITHOUT following a
 * symlink.
 *
 * `lstatSync`, and this is the whole security property of `heldLockIds` rather
 * than a detail: `statSync` resolves the link, so a link planted at project B's
 * lock path naming project A's lock directory reports A's inode, and a process
 * holding A re-enters for B with nothing held for B. The link's own inode can
 * never be in `heldLockIds`, because the only ids added there are of the staging
 * directory this process created and renamed into place itself, observed BEFORE
 * that rename (see the acquisition loop).
 *
 * The kind is asked as "not a directory" rather than "is a symlink" for the same
 * reason `clearStrayLockObject` clears that whole class: the protocol's only
 * product here is a directory, so every other kind is equally foreign and
 * equally wedging.
 */
function observeLockPath(lockPath: string): LockObservation {
  try {
    const stat = fs.lstatSync(lockPath, { bigint: true });
    return { id: `${stat.dev}:${stat.ino}`, nonDirectory: !stat.isDirectory() };
  } catch {
    return { id: null, nonDirectory: false };
  }
}

/**
 * Remove a NON-DIRECTORY planted at the lock path, so acquisition can proceed.
 *
 * Unconditional, with no liveness or staleness test, because unlike every other
 * thing this file reaps a non-directory here carries no protocol meaning at all:
 * the handshake stages in a sibling `.pending` dir and renames a DIRECTORY into
 * place, so a file at the lock path is never a lock, never an in-flight
 * acquisition, and never anything a live holder would miss. It is also not
 * merely inert. `rename(dir, non-dir)` fails ENOTDIR, and neither reaper can
 * touch it — `reapObservedLock` needs a readable owner file, `reapAbandonedLock`
 * needs a readable DIRECTORY — so every acquisition of this project spins the
 * full timeout and throws out of a hook, forever. That is a denial of service on
 * the very recovery path a wedged project needs, and the cheapest case costs one
 * byte: MEASURED, a `touch`ed regular file, a hard link to one, and a FIFO each
 * produced the identical permanent refusal that a planted symlink did. Removing
 * the object costs a wedged project nothing it had.
 *
 * SCOPED BY `unlink`, WHICH REFUSES A DIRECTORY, and that is the guard rather
 * than a coincidence of the syscall. The observation above and this call are two
 * operations on a re-resolved PATH, not on the observed inode, so the window
 * between them is real: an object cleared here may not be the object observed.
 * What makes that harmless is precisely that `unlinkSync` fails EPERM/EISDIR on
 * a directory, so a lock directory that a live holder renamed into the window
 * survives. A recursive remove would pass the same tests and delete it —
 * __tests__/lock-identity-symlink.test.ts drives that race so the narrow call is
 * pinned rather than assumed.
 *
 * Best-effort by design: a concurrent acquirer may be removing the same object,
 * and losing that race just means the next iteration of the retry loop finds a
 * directory instead.
 */
function clearStrayLockObject(lockPath: string): boolean {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

// A collision with a lock this very process already holds, reached under a
// second spelling of the project root. Not a lease: there is nothing to release,
// because the frame that took the lock is still above us on the stack.
const REENTRANT = Symbol('traffic-one.project-state-lock.reentrant');

type Rec = Record<string, unknown>;

function record(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Rec
    : null;
}

// A valid on-disk id is immutable. This is deliberately applied only after the
// writer has acquired the shared lock and re-read the current file, so a stale
// whole-state snapshot cannot delete the id or replace it with another UUID.
export function preserveOneMcpReportId(current: unknown, replacement: unknown): Rec {
  const next = record(replacement) ? { ...(replacement as Rec) } : {};
  const rawCurrentId = record(current)?.[ONE_UID_FIELD];
  const currentId = typeof rawCurrentId === 'string' ? rawCurrentId.trim() : rawCurrentId;
  if (isValidOneMcpReportId(currentId)) next[ONE_UID_FIELD] = currentId;
  return next;
}

// Normalize a currentRunId value (epoch-ms string, or a legacy number) to a
// non-empty trimmed string, or '' when absent/blank.
function runIdValue(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.trunc(raw));
  return '';
}

// currentRunId is the build/maintenance run pointer. UNLIKE the immutable
// one-mcp report id, it legitimately CHANGES when a new run is minted (build
// onboarding, or a maintenance-triage rotation) — so we must NOT freeze it.
// We preserve it ONLY when the incoming replacement carries no id: a stale
// whole-state snapshot (read before the id was minted, then written back under
// the lock by a concurrent .one.json writer) must never BLANK a live
// currentRunId. Blanking it makes the next run claim mint a SECOND run —
// observed 11c: the run-id-announce hook broadcast run A while the claim minted
// run B, so the announced id and the enforced id diverged. A replacement that
// DOES carry an id (including a freshly-minted rotation id) is returned
// untouched, so legitimate run rotation still flips the pointer. Applied only
// after the writer holds the shared lock and re-read the on-disk `current`.
//
// ── WHEN THIS CAN GO, measured rather than assumed ──────────────────────────
// Three production call sites, and only ONE of them can ever do anything. What
// decides it is not the site, it is where the REPLACEMENT's base read happened:
// this function is a one-field patch applied inside the lock, so it is a no-op
// whenever the replacement's own base was also read inside the lock.
//
//   state/normalize.ts writeState        LOAD-BEARING. The replacement is the
//     caller's whole-object snapshot, and every caller spells it
//     `writeState(cwd, { ...readState(cwd), ...patch })` — read OUTSIDE the
//     lock. Mutation-proven: dropping the call turns
//     state-merge-and-durability.test.ts "writeState never blanks a live
//     currentRunId (F1 lost-update)" red.
//   runners/security-check/report.ts     NO-OP. `current` is `{ ...state }`
//     where `state` is the in-lock read that is then mutated in place, so the
//     replacement always already carries the on-disk id. Dropping the call
//     leaves the suite green, which agrees with the static argument.
//   runners/one-mcp-report/lib.ts        NO-OP THROUGH ITS ONLY CALLER.
//     `writeProjectState` is exported, but report-id-mint.ts `createReportId`
//     is the sole caller and takes its base from `readProjectState(cwd)` inside
//     the same re-entrant lock hold. Defensive against a future caller that
//     does not; dead against today's.
//
// So removal is gated on ONE thing: the last whole-object writer of
// `.one.json` whose base read happens outside the lock. That is patchState's
// job (see its doc in normalize.ts) — not, as it is sometimes framed, on moving
// currentRunId into a separate runtime file. Moving the field WOULD also retire
// this function, but it is the more expensive of the two routes and it buys a
// second artifact that can land alone.
export function preserveCurrentRunId(current: unknown, replacement: unknown): Rec {
  const next = record(replacement) ? { ...(replacement as Rec) } : {};
  if (runIdValue(next.currentRunId)) return next; // replacement carries an id (possibly a legit new one)
  const currentId = runIdValue(record(current)?.currentRunId);
  // Rescue is the only arm that publishes an on-disk id the replacement never
  // saw. writeState already canonicalize's a replacement that CARRIES an id;
  // a planted `foo/../bar` on disk would otherwise be re-persisted verbatim
  // when some other field is written.
  if (currentId) next.currentRunId = safeRunIdSegment(currentId);
  return next;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    if (sleepArray === undefined) sleepArray = new Int32Array(new SharedArrayBuffer(4));
    if (sleepArray) {
      Atomics.wait(sleepArray, 0, 0, ms);
      return;
    }
  } catch {
    // SharedArrayBuffer/Atomics.wait can be unavailable in restricted hosts.
    sleepArray = null;
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { /* bounded spin */ }
}

// `readOwnerEntry` — the bounded, allowlisted read all three readers below go
// through — MOVED to shared/bounded-read.ts, unchanged, when one-settings.ts's
// structurally identical readers turned out to still call bare `readFileSync`
// and to hang on the same planted FIFO. The argument for every flag, the
// measurements that produced it, and why the `fstat` is not redundant with them
// all travel with the function; read it there before changing a caller here.

function observedLockOwner(lockPath: string): ProjectStateLockOwner | null {
  try {
    const names = fs.readdirSync(lockPath);
    if (names.length !== 1) return null;
    const ownerName = names[0]!;
    const ownerPath = path.join(lockPath, ownerName);
    // Anything but a regular file is not a record this protocol wrote, so the
    // strict reader refuses it exactly as it refuses unparseable bytes — and the
    // abandoned arm below is what then decides, on presence plus age.
    const bytes = readOwnerEntry(ownerPath);
    if (bytes === null) return null;
    const raw = JSON.parse(bytes) as Record<string, unknown>;
    const token = typeof raw.token === 'string' ? raw.token : '';
    const pid = typeof raw.pid === 'number' ? raw.pid : Number.NaN;
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Number.NaN;
    if (!token || !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAt)
      || ownerName !== `owner-${token}.json`) return null;
    return { ownerPath, token, pid, createdAt };
  } catch {
    return null;
  }
}

/**
 * EPERM IS ALIVE, and the residual that buys is written down rather than left to
 * be rediscovered.
 *
 * `kill(pid, 0)` answers EPERM for a pid this uid may not signal, which is what
 * a genuine cross-uid holder looks like, so reading it as ALIVE is what keeps the
 * shared-checkout deployment's mutual exclusion honest — it is why the three
 * cross-uid rows of the P1 probe refuse rather than steal.
 *
 * THE COST IS THAT LIVENESS HAS NO OUTER BOUND, and it is now the ONLY guard on
 * either reap arm: `reapObservedLock`'s arm needs `!processAlive(owner.pid)` and
 * nothing else (the age conjunct that used to stand beside it is gone — see the
 * arm), and `reapAbandonedLock` refuses on `livePid` before it looks at
 * anything. A pid RECYCLED onto a process this uid cannot signal therefore makes
 * that project's lock permanently unreclaimable, with no recovery path in this
 * file — measured with a planted owner naming pid 1: refused after 1008 ms and
 * thrown, with the record aged six stale windows. The recovery is manual (remove
 * the lock directory), and the trade is deliberate: the alternative is a reclaim
 * that takes a live cross-uid holder's lock on a timer. Removing the age
 * conjunct did not widen this: an age could only ever DELAY such a reclaim, and
 * the EPERM-is-alive reading above is what refuses it outright.
 *
 * The unreadable-owner age gate in `reapAbandonedLock` does NOT change this and
 * deliberately does not extend to it. That gate covers the case with NO liveness
 * evidence in either direction, where an outright refusal would be an unbounded
 * wedge; this one has positive evidence of a live holder, and putting an age over
 * the top of it would re-open exactly the cross-uid theft the same repair closed.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reclaim the lock of a legible owner that is provably gone.
 *
 * `unlinkSync(owner.ownerPath)` is the COMPARE-AND-SWAP and the exact-name is
 * the whole of it — the same rule as run-agent/locks.ts's
 * `reclaimStaleOwnedDirLock`. A second reaper that read the same sentinel raises
 * ENOENT here and reports that it did nothing; a NEW owner's lease carries a
 * different random token, so this unlink cannot name it and the `rmdir` below
 * then fails ENOTEMPTY against it. Both are properties of removing the thing
 * that was OBSERVED rather than the path it was observed at, and the path is
 * re-resolved between the two, so the window is real.
 *
 * MEASURED, deterministically, with a competing acquirer's legitimate sequence
 * (reap, stage, rename a directory carrying its own owner file) injected into
 * the window between `processAlive` and this call: refused in 1003 ms with the
 * competitor's owner file intact. Replacing these two calls with
 * `rmSync(lockPath, { recursive: true })` — the R7 mutant that survived the
 * suite — acquires in ~40 ms having deleted that owner file, i.e. two processes
 * inside one `.one.json` transaction. __tests__/lock-identity-symlink.test.ts
 * drives both arms of that probe, so the narrow calls are pinned rather than
 * assumed.
 *
 * THE ORDER — sentinel first, directory second — IS NOT REVERSIBLE, and the
 * state it can leave behind is answered at the consumer instead. `rmdir` refuses
 * a non-empty directory, so the sentinel has to go first; and the sentinel is
 * what the CAS is keyed on, so there is no third spelling (a rename aside is a
 * single step but is keyed on the PATH, which is exactly the defect above). What
 * the order costs is that a stray landing between the two lines leaves a
 * directory with no owner evidence and an mtime freshly stamped by the unlink
 * itself. That was unreclaimable for a full stale window because the abandoned
 * arm substituted the directory's mtime for a missing stamp; it is reclaimable at
 * once now that the arm consults no age at all — see `reapAbandonedLock`. The
 * ordering was the wrong end of that defect to fix.
 */
function reapObservedLock(lockPath: string, owner: ProjectStateLockOwner): boolean {
  try { fs.unlinkSync(owner.ownerPath); } catch { return false; }
  try {
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isOwnerName(name: string): boolean {
  return name.startsWith('owner-') && name.endsWith('.json');
}

/**
 * Remove EXACTLY the entries an evidence read observed, then the directory
 * itself — the compare-and-swap for every reclaim that is not keyed on a single
 * sentinel.
 *
 * `rmSync(dir, { recursive: true })` is what this replaces, and the difference
 * is mutual exclusion rather than tidiness: a recursive remove is keyed on the
 * PATH, so two ordinary contenders that both judge one abandoned lock
 * reclaimable will, when the loser's remove lands after the winner's rename,
 * delete a live holder's directory and its owner file and then acquire.
 * MEASURED HERE — not inherited: this lane's own probe, run against a variant
 * carrying the recursive remove back, unaided, real processes, no interception.
 * 2 000 contended acquisitions over 250 barriered rounds produced 72 overlapping
 * hold intervals and 82 directly detected steals — a holder whose own lock
 * directory changed inode AND lost its own owner file during its own critical
 * section — against 0 of each in a run with no abandoned lock to race for. The
 * overlap count is ALL PAIRS. An earlier pass of this same probe walked only
 * ADJACENT holds in the sorted list and reported 42; re-run with the detector
 * fixed, the same fixture reports 72 where the adjacent walk would still say 63,
 * because a round with k mutually overlapping holders contributes k−1 adjacent
 * pairs and k(k−1)/2 real ones. Every adjacent-only figure understates.
 *
 * With the removal below: 0 overlaps and 0 steals across 10 000 contended
 * acquisitions in six runs of the same fixture, and 0 of each in the unseeded
 * control beside them. Re-run this round at load 62: 160 contended acquisitions,
 * 0 overlaps, 0 steals, 0 lease-less bodies, 0 misses.
 *
 * AND THOSE TWO NUMBERS ARE NOW THE PROBE'S EXIT CODE, which they were not when
 * this paragraph was first written. The status line read `impure.length ||
 * unparsed`, so `noLease` reached the printed verdict but not the status and the
 * overlap and steal counts reached neither — the entire argument here rested on a
 * human reading a console line. Both counts, plus a lease-less body, now fail the
 * run, and the instrument has a self-test that injects one of each and asserts the
 * status flips (verified: exit 1 with the three findings named, exit 0 on the same
 * fixture without them).
 *
 * THE `0 misses` THAT USED TO BE RECORDED HERE IS THE FIXTURE, NOT THE LOCK. A
 * miss is an acquisition that never got in before ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS,
 * so it is decided by how long holders hold, and this fixture's critical section
 * is ~12 ms. Same probe, same 8 contenders, same 250 rounds, only the critical
 * section made heavy: median hold 394 ms, and 1 303 of 2 000 attempts missed —
 * against 0 misses in the light run. Both runs report 0 overlaps and 0 steals,
 * which is the useful shape of the result: saturation costs LIVENESS and takes
 * nothing from mutual exclusion. Do not read a miss count from this file as a
 * property of the lock.
 *
 * The two halves that make it a CAS:
 *   - only OBSERVED names are removed, and an owner name carries a random token,
 *     so a replacement lease minted in the window is never one of them;
 *   - the directory goes by `rmdir`, which REFUSES a non-empty one, so a
 *     replacement lease that arrived in the window stops the reclaim dead and
 *     this reaper reports that it did nothing.
 * Both are re-resolutions of the PATH, deliberately: the window between the
 * evidence read and these calls cannot be closed, so what has to hold is that
 * landing in it is harmless.
 *
 * Each entry goes recursively rather than by `unlink`, which is the ONE place
 * this diverges from the sibling's rule, and it is the divergence this port
 * exists for: the sibling leaves a directory at the sentinel path unreclaimable
 * on purpose because no writer of ITS produces one, while this reaper's whole
 * population is entries no writer of ours produced (a Finder `.DS_Store`, a
 * backup sidecar, a crashed sibling's second owner file). Refusing the kinds
 * `unlink` cannot take would re-open the permanent wedge for a subdirectory
 * exactly as the emptiness precondition did for a stray file. It is still only
 * names that were observed.
 */
function removeObservedDir(dirPath: string, entries: readonly string[]): boolean {
  for (const name of entries) {
    // Best-effort per entry: ENOENT means a racing reaper got there first, and
    // anything else leaves the directory non-empty, which the `rmdir` below
    // reports honestly rather than forcing.
    try { fs.rmSync(path.join(dirPath, name), { recursive: true }); } catch { /* not ours to remove */ }
  }
  try {
    fs.rmdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

/** What a lock directory `observedLockOwner` refused still says about itself. */
interface IllegibleLockEvidence {
  /** Some `owner-*.json` in it yields an integer pid that is still running. */
  readonly livePid: boolean;
  /** Some `owner-*.json` in it is THERE and could not be READ — every errno but
   *  ENOENT. Evidence of a holder's PRESENCE with no liveness evidence either
   *  way, which is a different claim from `!livePid` and must not reclaim on the
   *  same terms; see `reapAbandonedLock`. */
  readonly unreadableOwner: boolean;
  /** Every name the listing produced — EMPTY when the directory could not be
   *  read at all. This is the set a reclaim may remove and nothing else; see
   *  `removeObservedDir`. */
  readonly entries: readonly string[];
}

/**
 * The evidence that survives in a lock directory the strict owner reader threw
 * away — which is the whole population this reaper is asked about.
 *
 * `observedLockOwner` answers null for FIVE different worlds at once: no entries,
 * more than one entry, a name that is not `owner-<token>.json`, bytes that are
 * not JSON, and a record missing a field. Only ONE of the reaper's questions
 * survives that, and it is the one that protects a holder: a PID decides
 * liveness, so it is read from ANY owner-named file here, however malformed the
 * rest of the record is. A directory that picked up a `.DS_Store` beside a LIVE
 * owner keeps its lock, which is what stops this widening from stealing one.
 *
 * A FAILED READ IS NOT A MISSING OWNER, and folding the two together is what
 * this function used to do: one `catch { continue; }` covered a `readFileSync`
 * that raised EACCES and a `JSON.parse` that rejected the bytes, so an owner file
 * this uid MAY NOT READ scored as evidence of ABSENCE and `reapAbandonedLock` —
 * which consults no liveness evidence but this — took a live holder's lock in
 * 51 ms (driven, load 148.71; the legible control refused for the full 1011 ms
 * beside it). The split is run-agent/locks.ts `readOwnedLock`'s, verbatim in
 * intent: "every errno but ENOENT is a sentinel that is THERE and unreadable,
 * which is not the same claim as 'no sentinel'". EACCES, EPERM, EISDIR (an
 * owner-named DIRECTORY, which reads as a steal too before this split) and a
 * networked home's transient ESTALE/EIO all land on the same side.
 *
 * ENOENT STAYS ON THE ABSENCE SIDE AND NOW MEANS ONLY WHAT IT SAYS, which is
 * what `readOwnerEntry`'s `O_NOFOLLOW` buys here. The justification for keeping
 * it there is about "a name that vanished between the listing and the read" — a
 * transient, and a correct one: that state was driven with the interception
 * verified as having fired, is reclaimed at once, and is unreachable through the
 * protocol anyway, because only a release removes an owner file and a release
 * renames the whole directory. But a DANGLING SYMLINK is ENOENT that does not
 * vanish. It was reclaimed in 511 ms with no age gate at all — a persistent
 * state scored as a transient one, by the same conflation this function was
 * repaired for, one layer down. Under `O_NOFOLLOW` the open never resolves the
 * link, so a dangling one raises ELOOP and lands on the presence side with every
 * other link, and ENOENT is left meaning "there is no entry at this name". The
 * sibling `readOwnedLock` separates the same two cases with an `lstat` after the
 * fact; refusing to follow is the same distinction taken one call earlier, where
 * it cannot be raced.
 *
 * A name that DOES vanish still costs one retry tick and nothing else, for the
 * reason the sibling's own `lstat` exists to avoid needing: this evidence feeds
 * `removeObservedDir`, whose `rmdir` refuses the moment a replacement lease
 * lands.
 *
 * NO STAMP IS READ HERE, and the one arm that needs an age reads the LOCK
 * DIRECTORY's own mtime instead — see `reapAbandonedLock` for which shape needs
 * one and why the other shapes must not have one. The listing itself is carried
 * because the set of names that were OBSERVED is what the reclaim may remove.
 */
function illegibleLockEvidence(lockPath: string): IllegibleLockEvidence {
  let names: string[];
  try { names = fs.readdirSync(lockPath); } catch { return { livePid: false, unreadableOwner: false, entries: [] }; }
  let livePid = false;
  let unreadableOwner = false;
  for (const name of names) {
    if (!isOwnerName(name)) continue;
    let bytes: string | null;
    try {
      bytes = readOwnerEntry(path.join(lockPath, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadableOwner = true;
      continue;
    }
    // THERE and not a regular file: presence with no liveness evidence either
    // way, which is the same verdict an unreadable file gets and for the same
    // reason — nothing about a holder can be learned, and it was not opened.
    if (bytes === null) {
      unreadableOwner = true;
      continue;
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(bytes) as Record<string, unknown>;
    } catch {
      continue;
    }
    const pid = raw.pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && processAlive(pid)) livePid = true;
  }
  return { livePid, unreadableOwner, entries: names };
}

/**
 * Reclaim a lock directory no legible owner is holding — WITHOUT requiring it to
 * be empty.
 *
 * The emptiness precondition this replaces was the second half of the wedge
 * `clearStrayLockObject` closes for non-directories, and it needed no attacker
 * at all. `observedLockOwner` refuses any directory whose listing is not exactly
 * one correctly-named parseable owner file, so an ABANDONED lock that picked up
 * one stray entry — a Finder `.DS_Store`, a backup agent's sidecar, a crashed
 * sibling's second owner file — fell through to a reaper that then demanded the
 * directory be empty. MEASURED: the same abandoned lock with a dead owner is
 * reclaimed in 79 ms with nothing beside it and refuses forever with one zero-
 * byte file beside it. This is the lock every session start takes.
 *
 * WHAT IS TAKEN FROM run-agent/locks.ts's `reclaimStaleOwnedDirLock` IS THE
 * COMPARE-AND-SWAP, and it is stated that narrowly because the rest of that
 * function's rule is deliberately NOT reproduced here. The sibling reclaims a
 * zero-sentinel directory only when it is EMPTY and only through a `.reaper`
 * CAS; this one reclaims a non-empty directory with no owner evidence at all,
 * which is the wedge measured above and the reason this reaper exists. The two
 * agree on what protects a holder — a pid that answers `kill(pid, 0)` — and on
 * removing only what was observed (`removeObservedDir`). They disagree on
 * everything the emptiness precondition decided. Saying "the rule is the
 * sibling's" without that qualification was false in both places that decide
 * correctness, and one of them was this reaper deleting live holders' locks.
 *
 * NO AGE IS CONSULTED EXCEPT ON ONE SHAPE, and the exception is the whole of the
 * repair below — read it with the rule, because the rule without it stole a live
 * holder's lock and the exception without the rule re-arms a permanent wedge.
 *
 * Dropping the age everywhere else is the CAS's dividend rather than a
 * loosening. An age was the last guard only while the removal could destroy a
 * lease it had not seen; with `removeObservedDir` a holder that arrives mid
 * decision keeps its lock BY CONSTRUCTION — its owner file is not a name this
 * reaper observed, so the `rmdir` refuses. What the age cost, meanwhile, was
 * real and reachable without an adversary: the refusal was re-armed by ANY
 * modification of the directory, because the substitute stamp was the
 * directory's own mtime, and the product manufactured exactly that state —
 * `reapObservedLock` unlinks the sentinel and then `rmdir`s, so a stray landing
 * between the two leaves a directory with no owner evidence and a freshly
 * stamped mtime. RE-DERIVED on that shape against the age-guard variant, three
 * reps each, load average 56: every acquisition threw out of a hook after
 * 1014–1039 ms against an mtime age of 3, 4 and −1 ms (birthtime age 60 s
 * throughout, so the lock was an hour stale by the only clock that means
 * anything), for a full ONE_MCP_REPORT_ID_LOCK_STALE_MS window after each
 * touch; shipped reclaims the same shape and acquires in 56–81 ms. Both figures
 * are wall clock on a loaded host and only the ORDER OF MAGNITUDE between them
 * is the claim — an earlier run of this same comparison recorded 1005 ms and
 * 20–35 ms. What does not move with load is the sign of the mtime age: it is
 * ~0 by construction, because the touch that re-armed the refusal is the same
 * event that made the lock reclaimable. The one state an age could still
 * have protected — a LIVE holder whose own owner file became illegible — WAS
 * argued to be unreachable through this protocol, on the grounds that the owner
 * file is written INTO the staging directory before the atomic rename, so a lock
 * at the lock path is complete from the instant it exists. That argument covers
 * a TORN write and nothing else. It does not cover a PERMISSION-illegible owner
 * file, which is exactly the case the mode docblock below treats as a supported
 * deployment: the two paragraphs assumed different numbers of uids, and the one
 * that was wrong is this one. DRIVEN, load 148.71: a live holder with a fresh
 * record and an owner file this uid may not read lost its lock in 51 ms, while
 * the identical control with the read bit on refused for 1011 ms and survived.
 * Reachable without an adversary — an ACL, a hardening pass that runs
 * `chmod -R g-r` over files, a transient ESTALE/EIO on a networked home in CI.
 *
 * THE FIX IS THE SIBLING'S SHAPE, NOT AN OUTRIGHT REFUSAL, and the difference is
 * the whole of the design. run-agent/locks.ts `reclaimStaleOwnedDirLock` reaches
 * three verdicts, not two: a readable pid lets LIVENESS decide, so a running
 * holder keeps its lock; a record with no pid at all falls back to AGE; and an
 * unreadable sentinel is never scored as an absent one. But it is still
 * RECLAIMABLE, gated on age alone, because refusing outright "costs every later
 * acquirer its entire timeout, on every attempt, for the life of the directory —
 * and the directory outlives the process that made it, so there is no self-heal
 * and no escape". Mapping an unreadable owner to "assume live" buys mutual
 * exclusion by installing precisely that wedge, which is the trade the mode
 * docblock below has already ruled against in the other direction.
 *
 * So: presence without liveness evidence is reclaimable, but only after the lock
 * directory has outlived ONE_MCP_REPORT_ID_LOCK_STALE_MS. The stamp is the lock
 * directory's own mtime, which is the mkdir plus the owner-file write of the
 * staging dir the acquirer renamed into place — `rename` moves a directory
 * without touching its mtime — so it dates the lease as faithfully as the
 * sentinel would have, and a reader cannot corrupt it the way it can corrupt the
 * record's own field.
 *
 * THE MTIME OBJECTION THAT REMOVED THE AGE DOES NOT REACH THIS ARM, and that is
 * why the exception is narrow rather than a partial revert. What made an mtime
 * age wrong here was the shape the product manufactures itself: `reapObservedLock`
 * unlinks the sentinel and then `rmdir`s, so a stray landing between the two
 * leaves a directory with NO owner evidence and an mtime freshly stamped by the
 * unlink — refusal re-armed by the very event that made the lock reclaimable, for
 * a full stale window after every touch. That shape has no owner-named entry at
 * all, so `unreadableOwner` is false and it is still reclaimed at once (driven:
 * 57 ms). The age applies only where an owner file was OBSERVED and could not be
 * read, and there a re-stamp is bounded: the refusal expires on its own after one
 * stale window with no further event, so there is no permanent wedge and no
 * directory that outlives its own recovery.
 *
 * AN UNUSABLE AGE DOES NOT VETO, the same fold this file already applies at the
 * owner arm and at `reapAbandonedPendingDirs`: a stat that fails, or an mtime a
 * stepped clock put in the future, authorizes the reap rather than blocking it.
 * The cost is that the steal above reopens for a holder whose lock directory
 * carries a future mtime; the alternative is the mirror failure this repo has
 * ruled on twice (see clock-skew.ts) — a negative age reads as brand new
 * forever, so one bad stamp makes the lock unreclaimable for the life of the
 * directory.
 */
function reapAbandonedLock(lockPath: string): boolean {
  const evidence = illegibleLockEvidence(lockPath);
  // No pid, no liveness claim — but a pid that answers `kill(pid, 0)` is proof.
  // An unparseable owner file whose process is still running keeps its lock.
  if (evidence.livePid) return false;
  if (evidence.unreadableOwner) {
    let ageMs: number | null;
    try { ageMs = trustworthyAgeSince(fs.statSync(lockPath).mtimeMs, Date.now()); } catch { ageMs = null; }
    if (ageMs !== null && ageMs <= ONE_MCP_REPORT_ID_LOCK_STALE_MS) return false;
  }
  return removeObservedDir(lockPath, evidence.entries);
}

/**
 * `path.resolve`, NOT `realpathSync` — deliberately, and this is the line an
 * earlier plan wanted changed: "canonicalize the project root once (realpathSync
 * plus case normalization) and derive all lock paths from it — /var vs
 * /private/var, symlinks and case-insensitive APFS produce different lock paths
 * for the same state file, silently voiding mutual exclusion."
 *
 * The premise is right and the conclusion does not follow. Two spellings do
 * produce two lock path STRINGS; they name one INODE, and this lock is a
 * filesystem compare-and-swap, so the kernel refuses the second acquirer
 * whichever spelling it used. The compare-and-swap is `rename` onto a NON-EMPTY
 * directory, and the qualifier is load-bearing rather than pedantic: renaming
 * onto an EMPTY directory SUCCEEDS (driven in
 * __tests__/lock-path-spelling-exclusion.test.ts). What keeps a held lock
 * non-empty is that every acquirer writes its owner file INTO the staging dir
 * before the rename — so the CAS is a property of the handshake, not of
 * `rename`. `reapAbandonedLock` below used to lean on the same asymmetry from
 * the other side and treat it as a feature; it no longer needs to, because a
 * non-empty abandoned lock is exactly the wedge it now reclaims. Reproduced
 * before deciding, macOS/APFS, two real processes on a shared start instant
 * holding 700 ms each: 3 spellings (/private/var vs /var, a symlink at the
 * project root, a case variant) x 3 lock families (here, run-agent/locks.ts,
 * qa-evidence/lock.ts) = 9 races, 9 exclusive, against a two-different-
 * directories control that overlapped for the full 700 ms every time.
 * __tests__/lock-path-spelling-exclusion.test.ts pins a PROPER PART of that
 * measurement, and says so in its own header: one lock family, in one process,
 * across four spelling hazards. The two-process, three-family, three-spelling
 * matrix above is the reproduction that decided the question and is not what
 * that file re-runs.
 *
 * Canonicalizing HERE would make it worse, not merely redundant. What makes
 * exclusion sound is that this path is a pure string derivation of the file it
 * protects — `writeState` writes `path.join(path.resolve(cwd), STATE_FILE)` and
 * this appends a suffix to that same expression — so a divergent spelling moves
 * the lock and the protected file together and the kernel folds both. Resolving
 * one and not the other replaces that structural guarantee with a coincidence,
 * and `realpathSync` additionally throws on a path that does not exist yet,
 * which onboarding hits before anything is created.
 *
 * The one real cost of a divergent spelling was `heldLocks` below, whose key IS
 * this string: a nested acquisition under a second spelling missed the memo and
 * spun to the deadline (measured, four hazards: ~1005 ms then a throw, versus
 * 1 ms for the same spelling). It is now answered where the collision happens —
 * see the self-contention branch in the retry loop, which identifies the
 * directory it collided with by dev+ino and re-enters when that is a lock this
 * process already holds. Spelling-independent for the same reason the exclusion
 * argument above is: two spellings name one inode. It also cannot throw on a
 * path that does not exist yet, which is the second reason canonicalizing here
 * is unavailable rather than merely redundant.
 *
 * The import-closure proof in __tests__/path-spelling-contract.test.ts is
 * therefore no longer load-bearing, and it is kept anyway, demoted to an early
 * warning: a lock body that gains the ability to re-derive a project root is
 * worth knowing about for reasons beyond this deadline. It also has two halves
 * now, because the resolvers were never the only minters — the closure holds two
 * dozen realpath-family calls — so the second half pins that every acquisition
 * site is handed a threaded identifier rather than an expression derived on the
 * spot. The edge that used to make the proof over-approximate is gone:
 * runners/traffic-one-reset is split into a CLI entry that owns the resolution
 * and a transaction module that takes `cwd` and never derives one.
 */
function projectStateLockPath(cwd: string): string {
  return `${path.join(path.resolve(cwd), STATE_FILE)}.report-id.lock`;
}

/**
 * Reap the sibling directories of the lock path that a dead hook process left:
 * `<lock>.<token>.pending` staging dirs and `<lock>.<token>.released` dirs.
 *
 * The mkdir-then-rename handshake stages every acquisition in a sibling
 * `.pending` dir, and the only thing that removes one is the `finally` in
 * `withProjectStateLock` — which does not run when the host kills the process.
 * `reapAbandonedLock` cannot help: it reaps the lock path itself, and neither of
 * these is one. Measured on one 16co run: 22 orphans, each with a live-looking
 * owner. Harmless to acquisition, but it litters the user's project and it is
 * what made `.traffic-one` look like it was growing directories at random.
 *
 * `.released` IS THE SAME ORPHAN ONE STEP LATER and used to match no prefix at
 * all: `releaseProjectStateLock` renames the held lock aside and THEN removes it,
 * so a process that dies between those two lines leaves a directory this
 * function walked straight past. It is reaped on the same terms rather than on
 * looser ones, even though the lock it came from is already gone: the owner file
 * inside it still carries the releaser's pid, and a releaser that is alive is
 * about to remove the directory itself (with `force`, so racing it is harmless).
 *
 * Deliberately conservative, and the two guards are not the same guard:
 *
 *   - LIVENESS comes from `illegibleLockEvidence`, i.e. from ANY owner-named
 *     file, not from the strict reader. The strict reader refuses a listing
 *     that is not exactly one parseable owner file, so a live acquirer whose
 *     staging dir picked up a stray read as "no owner" — which, now that the
 *     removal below actually works, would have removed a LIVE acquisition's
 *     staging directory and made its own rename fail ENOENT. That errno is not
 *     in the contended set, so it throws out of a hook.
 *   - THE AGE is what authorizes a reap when no owner record is LEGIBLE, and an
 *     unusable age is not an authorization. An owner-less or MID-WRITE staging
 *     dir is exactly the mkdir→owner-file gap of a live acquisition; a torn
 *     owner file is that gap too, since `writeFileSync` publishes the entry
 *     before the bytes. Only a fully legible record lets death alone decide.
 *     THIS IS ALREADY THE SHAPE `reapAbandonedLock` HAD TO BE REPAIRED INTO, and
 *     it is why an UNREADABLE owner file needs no arm of its own here: the age
 *     gate above runs BEFORE any evidence is read, so a live acquirer whose owner
 *     file this uid may not read is protected by being young rather than by being
 *     legible, and the null-age refusal on the next line covers the skewed case.
 *     An orphan that is BOTH older than a stale window and unreadable is litter —
 *     an acquisition is bounded by ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS, a tenth of
 *     that window — and refusing it would be the permanent wedge, since this
 *     function is the only thing that removes one.
 *     The age is a DIRECTORY mtime, so what stamps it is the last write INTO the
 *     staging dir — the owner file — and not its `mkdirSync`, which the mtime no
 *     longer records once an entry has been added. Nothing follows from the
 *     correction here (both are the same acquisition, microseconds apart in the
 *     shipped path) and it is written down because the mechanism was named one
 *     step off, which is how an age argument goes wrong somewhere it does
 *     matter.
 *
 * ── THE `now` IS THE FILESYSTEM'S, NOT THIS PROCESS'S ───────────────────────
 *
 * And that is what makes the age gate above true rather than nearly true. Every
 * stamp this function compares is an mtime, written by whatever clock the
 * filesystem stamps with; `Date.now()` is this process's clock. Subtracting one
 * from the other measures the DISAGREEMENT between two clocks as if it were an
 * age, and the disagreement is a deployment property, not a fault: an
 * NFS-mounted home whose server runs ten seconds slow makes every staging dir on
 * it — including one created microseconds ago — read as older than a stale
 * window, while the acquirer's own 1 000 ms deadline is unaffected because it is
 * computed from `Date.now()` at both ends.
 *
 * DRIVEN, three reps each, load 82.49 → 88.00, with the reaper's process clock
 * set one stale window ahead of the filesystem's (which is what a slow server
 * looks like from a client, and unlike backdating an mtime it leaves the
 * VICTIM's own deadline alone, so the victim is healthy): a live acquirer's
 * staging dir 0.7–1.6 s old by the filesystem clock, with an owner file this uid
 * may not read, was DESTROYED 3/3 and its next rename then failed ENOENT — an
 * errno outside the contended set, i.e. a raw errno out of a hook, the
 * "plan-guard.write gate failed (EPERM)" wedge class those rows exist to
 * prevent. Both halves of that conjunction live in one deployment: the
 * unreadable half is the networked home this file's other docblock already cites
 * ("a transient ESTALE/EIO on a networked home in CI").
 *
 * So `now` is read from the mtime of the staging directory THIS acquisition just
 * created, which the filesystem stamped with the same clock as every orphan
 * beside it. Both sides of every subtraction below then come from one clock, and
 * a skew between the two clocks cannot make anything look old. `Date.now()`
 * remains the fallback for the one case that leaves — our own staging dir cannot
 * be stat'd — where a wrong age is better than no reaping at all, since that is
 * the state the 16co litter accumulated in.
 *
 * WHAT SURVIVES THIS, and it is bounded rather than argued away: a staging dir
 * genuinely older than a stale window by the FILESYSTEM's clock, unreadable, and
 * owned by a live process. That process has overrun its own 1 000 ms deadline
 * tenfold, and the loop tests that deadline immediately after every arm — so its
 * next act is its own timeout throw and it can never reach another rename. The
 * destruction can no longer convert a healthy acquirer into a raw errno; it can
 * only remove the staging dir of one that was already failing, which is what
 * this function is for.
 *
 * ADDING ENOENT TO THE CONTENDED SET IS NOT THE FIX AND IS DELIBERATELY NOT
 * DONE. It treats the symptom: the victim's staging dir and its owner file are
 * destroyed either way, so the acquisition cannot succeed, and all the
 * classification buys is that the failure is spelled as this loop's own timeout
 * after a further 1 000 ms of fruitless renames rather than as an immediate
 * ENOENT. Both are denials out of a hook. It would also cost the property the
 * errno-classification row pins — that the contended set is an allowlist, so
 * everything outside it ends the loop at once — for an errno that is not
 * contention in any reading.
 */
function reapAbandonedPendingDirs(lockPath: string, ownStagingPath: string): void {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  let now: number;
  try { now = fs.statSync(ownStagingPath).mtimeMs; } catch { now = Date.now(); }
  const ownStagingName = path.basename(ownStagingPath);
  for (const name of names) {
    if (!name.startsWith(prefix) || !(name.endsWith('.pending') || name.endsWith('.released'))) continue;
    // Never the acquisition this reap is part of. It is young by the clock above
    // BY CONSTRUCTION — that clock IS its mtime — so this skips nothing the age
    // gate would not; it is here because "the reaper never considers its own
    // staging dir" should be a property of the loop rather than an inference
    // about arithmetic.
    if (name === ownStagingName) continue;
    const orphanPath = path.join(dir, name);
    let orphanAgeMs: number | null;
    try {
      // A negative age reads as brand new forever, so the orphans this function
      // exists to remove would accumulate untouched — the 16co litter, back.
      orphanAgeMs = trustworthyAgeSince(fs.statSync(orphanPath).mtimeMs, now);
    } catch {
      continue;
    }
    if (orphanAgeMs !== null && orphanAgeMs <= ONE_MCP_REPORT_ID_LOCK_STALE_MS) continue;
    const owner = observedLockOwner(orphanPath);
    const evidence = illegibleLockEvidence(orphanPath);
    // ONE liveness test, not two. `(owner && processAlive(owner.pid))` used to
    // stand beside this and could not change an outcome: `observedLockOwner`
    // succeeds only on a listing of exactly one correctly-named parseable record
    // with an integer pid, which is a strict SUBSET of the files
    // `illegibleLockEvidence` reads a pid out of, so the second disjunct was true
    // only where the first already was. A mutant deleting it survived the fenced
    // suites, which is the honest description of a guard that cannot fire — it
    // was a second read of the same file, and it read `owner` back only to reach
    // the pid the evidence had already tested.
    if (evidence.livePid) continue;
    if (!owner && orphanAgeMs === null) continue;
    // The same compare-and-swap the lock path itself is reclaimed by, for the
    // same reason: the previous spelling removed the strict reader's ONE owner
    // file and then `rmdir`ed, so a stale staging dir carrying a torn owner file
    // (the SIGKILL-mid-write shape this exists for) or a stray beside a dead
    // owner was left as litter forever — three shapes still open under the
    // argument that closed one. RE-DERIVED by planting all three plus a LIVE
    // acquirer's staging dir as a control and running one acquisition: the
    // pre-widening spelling leaves all three behind (and the control, rightly);
    // this one leaves the control alone and nothing else. The control is what
    // makes the row a reap rather than an rm -rf.
    removeObservedDir(orphanPath, evidence.entries);
  }
}

/**
 * Stage and take the lock, or null when the project's state dir may not even be
 * created — the consent fence (shared/fsjson.ts `ensureDir`) refuses it while
 * this project's "use Traffic One here?" question is unanswered or was answered
 * no. Null is the ONLY honest answer there: the alternatives are fabricating a
 * lease for a directory that does not exist (whose release would then rename and
 * delete a path this process never created) or throwing, and this acquisition
 * path deliberately does not throw on contention — see the EPERM note in the
 * retry loop for what a stray exception out of a hook costs.
 *
 * `ensureDir` does not swallow IO errors, so a genuine EACCES/EROFS on the state
 * dir still propagates exactly as the bare `mkdirSync` did. The old call passed
 * `mode: 0o700`, which this drops: `recursive: true` never re-modes an existing
 * directory and fsjson's own writers create `<project>/.traffic-one/` with the
 * default mode, so whichever writer arrived first already decided it.
 *
 * THE STAGING DIR AND THE OWNER FILE TAKE THE DEFAULT MODE TOO, and what decides
 * that is the WRITE bit — not the read bit, which is what an earlier draft of
 * this docblock argued from and got wrong twice.
 *
 * IT SAID `.traffic-one/` IS CREATED 0755 "SO A SECOND UID CAN CREATE THE LOCK
 * DIRECTORY". It cannot: creating an entry INSIDE a directory needs write
 * permission ON that directory, and 0755 grants a stranger `r-x`. Driven against
 * a 0555 directory — which is what 0755 grants a stranger, reproduced on this uid
 * because a non-root OWNER without the bit is refused exactly like one — mkdir,
 * create and unlink all fail EACCES while the listing succeeds. The wedge that
 * paragraph described is unreachable for every non-root second uid, and a ROOT
 * second uid bypasses modes entirely, so 0700 excluded nothing from it either.
 *
 * AND IT SAID 0755 LEAVES THE LOCK STRONGER, because another uid "can read the
 * evidence and decide liveness properly". True, and it buys nothing: the reclaim
 * it would authorize needs write permission on the lock directory, which that uid
 * does not have. MEASURED against a real dead-owner lock, the mode standing in
 * for the access class on one uid:
 *
 *     access to the lock dir       dead owner inside      empty
 *     r-x  (0755, to a stranger)   1020 ms, then throw    reclaimed, 52 ms
 *     ---  (0700, to a stranger)   1033 ms, then throw    reclaimed, 92 ms
 *     rwx  (0775, to its group)    reclaimed, 60 ms       reclaimed, 52 ms
 *
 * The first two rows are indistinguishable, which is the whole cross-uid case for
 * the modes collapsing. (Every empty row is reclaimed because `rmdir` needs write
 * on the PARENT, which the project's owner has.)
 *
 * WHAT DOES DECIDE IT IS ROW THREE, and the premise it needs is a HYPOTHESIS,
 * labelled as one: `.traffic-one/` is group- or other-writable — a shared CI
 * checkout, a `umask 002` deployment with a shared group. That is the only way a
 * non-root second uid participates in this lock at all, and it would be a
 * deployment choice rather than an attack. Nothing in this product supports it
 * today: a repo-wide search finds no shared checkout, no `umask 002`, no shared
 * group and no multi-uid operation outside this docblock and its suite. It is
 * kept because it is the only scenario in which the mode question has an answer
 * at all, not because it is a deployment anyone has shipped.
 *
 * AN EARLIER DRAFT DERIVED ROW THREE FROM INHERITANCE, AND THAT DERIVATION IS
 * FALSE AS MEASURED. It said "the default mode inherits the same umask that made
 * the state dir shared: the lock directory comes out group-writable too". The
 * lock directory inherits THE ACQUIRER's umask, which belongs to a different
 * process and need not be the one that created `.traffic-one/`:
 *
 *     creator umask   acquirer umask   .traffic-one/   lock dir   row three?
 *     022             022              0755            0755       no
 *     002             002              0775            0775       yes
 *     007             007              0770            0770       yes
 *     002             022              0775            0755       NO
 *     002             077              0775            0700       NO
 *     077             002              0700            0775       yes
 *
 * (Two processes, each setting its own umask before it runs; node v26.5.0, load
 * 64.56.) Row four is the ORDINARY case — a shared checkout with one process at
 * the distro default 022 — and it produces the 0755 the table above calls
 * "1020 ms, then throw". Row five produces literally 0700, the mode this docblock
 * says an explicit `mode: 0o700` would force as "a permanent wedge in precisely
 * that deployment". Row six is the same failure mirrored: a PRIVATE state dir
 * with a group-writable lock inside it, which grants nobody anything because
 * traversal needs the parent's x bit. The arithmetic was never in doubt
 * (`mkdirSync` takes `0o777 & ~umask`) and the suite's equality row pins it; it
 * was the inference that did not follow.
 *
 * THE DECISION SURVIVES ON WEAK DOMINANCE INSTEAD, which needs no premise about
 * anyone's umask. For every umask u, the default mode is `0o777 & ~u` and an
 * explicit 0700 is `0o700 & ~u`, and the first is a superset of the second bit
 * for bit. So the default is NEVER more restrictive than the explicit mode and is
 * sometimes less: whatever deployment you are in, keeping the default can only
 * ever grant MORE access than `mode: 0o700` would, so it can only ever make more
 * reclaims possible and can never make one impossible that 0700 would have
 * allowed. Row three is reachable under the default and unreachable under 0700;
 * no row is reachable under 0700 and unreachable under the default. That is the
 * whole argument, it holds for every umask including the two that falsified the
 * inheritance claim, and it costs nothing because confidentiality is not the
 * asset here (below).
 *
 * NOT MEASURED, AND NOT MEASURABLE HERE: a genuine second uid needs root. Every
 * row above substitutes a mode for an access class on one uid. That is faithful
 * to the kernel's permission check, which is what the argument turns on, and it
 * says nothing about anything else a second uid would be subject to.
 *
 * What the restrictive modes bought, meanwhile, is nothing this lock needs. The
 * owner file holds a pid, a token and a timestamp; the pid is public (`ps`), the
 * timestamp is not a secret, and the token is not a capability — `report-id.lock`
 * is named in exactly one non-test source file, this one; the token is read only
 * here, only to compare with the reader's OWN token and refuse; self-contention
 * is keyed on the directory's dev+ino (see `heldLockIds`); and nothing anywhere
 * grants anything to a caller that can name it. Meanwhile any actor who can write
 * inside `.traffic-one/` can rename this lock aside whatever its mode — the
 * compare-and-swap constrains OUR reapers, not an arbitrary actor with write
 * permission on the parent — so confidentiality was never the asset.
 *
 * THE TWO SIBLING LOCKS DISAGREE ABOUT THIS, and the disagreement is about their
 * assets rather than about the rule. run-agent/locks.ts creates its lock dirs
 * with the default mode and its sentinel 0644, in this same `.traffic-one/`, and
 * agrees. shared/one-settings.ts is a near-identical owner-token directory lock
 * that keeps `mode: 0o700` on both directories and 0o600 on the owner file, and
 * rests its own security argument on that 0700 — correctly, for what it protects:
 * its file is the machine settings file under `$HOME`, which holds an API key in
 * plaintext (shared/auth/machine-sidecar.ts calls it "the SECRET file"), and
 * TRAFFIC_ONE_STATE_PATH relocates that file AND its lock to an arbitrary path
 * whose parent permissions nothing vets. Neither half is true here. `.one.json`
 * is a COMMITTED file (config/paths.ts), so nothing guarding it can need
 * confidentiality the guarded file does not have; and this lock path is a pure
 * string derivation of the caller's cwd through a constant `STATE_FILE`, with no
 * environment override anywhere in its closure, so the lock never relocates to a
 * parent nobody vetted the way one-settings.ts's does.
 *
 * WHAT IT IS NOT is "always a `.traffic-one/` this product created", which an
 * earlier draft asserted here and which the very fact two sentences above
 * refutes. `.one.json` is TRACKED, so `git clone` or `git checkout` CREATES
 * `.traffic-one/` with git's umask before Traffic One has run in that project at
 * all — and `ensureDir`'s `mkdirSync(recursive: true)` never re-modes an existing
 * directory, as this docblock says itself above. Measured non-git adoption routes
 * land in the same place: a user `mkdir` plus `chmod 0777` gives 0777, `tar x`
 * gives 755, `cp -R` gives 755. The confidentiality argument does not need the
 * clause — it turns on what the guarded file IS, not on who made its
 * directory — and the mode argument is now weak dominance, which holds whoever
 * created the parent and at whatever mode.
 */
function acquireProjectStateLock(cwd: string): ProjectStateLock | typeof REENTRANT | null {
  const lockPath = projectStateLockPath(cwd);
  if (!ensureDir(path.dirname(lockPath))) return null;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS;

  fs.mkdirSync(pendingPath);
  try {
    fs.writeFileSync(
      path.join(pendingPath, ownerName),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      // `wx` is the compare-and-swap on this file and is load-bearing; the MODE
      // is deliberately the default — see the docblock above for what 0600 cost
      // and what it bought.
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  // Opportunistic litter removal — the orphans are only ever visible to a LATER
  // acquirer, since the process that would have cleaned them is gone. It runs
  // AFTER our own staging dir exists rather than before, and that ordering is
  // the fix for a clock rather than a tidy-up: the directory we just created is
  // the only stamp available from the same clock that stamped the orphans. See
  // `reapAbandonedPendingDirs`, which reads its `now` out of it.
  reapAbandonedPendingDirs(lockPath, pendingPath);

  // Taken from the directory we STAGED, before any rename, and that is what
  // makes `heldLockIds`' provenance sentence true rather than nearly true: the
  // ids in that set have to be of directories this process created itself, and
  // `rename` preserves the inode, so this is exactly the id of the object we go
  // on to hold. Re-observing the PATH after the rename reads whatever is there
  // at that instant instead — the same object in every ordinary case, and
  // something else in the one case the set is defending against.
  const stagedId = observeLockPath(pendingPath).id;

  let acquired = false;
  try {
    while (true) {
      try {
        fs.renameSync(pendingPath, lockPath);
        acquired = true;
        return {
          dirPath: lockPath,
          ownerPath: path.join(lockPath, ownerName),
          token,
          id: stagedId,
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // EPERM counts as contended even when lockPath is ALREADY GONE: macOS
        // surfaces transient EPERM on a rename that raced the owner's release,
        // and by the time we look the lock dir has vanished. Reaching this loop
        // proves the parent dir is writable (mkdirSync above succeeded), so a
        // persistent EPERM ends at this loop's own deadline instead of leaking
        // out of a hook as a fail-closed deny (observed 3cl: parallel Bash
        // probes → "plan-guard.write gate failed (EPERM)").
        //
        // EACCES is the same shape one errno over, and it was the one errno this
        // list left out. `rename` onto a lock directory must read it to decide it
        // is non-empty, so a lock directory this uid may not read raises EACCES
        // — measured, 2 ms, from a hook, as a raw errno, which is precisely the
        // "plan-guard.write gate failed (EPERM)" wedge the row above exists to
        // prevent. Classified rather than left open in either direction: without
        // this word the two rows in
        // __tests__/lock-identity-symlink.test.ts that plant an unreadable lock
        // see a raw EACCES instead of this loop's own timeout, and the aged,
        // EMPTY one is never reclaimed at all.
        const contended = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR'
          || code === 'EPERM' || code === 'EACCES';
        if (!contended) throw error;
        // SELF-CONTENTION, asked of the DIRECTORY rather than of anything
        // written inside it: is the thing we just collided with one this process
        // already holds? A dev+ino match cannot be anything but our own outer
        // hold, reached under a second spelling of the project root that
        // `heldLocks` — keyed by the lock path string — could not recognise.
        // Waiting for that is waiting for ourselves: the outer frame is on the
        // stack below this one and will not release until this call returns, so
        // the loop is guaranteed to spend its full deadline and then throw out
        // of a hook (measured: 1002 ms, then a throw). Re-entering is the honest
        // answer, and it is the same answer the fast path gives to the same
        // nesting spelled identically.
        //
        // Asked BEFORE the owner file is read, which is both cheaper (one lstat
        // instead of a readdir plus a parse) and the reason this cannot be
        // spoofed: nothing an attacker WRITES is consulted, and the one thing an
        // attacker can PLANT — a symlink — is answered on its own inode rather
        // than on its target's, then removed. See `heldLockIds` for the pid+token
        // pair this replaces, the bypass that retired it, and the second bypass
        // of the same shape that a following stat reopened.
        //
        // Deliberately NOT memoized into `heldLocks`: this spelling's release
        // never runs (there is no lease to release), so an entry added here would
        // outlive the outer hold and make a LATER, genuinely unheld acquisition
        // under that spelling skip the filesystem lock entirely.
        const observed = observeLockPath(lockPath);
        // Before the identity question, because a planted object has an answer to
        // it (its own inode, which never matches) and no business surviving to be
        // asked twice — it is what wedges the lock permanently.
        let progressed = observed.nonDirectory && clearStrayLockObject(lockPath);
        if (!progressed) {
          if (observed.id !== null && heldLockIds.has(observed.id)) return REENTRANT;
          const owner = observedLockOwner(lockPath);
          // NEITHER ARM READS A STAMP NOW, and the observed arm was the last one
          // that did: it required `(age === null || age > STALE) && !processAlive`
          // — death AND age. The age conjunct is removed here, which makes this
          // arm agree with the abandoned arm below, with the override lane's lock,
          // and with the evidence.
          //
          // WHAT IT WAS NOT DOING is protecting a live holder. `processAlive` is
          // that guard and it is unconditional: DRIVEN, three reps each, load
          // 103.84 → 89.47 in the review that ordered this and re-driven here — a
          // LIVE owner with a fresh record is refused with the conjunct and
          // refused without it, so liveness alone is what keeps the lease. What
          // the conjunct did was charge a full ten-second stale window to an
          // honest recent crash: a dead owner with a fresh record was refused
          // (1 318/1 633/1 434 ms) and then THREW, so every `.one.json`
          // transaction in that project failed out of a hook for ten seconds,
          // against 456/548/586 ms to a minted lock without it. A SIGKILLed hook
          // is the documented normal case in this file — 22 orphans on one 16co
          // run.
          //
          // THE ASYMMETRY IS THE ARGUMENT. An abandoned lock with NO legible
          // owner is reclaimed at once (the arm below consults no age at all),
          // while one with a perfectly legible DEAD owner waited ten seconds. The
          // legible case carries strictly MORE evidence — a pid that answers
          // ESRCH is proof of death, not an inference from a clock — and was
          // treated more conservatively. Earlier rounds removed the age from the
          // arm with less evidence and left it on the arm with more.
          //
          // WHAT REPLACES IT is the compare-and-swap in `reapObservedLock`, which
          // is why the removal is safe rather than merely cheap: the unlink names
          // the exact token that was OBSERVED and the `rmdir` refuses a non-empty
          // directory, so a lease minted while this arm was deciding survives.
          // VERIFIED IN THIS FILE rather than inherited — a competitor's full
          // legitimate sequence (reap, stage, rename a directory carrying its own
          // owner file) injected between `processAlive` and the unlink leaves the
          // competitor's lease intact and the reaper reporting that it did
          // nothing, 3/3, with and without the conjunct.
          //
          // THE RESIDUAL, recorded because it is real: a holder in a DIFFERENT
          // pid namespace (a container, or a lock directory on a share) answers
          // ESRCH here while being alive there, and it loses a ten-second cushion
          // it used to have. A cushion that expires on a timer is a delay rather
          // than a defence — after ten seconds the old code took that lock
          // too — and `processAlive` deliberately reads EPERM as alive, which is
          // what actually covers the cross-uid case (see its docblock).
          if (owner) {
            progressed = !processAlive(owner.pid) && reapObservedLock(lockPath, owner);
          } else {
            progressed = reapAbandonedLock(lockPath);
          }
        }
        // THE DEADLINE GOVERNS EVERY ARM, including the ones that just made
        // progress. Each arm used to `continue` straight past this test and past
        // the sleep, so an adversary who re-created whatever was cleared kept the
        // loop alive with no bound and no sleep at all: measured, 10 404 hot
        // iterations against a re-planted symlink, still running at 3x its own
        // deadline with no throw. A hook that never returns is worse than one
        // that fails closed — an unbounded loop cannot even be reported. The
        // clear arm was the cheapest to drive (unconditional, one unlink per
        // iteration) but the two reap arms have the identical shape and are
        // bounded by this same line now rather than by how hard they are to
        // re-arm.
        //
        // SAMPLED AFTER THE ARMS RAN, not before, and not from the instant the
        // rename failed: testing the deadline against a stamp taken before the
        // arms bounds the loop by ITERATIONS rather than by time, because an
        // iteration whose arms are slow is always one iteration below the bound
        // and buys the whole of its own duration for free. (No arm reads a clock
        // at all now — the observed arm's age conjunct was the last one — so
        // there is no longer a second reason to take that earlier stamp.)
        //
        // MEASURED, three reps of each shape, as a multiple of the 1000 ms
        // timeout. Sampling before the arms: 1.028–1.034x on a thin lock
        // directory, 1.168–1.249x with four 48 MB owner files for
        // `illegibleLockEvidence` to read and parse. Sampling here: 1.019–1.022x
        // and 1.058–1.134x. So the ~1.02x this loop is usually described by is
        // confirmed for realistic shapes and was ALREADY true before the move —
        // what the move buys is the pathological shape, where the overshoot
        // roughly halves.
        //
        // TESTED ONLY BETWEEN ITERATIONS, WHICH IS AS FINE AS THIS RUNTIME GETS,
        // and that is a bound rather than a hope only because of what the arms can
        // no longer do. It used to be neither: `readFileSync` on a FIFO or a
        // device node inside the lock directory never returned at all, so this
        // line was unreachable and the loop had no bound in wall clock — measured
        // at 25 s and 60 s with no return. With `readOwnerEntry`'s allowlist, an
        // arm's cost is the entries it lists plus the BYTES of the regular files
        // among them, and the pathological figure above (1.058–1.134x for 192 MB
        // of owner files) is the price of the largest such shape anyone has
        // planted here.
        //
        // THE ALLOWLIST'S OWN COST IS NOT MEASURABLE BESIDE THE BYTES, which is
        // the claim an `open` + `fstat` + `close` per owner entry has to answer
        // for. Same driver, two reps each, against this reader and against the
        // pre-allowlist `readFileSync(path)`, four owner files per fixture, at
        // load 63–71: thin 1.01–2.04x here versus 1.01–1.39x before, 4 x 48 MB
        // 2.29–3.23x here versus 2.63–2.84x before — overlapping ranges in both
        // shapes and in both directions. What that load DOES change is the whole
        // overshoot: the 1.02x/1.13x figures above were taken on an idle host and
        // this one has not been idle today, so they are kept as the idle
        // measurement rather than restated as a current one. The order of
        // magnitude is the claim; the third digit was never available here.
        //
        // What remains unbounded is not a shape and not a loop: it is one
        // SYNCHRONOUS SYSCALL on a medium that does not answer — a read or a
        // readdir on a wedged mount, which `mkdirSync` above and `renameSync`
        // here are equally subject to before any arm runs. This runtime cannot
        // interrupt one, so a finer-grained test could only be inserted BETWEEN
        // syscalls; it would move the residual from "one arm" to "one syscall"
        // and buy nothing else. Bounding THAT needs asynchronous IO with a timer,
        // which `withProjectStateLock` cannot have — it is synchronous by
        // contract, because its callers are hooks that must not return a promise.
        // So: acceptable, and the reason is that the residual is now a property
        // of the medium rather than of anything a writer can plant.
        const decidedAt = Date.now();
        if (decidedAt >= deadline) {
          throw new Error(`traffic-one project state lock timed out after ${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS}ms`);
        }
        // Only a fruitless iteration waits. A successful clear or reap retries
        // the rename immediately, which is what the `continue`s bought.
        if (!progressed) sleepSync(Math.min(ONE_MCP_REPORT_ID_LOCK_RETRY_MS, deadline - decidedAt));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

/**
 * THE RELEASE READS THROUGH `readOwnerEntry` TOO, and it is the third blocking
 * reader rather than a consistency edit. The proof of ownership below is a read
 * of a path inside the lock directory, so anybody who can write in that
 * directory can replace our own owner file with a FIFO — DRIVEN, by a body that
 * does exactly that to itself: the acquisition succeeded, the transaction ran,
 * and the release then never returned, twice, under a 25 s alarm at load 75.03.
 * A hook that hangs on the way OUT is the same unreportable outcome as one that
 * hangs on the way in, and it is worse in one respect: the work is already done
 * and the lease is still held.
 *
 * A non-regular file at our own owner path returns null here, which lands on the
 * same branch as unreadable bytes and a foreign token: we cannot prove we own
 * this directory, so we remove nothing. The lock directory is then reclaimed by
 * `reapAbandonedLock` — presence with no liveness evidence, so after one stale
 * window — instead of being held until the host is restarted.
 */
function releaseProjectStateLock(lock: ProjectStateLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    const bytes = readOwnerEntry(lock.ownerPath);
    if (bytes === null) return;
    const raw = JSON.parse(bytes) as Record<string, unknown>;
    if (raw.token !== lock.token) return;
    fs.renameSync(lock.dirPath, releasedPath);
  } catch {
    // Already removed/replaced. Never remove a lock we cannot prove we own.
    return;
  }
  try { fs.rmSync(releasedPath, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Run one synchronous project-state transaction. Nested calls in the same
 * process are re-entrant; cross-process contenders always use the filesystem
 * lock. Callers must not return a Promise from `body`.
 *
 * When the lock cannot be taken because the state dir may not be created, the
 * body runs UNSERIALIZED, and that is safe for one specific reason: this lock
 * exists solely to serialize mutations of `<project>/.traffic-one/.one.json`
 * (see the file header), every writer of that file goes through fsjson's
 * `writeJson` (state/normalize.ts writeState is the funnel), and `ensureDir`
 * refuses exactly when `writeJson` on that same project's state dir also
 * refuses. There is therefore nothing to serialize: no writer inside `body` can
 * mutate the file this lock protects, so no update can be lost.
 *
 * The body still runs, rather than being skipped, because these bodies read and
 * compute as well as write — skipping them would change what a hook REPORTS on a
 * project whose question is merely pending, and pending is not "plugin off": the
 * user still has to be asked. Only the writes stand down, which is the fence's
 * whole contract.
 *
 * No lease is fabricated and `heldLocks` is deliberately not touched: a lock this
 * process does not hold must never look held, to itself or to the release path.
 */
export function withProjectStateLock<T>(cwd: string, body: () => T): T {
  const lockPath = projectStateLockPath(cwd);
  if (heldLocks.has(lockPath)) return body();
  const lock = acquireProjectStateLock(cwd);
  // Either nothing to serialize (the consent fence, above) or we ARE the owner
  // under another spelling (the self-contention branch in the retry loop). Both
  // run the body with no lease of our own to add or release.
  if (!lock || lock === REENTRANT) return body();
  heldLocks.add(lockPath);
  // A lock we could not lstat carries no identity, so a second spelling of it
  // takes the contended path and stalls exactly as it did before that branch
  // existed. Degrading to the old cost is the only safe direction: the
  // alternative is a placeholder that some other lock could also match.
  if (lock.id !== null) heldLockIds.add(lock.id);
  try {
    return body();
  } finally {
    heldLocks.delete(lockPath);
    if (lock.id !== null) heldLockIds.delete(lock.id);
    releaseProjectStateLock(lock);
  }
}
