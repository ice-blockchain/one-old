// src/shared/state/run-agent/locks.ts
// Generic owned-dir lock primitives: pid liveness, stale reclaim, acquire/
// release, and withOwnedDirLock. Domain wrappers keep their own
// SharedArrayBuffer wait singletons beside their stores.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';

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

function readOwnedLock(filePath: string): { pid: number; acquiredAt: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const record = obj(parsed);
    if (!record || typeof record.pid !== 'number' || typeof record.acquiredAt !== 'number') return null;
    return { pid: record.pid, acquiredAt: record.acquiredAt };
  } catch {
    return null;
  }
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
    if (!owner || Date.now() - owner.acquiredAt <= staleMs || !processDefinitelyDead(owner.pid)) return false;
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
  if (Date.now() - stat.mtimeMs <= staleMs || entries.length !== 0) return false;
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
  try { fs.mkdirSync(path.dirname(lockDir), { recursive: true }); } catch { return null; }
  while (true) {
    let madeDir = false;
    try {
      fs.mkdirSync(lockDir);
      madeDir = true;
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { flag: 'wx' });
      return { dir: lockDir, ownerFile };
    } catch {
      if (madeDir) {
        try { fs.unlinkSync(ownerFile); } catch { /* best-effort */ }
        try { fs.rmdirSync(lockDir); } catch { /* best-effort */ }
      }
      if (reclaimStaleOwnedDirLock(lockDir, staleMs)) continue;
      if (Date.now() >= deadline) return null;
      Atomics.wait(waitArray, 0, 0, retryMs);
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

