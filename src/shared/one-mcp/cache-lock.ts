// src/shared/one-mcp/cache-lock.ts
// The owner-stamped cache lock with stale/abandoned reap.

import * as fs from 'fs';
import * as path from 'path';
import {
  ONE_MCP_CACHE_FILE,
  ONE_MCP_CACHE_LOCK_RETRY_MS,
  ONE_MCP_CACHE_LOCK_STALE_MS,
  ONE_MCP_CACHE_LOCK_TIMEOUT_MS,
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_MAX_CONFIG_VERSION,
} from '../../config/one-mcp';
import {
  GENERATION_RE,
  knownHost,
  oneMcpConfigCacheIdentity,
  parseLastSync,
  parseOneMcpConfigCacheEntry,
  record,
  sameIdentity,
  validString,
  type OneMcpCache,
  type OneMcpConfigCacheCasResult,
  type OneMcpConfigCacheEntry,
  type OneMcpConfigCacheIdentity,
  type OneMcpConfigCacheRequestObservation,
  type OneMcpConfigCacheUpdate,
  type OneMcpHostCacheMap,
  type OneMcpLastSync,
  type Rec,
} from './cache-schema';

export interface CacheLock {
  dirPath: string;
  ownerPath: string;
  token: string;
}
interface CacheLockOwner {
  ownerPath: string;
  token: string;
  pid: number;
  createdAt: number;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // Constrained hook runtimes can disable SharedArrayBuffer. The deadline
    // still bounds the retry loop.
  }
}

function observedLockOwner(lockPath: string): CacheLockOwner | null {
  try {
    const entries = fs.readdirSync(lockPath).filter((name) => /^owner-[a-f0-9]+\.json$/.test(name));
    if (entries.length !== 1) return null;
    const ownerName = entries[0]!;
    const ownerPath = path.join(lockPath, ownerName);
    const raw = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Rec;
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

function reapObservedLock(lockPath: string, owner: CacheLockOwner): boolean {
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
    if (now - fs.statSync(lockPath).mtimeMs <= ONE_MCP_CACHE_LOCK_STALE_MS) return false;
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    // A legacy owner may have appeared after the empty-directory observation,
    // or another contender may already have recovered it. Both are safe races.
    return false;
  }
}

export function acquireCacheLock(filePath: string): CacheLock {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + ONE_MCP_CACHE_LOCK_TIMEOUT_MS;
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
        if (owner && now - owner.createdAt > ONE_MCP_CACHE_LOCK_STALE_MS
          && !processAlive(owner.pid) && reapObservedLock(lockPath, owner)) continue;
        if (!owner && reapAbandonedEmptyLock(lockPath, now)) continue;
        if (now >= deadline) {
          throw new Error(`traffic-one One MCP cache lock timed out after ${ONE_MCP_CACHE_LOCK_TIMEOUT_MS}ms`);
        }
        sleepSync(Math.min(ONE_MCP_CACHE_LOCK_RETRY_MS, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

export function releaseCacheLock(lock: CacheLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    const raw = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8')) as Rec;
    if (raw.token !== lock.token) return;
    // Remove the canonical lock pathname in one atomic operation. Cleanup is
    // token-addressed and best-effort, so a crash can strand only a harmless
    // tombstone rather than an empty canonical lock that blocks every writer.
    fs.renameSync(lock.dirPath, releasedPath);
  } catch {
    // Already removed/replaced. Never remove a lock we cannot prove we own.
    return;
  }
  try { fs.rmSync(releasedPath, { recursive: true, force: true }); } catch { /* best-effort */ }
}
