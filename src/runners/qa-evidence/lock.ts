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
import { qaDir } from './run-context';

// A full visual run (screenshots x widths x routes + Lighthouse) legitimately
// takes minutes; a stale window shorter than that would let a second instance
// steal the lock mid-run (the exact 8co failure). 15 minutes, plus a
// liveness probe so a crashed runner never wedges the directory.
const QA_RUN_LOCK_STALE_MS = 15 * 60 * 1000;

export interface QaRunLockHolder {
  pid: number;
  startedAt: string;
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
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(raw.pid) || typeof raw.startedAt !== 'string') return null;
    return { pid: Number(raw.pid), startedAt: raw.startedAt };
  } catch {
    return null;
  }
}

function lockStale(lockPath: string, holder: QaRunLockHolder | null): boolean {
  if (holder && processAlive(holder.pid)) return false;
  if (holder && !processAlive(holder.pid)) return true;
  // Unreadable payload: age decides, and there is no pid here to govern it.
  try {
    // An mtime ahead of now makes this difference negative, which is never
    // `> STALE`, so the run directory would be wedged permanently — every later
    // runner exiting `already-running` against a holder that no longer exists.
    // An age no clock could have produced is exactly as much evidence as no
    // mtime at all, and the catch below already folds THAT to reclaimable, so
    // this folds the same way rather than contradicting its own sibling branch.
    const ageMs = trustworthyAgeSince(fs.statSync(lockPath).mtimeMs, Date.now());
    return ageMs === null || ageMs > QA_RUN_LOCK_STALE_MS;
  } catch {
    // Vanished between existsSync and statSync — treat as reclaimable.
    return true;
  }
}

function tryCreate(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function acquireQaRunLock(projectRoot: string, runId: string): QaRunLockResult {
  const dir = qaDir(projectRoot, runId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, holder: null };
  }
  const lockPath = path.join(dir, '.runner.lock');
  if (tryCreate(lockPath)) return { ok: true, lockPath };
  const holder = readHolder(lockPath);
  if (lockStale(lockPath, holder)) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Another contender reclaimed it first.
    }
    if (tryCreate(lockPath)) return { ok: true, lockPath };
  }
  return { ok: false, holder: readHolder(lockPath) };
}

export function releaseQaRunLock(lockPath: string): void {
  try {
    const holder = readHolder(lockPath);
    if (holder && holder.pid !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Best effort — the stale window reclaims an orphaned lock.
  }
}
