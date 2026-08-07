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
import { trustworthyAgeSince } from '../clock-skew';
import { ensureDir } from '../fsjson';

interface ProjectStateLock {
  readonly dirPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

interface ProjectStateLockOwner {
  readonly ownerPath: string;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

let sleepArray: Int32Array | null | undefined;
const heldLocks = new Set<string>();

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
export function preserveCurrentRunId(current: unknown, replacement: unknown): Rec {
  const next = record(replacement) ? { ...(replacement as Rec) } : {};
  if (runIdValue(next.currentRunId)) return next; // replacement carries an id (possibly a legit new one)
  const currentId = runIdValue(record(current)?.currentRunId);
  if (currentId) next.currentRunId = currentId; // never let a stale snapshot blank a live id
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

function observedLockOwner(lockPath: string): ProjectStateLockOwner | null {
  try {
    const names = fs.readdirSync(lockPath);
    if (names.length !== 1) return null;
    const ownerName = names[0]!;
    const ownerPath = path.join(lockPath, ownerName);
    const raw = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function reapObservedLock(lockPath: string, owner: ProjectStateLockOwner): boolean {
  try { fs.unlinkSync(owner.ownerPath); } catch { return false; }
  try {
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function reapAbandonedEmptyLock(lockPath: string, now: number): boolean {
  try {
    if (fs.readdirSync(lockPath).length !== 0) return false;
    // Left as a raw subtraction on purpose; see the same note in
    // one-mcp/cache-lock.ts. `rename(dir, EMPTY dir)` succeeds, so an empty
    // canonical lock is overwritten rather than contended and this reap is not
    // on the acquisition path — not even on the transient-EPERM route above,
    // whose retry renames over the empty directory. A negative age costs a
    // retry, not a wedge. The `.pending` reaper below is a different story: it
    // has no rename to fall back on, so it IS folded.
    if (now - fs.statSync(lockPath).mtimeMs <= ONE_MCP_REPORT_ID_LOCK_STALE_MS) return false;
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function projectStateLockPath(cwd: string): string {
  return `${path.join(path.resolve(cwd), STATE_FILE)}.report-id.lock`;
}

/**
 * Reap `<lock>.<token>.pending` staging dirs left by hook processes that died.
 *
 * The mkdir-then-rename handshake stages every acquisition in a sibling
 * `.pending` dir, and the only thing that removes one is the `finally` in
 * `withProjectStateLock` — which does not run when the host kills the process.
 * `reapAbandonedEmptyLock` cannot help: it reaps the lock path itself, and a
 * `.pending` dir is never empty (it holds its owner file). Measured on one 16co
 * run: 22 orphans, each with a live-looking owner. Harmless to acquisition, but
 * it litters the user's project and it is what made `.traffic-one` look like it
 * was growing directories at random.
 *
 * Deliberately conservative: same liveness test the observed-lock reaper uses,
 * plus the same staleness floor, and every failure is swallowed. A `.pending`
 * dir whose owner process is alive is somebody's in-flight acquisition.
 */
function reapAbandonedPendingDirs(lockPath: string, now: number): void {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.pending')) continue;
    const pendingPath = path.join(dir, name);
    let pendingAgeMs: number | null;
    try {
      // A negative age reads as brand new forever, so the orphans this function
      // exists to remove would accumulate untouched — the 16co litter, back.
      pendingAgeMs = trustworthyAgeSince(fs.statSync(pendingPath).mtimeMs, now);
    } catch {
      continue;
    }
    if (pendingAgeMs !== null && pendingAgeMs <= ONE_MCP_REPORT_ID_LOCK_STALE_MS) continue;
    const owner = observedLockOwner(pendingPath);
    // No readable owner => nothing proves it is in flight; a live pid does.
    // This is the one site here where an unusable age must NOT stand in for the
    // age floor: an owner-less staging dir is exactly the mkdir→owner-file gap
    // of a live acquisition, and removing it makes that acquirer's own rename
    // fail ENOENT, which is not in its contended set and throws out of a hook.
    // With a readable owner the pid is proof, so death alone authorizes the reap.
    if (owner ? processAlive(owner.pid) : pendingAgeMs === null) continue;
    try {
      if (owner) fs.unlinkSync(owner.ownerPath);
      fs.rmdirSync(pendingPath);
    } catch {
      // best-effort: a racing owner may be removing it right now
    }
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
 * default mode, so whichever writer arrived first already decided it. The modes
 * that ARE load-bearing — 0700 on the staging dir, 0600 on the owner file — are
 * below and unchanged.
 */
function acquireProjectStateLock(cwd: string): ProjectStateLock | null {
  const lockPath = projectStateLockPath(cwd);
  if (!ensureDir(path.dirname(lockPath))) return null;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS;
  // Opportunistic, before staging our own: the dead ones are only ever visible
  // to a later acquirer, since the process that would have cleaned them is gone.
  reapAbandonedPendingDirs(lockPath, Date.now());

  fs.mkdirSync(pendingPath, { mode: 0o700 });
  try {
    fs.writeFileSync(
      path.join(pendingPath, ownerName),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  let acquired = false;
  try {
    while (true) {
      try {
        fs.renameSync(pendingPath, lockPath);
        acquired = true;
        return { dirPath: lockPath, ownerPath: path.join(lockPath, ownerName), token };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // EPERM counts as contended even when lockPath is ALREADY GONE: macOS
        // surfaces transient EPERM on a rename that raced the owner's release,
        // and by the time we look the lock dir has vanished. Reaching this loop
        // proves the parent dir is writable (mkdirSync above succeeded), so a
        // persistent EPERM ends at this loop's own deadline instead of leaking
        // out of a hook as a fail-closed deny (observed 3cl: parallel Bash
        // probes → "plan-guard.write gate failed (EPERM)").
        const contended = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR'
          || code === 'EPERM';
        if (!contended) throw error;
        const now = Date.now();
        const owner = observedLockOwner(lockPath);
        // A future-stamped sentinel makes this age negative, hence never stale,
        // so a dead owner's lock made every `.one.json` transaction throw at the
        // timeout — including the run-id mint. An unusable age does not veto the
        // reap; `processAlive` below still governs, so a live writer holds on.
        const ownerAgeMs = owner ? trustworthyAgeSince(owner.createdAt, now) : null;
        if (owner && (ownerAgeMs === null || ownerAgeMs > ONE_MCP_REPORT_ID_LOCK_STALE_MS)
          && !processAlive(owner.pid) && reapObservedLock(lockPath, owner)) continue;
        if (!owner && reapAbandonedEmptyLock(lockPath, now)) continue;
        if (now >= deadline) {
          throw new Error(`traffic-one project state lock timed out after ${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS}ms`);
        }
        sleepSync(Math.min(ONE_MCP_REPORT_ID_LOCK_RETRY_MS, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function releaseProjectStateLock(lock: ProjectStateLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    const raw = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8')) as Record<string, unknown>;
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
  if (!lock) return body();
  heldLocks.add(lockPath);
  try {
    return body();
  } finally {
    heldLocks.delete(lockPath);
    releaseProjectStateLock(lock);
  }
}
