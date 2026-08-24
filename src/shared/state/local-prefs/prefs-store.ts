// src/shared/state/local-prefs/prefs-store.ts
// Prefs path resolution and the owner-stamped file lock with stale reap;
// read/write/update of the per-project prefs file.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { readOwnerEntry } from '../../bounded-read';
import { trustworthyAgeSince } from '../../clock-skew';
import { readJson } from '../../fsjson';
import { dirOwnsProject, projectMembershipRoot } from '../../project-membership';
import { sha256 } from '../../text';
import {
  globalTrafficOneDir,
} from '../traffic-one-paths';
import {
  canonicalOpenCodeSource,
} from '../canonicalize';
import { stateTimestamp } from '../io';
import { initializeLocalToolchainState } from '../toolchain';

import {
  HOST_PREF_KEYS,
  RETIRED_LOCAL_PREF_KEYS,
  canonicalHostKey,
  normalizeHostPrefs,
} from './pref-schema';
import { writeProjectRootSidecarAt } from './project-root-sidecar';

// THE project bucket name. Three things key off it and they must agree:
// per-project prefs (which is where the use-plugin CONSENT answer lives), the
// operator override ledger (shared/override/paths.ts), and the OpenCode project
// agent-name prefix (shared/materialize/opencode-assets.ts).
//
// KNOWN ASYMMETRY, deliberately left in place: `fs.realpathSync` resolves
// symlinks but does NOT case-fold, while `fs.realpathSync.native` DOES (measured
// on APFS — `.../MyProj` given as `.../myproj` comes back `myproj` from the JS
// implementation and `MyProj` from the native one). So on a case-insensitive
// volume `/Users/u/Proj` and `/Users/u/proj` are ONE directory that hashes to
// TWO buckets: two consent records, two prefs files, two override ledgers for
// one project. Symlink spellings are already folded together; only CASE splits.
//
// Do NOT "fix" this by switching to `.native`, and the reason is NOT the one
// stated here and in shared/override/paths.ts until this round. MEASURED on
// this machine (APFS, case-insensitive): the CANONICAL spelling comes back
// identical from both implementations, so the swap does not move the bucket of
// a project reached by its true spelling, and it does not invalidate an
// override token minted there. What it moves is exactly the MISCASED buckets —
// and that is the real cost, because a machine whose operator has always used
// the miscased spelling has its one LIVE bucket there. Relocating it is
// indistinguishable, to every reader, from the bucket having been deleted: the
// consent answer and host prefs are gone (the project is re-asked the
// use-plugin question, and writes are refused until it is answered), and the
// override ledger AND its mint counter move together to a fresh empty pair,
// which is a free erasure of an audit trail, performed by an upgrade, on a
// machine that did nothing. A real fix has to READ BOTH SPELLINGS AND MIGRATE,
// under a lock, once — for that reason rather than for the token one.
//
// Until that exists the asymmetry is the cheaper defect, and
// shared/__tests__/path-spelling-contract.test.ts pins it so the swap cannot be
// made silently.
export function projectRootHash(cwd: string): string {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(cwd));
  } catch {
    root = path.resolve(cwd);
  }
  return sha256(root);
}

export function defaultProjectPrefsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(globalTrafficOneDir(env), 'projects', projectRootHash(cwd), 'preferences.json');
}

export function projectPrefsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH) return path.resolve(env.TRAFFIC_ONE_PROJECT_PREFS_PATH);
  return defaultProjectPrefsPath(cwd, env);
}

export const PROJECT_PREFS_LOCK_TIMEOUT_MS = 1_000;
const PROJECT_PREFS_LOCK_RETRY_MS = 10;
const PROJECT_PREFS_LOCK_STALE_MS = 10_000;

interface ProjectPrefsLock {
  readonly dirPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

interface ProjectPrefsLockOwner {
  readonly ownerPath: string;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // SharedArrayBuffer can be unavailable in constrained hook runtimes. The
    // deadline still bounds the retry loop.
  }
}

function observedProjectPrefsLockOwner(lockPath: string): ProjectPrefsLockOwner | null {
  try {
    const entries = fs.readdirSync(lockPath).filter((name) => /^owner-[a-f0-9]+\.json$/.test(name));
    if (entries.length !== 1) return null;
    const ownerName = entries[0]!;
    const ownerPath = path.join(lockPath, ownerName);
    // BOUNDED (shared/bounded-read.ts) — the fourth port of
    // state/project-state-lock.ts's `observedLockOwner`, and the property that
    // did not travel with the other three is the one that bounds the read.
    // Anything but a regular file is not a record this protocol wrote; the
    // abandoned arm then decides on presence plus age.
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

// Remove only the exact owner file we observed. If another process replaced the
// stale lock in the meantime, unlink/rmdir cannot remove its fresh owner.
function reapObservedProjectPrefsLock(lockPath: string, owner: ProjectPrefsLockOwner): boolean {
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

function reapAbandonedEmptyProjectPrefsLock(lockPath: string, now: number): boolean {
  try {
    if (fs.readdirSync(lockPath).length !== 0) return false;
    // Left as a raw subtraction on purpose; see the same note in
    // one-mcp/cache-lock.ts. `rename(dir, EMPTY dir)` succeeds, so an empty
    // canonical lock is overwritten rather than contended and this reap is not
    // on the acquisition path. A negative age here costs a retry, not a wedge.
    if (now - fs.statSync(lockPath).mtimeMs <= PROJECT_PREFS_LOCK_STALE_MS) return false;
    fs.rmdirSync(lockPath);
    return true;
  } catch {
    // A legacy publisher or another recovery contender won the race.
    return false;
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

function acquireProjectPrefsLock(filePath: string): ProjectPrefsLock {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + PROJECT_PREFS_LOCK_TIMEOUT_MS;

  // Publish a fully formed lock directory with one atomic rename. No contender
  // can observe the canonical path in the gap between mkdir and owner creation.
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
        const owner = observedProjectPrefsLockOwner(lockPath);
        // A future-stamped sentinel makes this age negative, i.e. never stale,
        // so a dead owner's lock wedged every prefs write for the full timeout
        // (measured: 1002ms and a throw, against 0.93ms past-stamped). An age no
        // clock could produce does not veto the reap; `processAlive` still does,
        // so a live owner is never evicted on the strength of its stamp.
        const ownerAgeMs = owner ? trustworthyAgeSince(owner.createdAt, now) : null;
        if (owner && (ownerAgeMs === null || ownerAgeMs > PROJECT_PREFS_LOCK_STALE_MS)
          && !processAlive(owner.pid) && reapObservedProjectPrefsLock(lockPath, owner)) continue;
        if (!owner && reapAbandonedEmptyProjectPrefsLock(lockPath, now)) continue;
        if (now >= deadline) {
          throw new Error(`traffic-one project preferences lock timed out after ${PROJECT_PREFS_LOCK_TIMEOUT_MS}ms`);
        }
        sleepSync(Math.min(PROJECT_PREFS_LOCK_RETRY_MS, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function releaseProjectPrefsLock(lock: ProjectPrefsLock): void {
  const releasedPath = `${lock.dirPath}.${lock.token}.released`;
  try {
    // BOUNDED: the ownership proof reads a path inside the lock directory, so a
    // shape that never answers can be substituted for our own owner file and
    // hang the release with the work already done and the lease still held.
    const bytes = readOwnerEntry(lock.ownerPath);
    if (bytes === null) return;
    const raw = JSON.parse(bytes) as Record<string, unknown>;
    if (raw.token !== lock.token) return;
    // Atomically vacate the canonical lock path before best-effort cleanup, so
    // an interrupted release cannot leave an empty directory that wedges prefs.
    fs.renameSync(lock.dirPath, releasedPath);
  } catch {
    // Already removed or replaced. Never remove a lock we cannot prove we own.
    return;
  }
  try { fs.rmSync(releasedPath, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export function withProjectPrefsLock<T>(filePath: string, body: () => T): T {
  const lock = acquireProjectPrefsLock(filePath);
  try {
    return body();
  } finally {
    releaseProjectPrefsLock(lock);
  }
}

export function writeProjectPrefsFile(filePath: string, prefs: Rec): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(prefs, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmpPath, 0o600); } catch { /* best-effort */ }
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw error;
  }
}

export function normalizeProjectPrefs(prefs: unknown): Rec {
  const base = obj(prefs);
  if (!base) return {};
  const out: Rec = { ...base };

  // codeGraphProvider is machine-wide now (one.json), not a per-project pref —
  // strip any stale value left in an old preferences.json.
  if (Object.prototype.hasOwnProperty.call(out, 'codeGraphProvider')) {
    delete out.codeGraphProvider;
  }
  // Preserve an explicit boolean; strip invalid values. Do NOT invent `true`
  // for an in-memory object that merely lacks the key — that is the new-project
  // trap (open-code writes a file, next read would skip the picker). Grandfather
  // of a legacy on-disk file belongs in readProjectPrefs only.
  if (out.codeGraphAcknowledged === true) out.codeGraphAcknowledged = true;
  else if (out.codeGraphAcknowledged === false) out.codeGraphAcknowledged = false;
  else delete out.codeGraphAcknowledged;
  // Pre-release One MCP acknowledgement shapes are intentionally not migrated.
  // The canonical acknowledgement now lives in hosts.<host>.performance.target.
  for (const key of RETIRED_LOCAL_PREF_KEYS) delete out[key];

  // Legacy generic performance/team belong to no specific host. Dropping them
  // intentionally makes the first access on every host reopen Performance.
  for (const key of HOST_PREF_KEYS) delete out[key];

  const rawHosts = obj(base.hosts);
  const hosts: Rec = rawHosts ? { ...rawHosts } : {};
  if (rawHosts) {
    for (const [rawHost, value] of Object.entries(rawHosts)) {
      const host = canonicalHostKey(rawHost);
      if (!host) {
        if (rawHost === '__proto__' || rawHost === 'constructor' || rawHost === 'prototype') {
          delete hosts[rawHost];
        }
        continue;
      }
      const normalized = normalizeHostPrefs(host, value);
      if (normalized) hosts[host] = normalized;
      else delete hosts[host];
    }
  }
  if (Object.keys(hosts).length > 0) out.hosts = hosts;
  else delete out.hosts;

  const toolchain = obj(out.toolchain);
  if (toolchain) {
    const normalizedToolchain = initializeLocalToolchainState(toolchain);
    out.toolchain = normalizedToolchain;
  }

  const openCode = obj(out.openCode);
  if (openCode) {
    out.openCode = {
      ...openCode,
      enabled: openCode.enabled === true,
      source: canonicalOpenCodeSource(openCode.source),
      decidedAt: typeof openCode.decidedAt === 'string' && openCode.decidedAt.trim()
        ? openCode.decidedAt
        : stateTimestamp(),
    };
  }

  return out;
}

export function readProjectPrefs(cwd: string, env: NodeJS.ProcessEnv = process.env): Rec {
  const prefsPath = projectPrefsPath(cwd, env);
  const raw = readJson(prefsPath, null);
  const rawObj = obj(raw);
  if (rawObj && Object.keys(rawObj).length > 0) {
    // Upgrade path: a prefs file that already existed without the field is a
    // finished project. Missing/empty files stay unacked so the picker shows.
    if (!Object.prototype.hasOwnProperty.call(rawObj, 'codeGraphAcknowledged')) {
      return normalizeProjectPrefs({ ...rawObj, codeGraphAcknowledged: true });
    }
    return normalizeProjectPrefs(rawObj);
  }
  return normalizeProjectPrefs({});
}

// New onboarding sessions must persist an explicit boolean so a later
// readProjectPrefs does not grandfather the file as already-acked.
function persistCodeGraphAcknowledged(prefs: Rec): Rec {
  if (prefs.codeGraphAcknowledged === true) return prefs;
  return { ...prefs, codeGraphAcknowledged: false };
}

export function writeProjectPrefs(cwd: string, prefs: unknown, env: NodeJS.ProcessEnv = process.env): Rec {
  const normalized = persistCodeGraphAcknowledged(normalizeProjectPrefs(prefs));
  const prefsPath = projectPrefsPath(cwd, env);
  withProjectPrefsLock(prefsPath, () => writeProjectPrefsFile(prefsPath, normalized));
  writeProjectRootSidecarAt(prefsPath, cwd);
  return normalized;
}

export function updateProjectPrefs(
  cwd: string,
  env: NodeJS.ProcessEnv,
  update: (current: Rec) => Rec,
): Rec {
  const prefsPath = projectPrefsPath(cwd, env);
  // Never CREATE a per-project prefs root for a directory that belongs to an
  // enclosing project. These live outside the repo keyed by a hash of the directory,
  // so a mis-resolved root leaves an invisible stray: observed live, a Go PACKAGE
  // (`mercury/strategies`) accrued its own consent + wizard answers. Creation-time
  // only — an existing prefs file keeps updating, so a legitimately nested project
  // and an already-strayed root are both left writable.
  if (!fs.existsSync(prefsPath)
    && !dirOwnsProject(cwd)
    && projectMembershipRoot(path.dirname(path.resolve(cwd))) !== null) {
    return readProjectPrefs(cwd, env);
  }
  const next = withProjectPrefsLock(prefsPath, () => {
    // Re-read only after acquiring the cross-process lock. This is the
    // load-bearing part of the read-merge-write protocol: reading beforehand
    // would still let a Cursor capture overwrite a parallel Performance answer.
    const normalized = persistCodeGraphAcknowledged(normalizeProjectPrefs(update(readProjectPrefs(cwd, env))));
    writeProjectPrefsFile(prefsPath, normalized);
    return normalized;
  });
  writeProjectRootSidecarAt(prefsPath, cwd);
  return next;
}

