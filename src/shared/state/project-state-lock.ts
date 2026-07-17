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
} from '../../config/one-mcp';
import { STATE_FILE } from '../../config/paths';

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
    if (now - fs.statSync(lockPath).mtimeMs <= ONE_MCP_REPORT_ID_LOCK_STALE_MS) return false;
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export function projectStateLockPath(cwd: string): string {
  return `${path.join(path.resolve(cwd), STATE_FILE)}.report-id.lock`;
}

function acquireProjectStateLock(cwd: string): ProjectStateLock {
  const lockPath = projectStateLockPath(cwd);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS;

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
        const contended = code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR'
          || (code === 'EPERM' && fs.existsSync(lockPath));
        if (!contended) throw error;
        const now = Date.now();
        const owner = observedLockOwner(lockPath);
        if (owner && now - owner.createdAt > ONE_MCP_REPORT_ID_LOCK_STALE_MS
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
 */
export function withProjectStateLock<T>(cwd: string, body: () => T): T {
  const lockPath = projectStateLockPath(cwd);
  if (heldLocks.has(lockPath)) return body();
  const lock = acquireProjectStateLock(cwd);
  heldLocks.add(lockPath);
  try {
    return body();
  } finally {
    heldLocks.delete(lockPath);
    releaseProjectStateLock(lock);
  }
}
