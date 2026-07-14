// src/shared/one-settings.ts
// The single owner of ~/.traffic-one/one.json — the consolidated GLOBAL, per-user
// settings file. It replaces the old three-way split (auth.json + auth-choice.json
// + a per-project codeGraphProvider): auth state, auth-choice state, the
// machine-wide code-graph provider, and per-host model catalogs now live as
// top-level SECTIONS of one file.
//
// Why consolidate: the code-graph provider becomes a machine-level setting so a
// provider already chosen/installed locally is reused across projects (onboarding
// stops re-prompting). Keeping auth + auth-choice alongside it means one secure
// (0o600) settings file instead of three.
//
// Concurrency: `auth` is written by the auth CLI process (scripts/traffic-one-auth.cjs)
// while `authChoice` is written by session hooks — possibly overlapping. Every
// mutation takes a bounded cross-process lock, RE-READS the file while holding it,
// patches only the touched section/host, and writes atomically (temp + rename).
// This preserves Claude/Codex/Cursor snapshots even when their SessionStart hooks
// overlap, without allowing a dead process to block settings forever.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOST_IDS, type HostModelKey } from '../config/model-tiers';
import { ONE_SETTINGS_VERSION } from '../config/one-settings';
import { readJson } from './fsjson';
import { parseHostModelSnapshot, type HostModelSnapshot } from './model-tiers';

export type OneSection = 'auth' | 'authChoice' | 'codeGraphProvider' | 'hosts';

export type OneHostSettings = HostModelSnapshot;
export type OneHostSettingsMap = Partial<Record<HostModelKey, OneHostSettings>>;

export interface OneSettings {
  schemaVersion: number;
  auth?: Record<string, unknown> | null;
  authChoice?: Record<string, unknown> | null;
  codeGraphProvider?: string | null;
  hosts: OneHostSettingsMap;
}

export type OneSettingsPatch = Omit<Partial<OneSettings>, 'hosts'> & {
  hosts?: Partial<Record<HostModelKey, OneHostSettings | null>>;
};

export const ONE_SETTINGS_LOCK_TIMEOUT_MS = 500;
const ONE_SETTINGS_LOCK_RETRY_MS = 10;
const ONE_SETTINGS_LOCK_STALE_MS = 10_000;

// Legacy global files superseded by one.json. Hard cutover: never READ, just
// best-effort removed on the first write so stale copies don't linger.
const LEGACY_BASENAMES = ['auth.json', 'auth-choice.json'];

function settingsDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
}

// TRAFFIC_ONE_STATE_PATH is the new canonical override; TRAFFIC_ONE_AUTH_STATE_PATH
// is honored as a back-compat alias (it used to point at auth.json — now it points
// the whole file at one.json) so existing callers/tests keep working.
export function oneSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TRAFFIC_ONE_STATE_PATH || env.TRAFFIC_ONE_AUTH_STATE_PATH;
  if (override) return path.resolve(override);
  return path.join(settingsDir(env), 'one.json');
}

export function readOneSettings(env: NodeJS.ProcessEnv = process.env): OneSettings {
  const raw = readJson<Record<string, unknown> | null>(oneSettingsPath(env), null);
  if (!raw || typeof raw !== 'object') {
    return { schemaVersion: ONE_SETTINGS_VERSION, auth: null, authChoice: null, codeGraphProvider: null, hosts: {} };
  }
  const hosts: OneHostSettingsMap = {};
  const rawHosts = raw.hosts;
  if (rawHosts && typeof rawHosts === 'object' && !Array.isArray(rawHosts)) {
    for (const host of HOST_IDS) {
      const parsed = parseHostModelSnapshot((rawHosts as Record<string, unknown>)[host], host);
      if (parsed) hosts[host] = parsed;
    }
  }
  return {
    schemaVersion: typeof raw.schemaVersion === 'number'
      ? raw.schemaVersion
      : (typeof raw.version === 'number' ? raw.version : ONE_SETTINGS_VERSION),
    auth: raw.auth && typeof raw.auth === 'object' ? (raw.auth as Record<string, unknown>) : null,
    authChoice: raw.authChoice && typeof raw.authChoice === 'object' ? (raw.authChoice as Record<string, unknown>) : null,
    codeGraphProvider: typeof raw.codeGraphProvider === 'string' ? raw.codeGraphProvider : null,
    hosts,
  };
}

export function readOneHostSettings(
  host: HostModelKey,
  env: NodeJS.ProcessEnv = process.env,
): OneHostSettings | null {
  return readOneSettings(env).hosts[host] ?? null;
}

// Best-effort removal of the legacy split files (hard cutover). Silent on any error.
// ONLY at the DEFAULT location: when a path override/alias is set (tests, custom
// installs) the active one.json may itself be named auth.json — or sit beside an
// auth-choice override file — and must never be deleted.
function removeLegacyFiles(env: NodeJS.ProcessEnv): void {
  if (env.TRAFFIC_ONE_STATE_PATH || env.TRAFFIC_ONE_AUTH_STATE_PATH) return;
  const dir = path.dirname(oneSettingsPath(env));
  for (const name of LEGACY_BASENAMES) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // best-effort
    }
  }
}

function writeWholeFile(filePath: string, settings: OneSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod
  }
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

interface SettingsLock {
  readonly dirPath: string;
  readonly ownerPath: string;
  readonly token: string;
}

interface SettingsLockOwner {
  readonly ownerPath: string;
  readonly token: string;
  readonly pid: number;
  readonly createdAt: number;
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    // SharedArrayBuffer can be unavailable in a constrained runtime. The lock is
    // still bounded by the deadline; the loop simply retries without sleeping.
  }
}

function observedLockOwner(lockPath: string): SettingsLockOwner | null {
  try {
    const entries = fs.readdirSync(lockPath).filter((name) => /^owner-[a-f0-9]+\.json$/.test(name));
    // An empty directory may be between mkdir and owner publication. Multiple
    // owners indicate corruption or a concurrent recovery; neither is safe to
    // reap by guessing.
    if (entries.length !== 1) return null;
    const ownerName = entries[0] as string;
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

// Reap only the owner filename that was actually observed. If another process
// replaced the stale directory with a fresh lock in the meantime, the old
// owner filename is absent and unlink fails; rmdir also refuses the fresh,
// non-empty directory. This token-addressed directory protocol avoids the
// stale-check/unlink TOCTOU of a single pathname lock file.
function reapObservedLock(lockPath: string, owner: SettingsLockOwner): boolean {
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function acquireSettingsLock(filePath: string): SettingsLock {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid.toString(16)}${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const ownerName = `owner-${token}.json`;
  const pendingPath = `${lockPath}.${token}.pending`;
  const deadline = Date.now() + ONE_SETTINGS_LOCK_TIMEOUT_MS;

  // Publish a fully formed, non-empty directory with one atomic rename. The
  // canonical lock path is therefore never observable between mkdir and owner
  // creation, eliminating the empty-directory recovery race entirely.
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
        const owner = observedLockOwner(lockPath);
        if (owner && now - owner.createdAt > ONE_SETTINGS_LOCK_STALE_MS
          && !processAlive(owner.pid) && reapObservedLock(lockPath, owner)) {
          continue;
        }
        if (now >= deadline) throw new Error(`traffic-one settings lock timed out after ${ONE_SETTINGS_LOCK_TIMEOUT_MS}ms`);
        sleepSync(Math.min(ONE_SETTINGS_LOCK_RETRY_MS, deadline - now));
      }
    }
  } finally {
    if (!acquired) {
      try { fs.rmSync(pendingPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function releaseSettingsLock(lock: SettingsLock): void {
  try {
    const raw = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8')) as Record<string, unknown>;
    if (raw.token !== lock.token) return;
    fs.unlinkSync(lock.ownerPath);
    fs.rmdirSync(lock.dirPath);
  } catch {
    // Already removed/replaced. Never unlink a lock we cannot prove we own.
  }
}

function withSettingsLock<T>(filePath: string, body: () => T): T {
  const lock = acquireSettingsLock(filePath);
  try {
    return body();
  } finally {
    releaseSettingsLock(lock);
  }
}

function mergeSettings(current: OneSettings, patch: OneSettingsPatch): OneSettings {
  const hosts: OneHostSettingsMap = { ...current.hosts };
  if (patch.hosts !== undefined) {
    for (const [rawHost, value] of Object.entries(patch.hosts)) {
      if (!(HOST_IDS as readonly string[]).includes(rawHost)) {
        throw new TypeError(`invalid Traffic One settings host: ${rawHost}`);
      }
      const host = rawHost as HostModelKey;
      if (value === null) {
        delete hosts[host];
        continue;
      }
      const parsed = parseHostModelSnapshot(value, host);
      if (!parsed) throw new TypeError(`invalid Traffic One model snapshot for ${host}`);
      hosts[host] = parsed;
    }
  }
  const { hosts: _ignoredHosts, ...topLevelPatch } = patch;
  return {
    ...current,
    ...topLevelPatch,
    schemaVersion: ONE_SETTINGS_VERSION,
    hosts,
  };
}

// Atomically apply a partial patch (read-merge-write + temp/rename). This is the
// single low-level mutator everything goes through. A section set to null is
// retained as null (read as empty); use deleteOneSection to drop a key entirely.
export function updateOneSettings(patch: OneSettingsPatch, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = oneSettingsPath(env);
  withSettingsLock(filePath, () => {
    const current = readOneSettings(env);
    writeWholeFile(filePath, mergeSettings(current, patch));
  });
  removeLegacyFiles(env);
  return filePath;
}

export function writeOneSection<T>(section: OneSection, value: T, env: NodeJS.ProcessEnv = process.env): string {
  return updateOneSettings({ [section]: value } as OneSettingsPatch, env);
}

export function writeOneHostSettings(
  host: HostModelKey,
  value: OneHostSettings,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = parseHostModelSnapshot(value, host);
  if (!parsed) throw new TypeError(`invalid Traffic One model snapshot for ${host}`);
  return updateOneSettings({ hosts: { [host]: parsed } }, env);
}

// Remove ONE section (used by auth logout / clear). No-op if the file is absent.
export function deleteOneSection(section: OneSection, env: NodeJS.ProcessEnv = process.env): boolean {
  const filePath = oneSettingsPath(env);
  if (!fs.existsSync(filePath)) return true;
  try {
    withSettingsLock(filePath, () => {
      const current = readOneSettings(env);
      if (section === 'hosts') current.hosts = {};
      else delete current[section];
      writeWholeFile(filePath, { ...current, schemaVersion: ONE_SETTINGS_VERSION });
    });
    return true;
  } catch {
    return false;
  }
}
