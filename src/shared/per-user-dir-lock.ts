// Directory-lock protocol for 0700 per-user roots (prefs, One MCP cache).
//
// EPERM is `not-ours`, not "alive". These locks live inside a directory this
// process created 0700; a pid we cannot signal never took the lock. Shared
// project `.traffic-one/` locks must NOT use this — there EPERM can mean
// another user's live process.

import * as fs from 'fs';
import * as path from 'path';

import { readOwnerEntry } from './bounded-read';
import { trustworthyAgeSince } from './clock-skew';

export interface PerUserDirLock {
  readonly dirPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

interface PerUserDirLockOwner {
  readonly ownerPath: string;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

export type OwnerLiveness = 'alive' | 'dead' | 'not-ours';

/**
 * Could the process named by an owner file still be HOLDING THIS lock?
 *
 * Ported from one-settings.ts: EPERM is `not-ours`. A planted pid-1 owner
 * cannot wedge a per-user 0700 root; a live holder we can signal still
 * answers `alive`.
 */
export function ownerLiveness(pid: number): OwnerLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'not-ours' : 'dead';
  }
}

export function ownerHoldsLock(pid: number): boolean {
  return ownerLiveness(pid) === 'alive';
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // SharedArrayBuffer can be unavailable in constrained hook runtimes.
  }
}

function isOwnerName(name: string): boolean {
  return name.startsWith('owner-') && name.endsWith('.json');
}

function observedLockOwner(lockPath: string): PerUserDirLockOwner | null {
  try {
    const entries = fs.readdirSync(lockPath).filter((name) => /^owner-[a-f0-9]+\.json$/.test(name));
    if (entries.length !== 1) return null;
    const ownerName = entries[0]!;
    const ownerPath = path.join(lockPath, ownerName);
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

function reapObservedLock(lockPath: string, owner: PerUserDirLockOwner): boolean {
  try {
    fs.unlinkSync(owner.ownerPath);
  } catch {
    return false;
  }
  try {
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function removeObservedDir(dirPath: string, entries: readonly string[]): boolean {
  for (const name of entries) {
    try { fs.rmSync(path.join(dirPath, name), { recursive: true }); } catch { /* not ours to remove */ }
  }
  try {
    fs.rmdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

interface IllegibleLockEvidence {
  readonly livePid: boolean;
  readonly unreadableOwner: boolean;
  readonly entries: readonly string[];
}

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
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && ownerHoldsLock(pid)) livePid = true;
  }
  return { livePid, unreadableOwner, entries: names };
}

function reapAbandonedLock(lockPath: string, staleMs: number): boolean {
  const evidence = illegibleLockEvidence(lockPath);
  if (evidence.livePid) return false;
  if (evidence.unreadableOwner) {
    let ageMs: number | null;
    try { ageMs = trustworthyAgeSince(fs.statSync(lockPath).mtimeMs, Date.now()); } catch { ageMs = null; }
    if (ageMs !== null && ageMs <= staleMs) return false;
  }
  return removeObservedDir(lockPath, evidence.entries);
}

function clearStrayLockObject(lockPath: string): boolean {
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function nonDirectoryAt(lockPath: string): boolean {
  try { return !fs.lstatSync(lockPath).isDirectory(); } catch { return false; }
}

function reapAbandonedPendingDirs(lockPath: string, ownStagingPath: string, staleMs: number): void {
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
    if (name === ownStagingName) continue;
    const orphanPath = path.join(dir, name);
    let orphanAgeMs: number | null;
    try {
      orphanAgeMs = trustworthyAgeSince(fs.statSync(orphanPath).mtimeMs, now);
    } catch {
      continue;
    }
    if (orphanAgeMs !== null && orphanAgeMs <= staleMs) continue;
    const owner = observedLockOwner(orphanPath);
    const evidence = illegibleLockEvidence(orphanPath);
    if (evidence.livePid) continue;
    if (!owner && orphanAgeMs === null) continue;
    removeObservedDir(orphanPath, evidence.entries);
  }
}

export interface PerUserDirLockOptions {
  readonly timeoutMs: number;
  readonly retryMs: number;
  readonly staleMs: number;
}

/**
 * Acquire the mkdir-then-rename directory lock beside `filePath`.
 * Returns null on timeout — a refusal, not a throw — so a contended
 * per-user lock cannot abort a hook.
 */
export function acquirePerUserDirLock(filePath: string, options: PerUserDirLockOptions): PerUserDirLock | null {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + options.timeoutMs;

  try {
    fs.mkdirSync(pendingPath, { mode: 0o700 });
    fs.writeFileSync(
      path.join(pendingPath, ownerName),
      JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw error;
  }

  reapAbandonedPendingDirs(lockPath, pendingPath, options.staleMs);

  let acquired = false;
  try {
    while (true) {
      try {
        fs.renameSync(pendingPath, lockPath);
        acquired = true;
        return { dirPath: lockPath, ownerPath: path.join(lockPath, ownerName), token };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const contended = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR'
          || code === 'EACCES' || (code === 'EPERM' && fs.existsSync(lockPath));
        if (!contended) throw error;
        if (nonDirectoryAt(lockPath) && clearStrayLockObject(lockPath)) {
          if (Date.now() < deadline) continue;
        }
        const owner = observedLockOwner(lockPath);
        // Dead owner: reclaim at any age. Liveness (not the stamp) protects a holder.
        if (owner && !ownerHoldsLock(owner.pid) && reapObservedLock(lockPath, owner)) continue;
        if (!owner && reapAbandonedLock(lockPath, options.staleMs)) continue;
        const now = Date.now();
        if (now >= deadline) return null;
        sleepSync(Math.min(options.retryMs, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

export function releasePerUserDirLock(lock: PerUserDirLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    const bytes = readOwnerEntry(lock.ownerPath);
    if (bytes === null) return;
    const raw = JSON.parse(bytes) as Record<string, unknown>;
    if (raw.token !== lock.token) return;
    fs.renameSync(lock.dirPath, releasedPath);
  } catch {
    return;
  }
  try { fs.rmSync(releasedPath, { recursive: true, force: true }); } catch { /* best-effort */ }
}
