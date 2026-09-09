// src/shared/state/local-prefs/prefs-store.ts
// Prefs path resolution and the owner-stamped file lock with stale reap;
// read/write/update of the per-project prefs file.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { readJson } from '../../fsjson';
import {
  acquirePerUserDirLock,
  releasePerUserDirLock,
} from '../../per-user-dir-lock';
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
import { readProjectRootSidecar, writeProjectRootSidecarAt } from './project-root-sidecar';

// THE project bucket name. Three things key off it and they must agree:
// per-project prefs (which is where the use-plugin CONSENT answer lives), the
// operator override ledger (shared/override/paths.ts), and the OpenCode project
// agent-name prefix (shared/materialize/opencode-assets.ts).
//
// `fs.realpathSync.native` returns the on-disk case (measured on APFS:
// `.../MyProj` given as `.../myproj` comes back `MyProj`). The JS
// `fs.realpathSync` returns the caller's case, so a case-insensitive volume
// used to hash `/Users/u/Proj` and `/Users/u/proj` to TWO buckets. The hash
// now uses `.native`. A one-time rename (migrateMiscasedPrefsBucket) moves the
// live miscased-hash folder onto the canonical name when that folder is
// absent — consent, prefs and the override ledger stay put rather than
// resetting. Tokens minted under the old hash keep matching via
// projectRootHashAliases (the MAC still covers the original projectKey).
function realpathNative(cwd: string): string {
  try {
    return fs.realpathSync.native(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

function realpathJs(cwd: string): string {
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

export function projectRootHash(cwd: string): string {
  return sha256(realpathNative(cwd));
}

/** The pre-native hash: JS realpath (symlinks folded, case preserved). */
export function legacyProjectRootHash(cwd: string): string {
  return sha256(realpathJs(cwd));
}

/** Native hash first, then the JS-realpath spelling when it differs. */
export function projectRootHashAliases(cwd: string): string[] {
  const native = projectRootHash(cwd);
  const js = legacyProjectRootHash(cwd);
  return native === js ? [native] : [native, js];
}

/** Rename parent/fromHash → parent/canonicalHash when dest is absent and src exists. */
export function migrateHashNamedFolder(parentDir: string, canonicalHash: string, fromHash: string): boolean {
  if (!fromHash || fromHash === canonicalHash) return false;
  const dest = path.join(parentDir, canonicalHash);
  const src = path.join(parentDir, fromHash);
  try {
    if (fs.existsSync(dest) || !fs.existsSync(src)) return false;
    fs.renameSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time prefs-bucket move. Returns the hash it renamed FROM, or null.
 * Looks at the JS-realpath spelling of `cwd` and at sibling buckets whose
 * `root` sidecar names this same on-disk directory.
 */
export function migrateMiscasedPrefsBucket(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const canonical = projectRootHash(cwd);
  const projects = path.join(globalTrafficOneDir(env), 'projects');
  const dest = path.join(projects, canonical);
  try {
    if (fs.existsSync(dest)) return null;
  } catch {
    return null;
  }

  const candidates = new Set<string>([legacyProjectRootHash(cwd)]);
  let names: string[] = [];
  try {
    names = fs.readdirSync(projects);
  } catch {
    names = [];
  }
  const want = realpathNative(cwd);
  for (const name of names) {
    if (name === canonical) continue;
    const recorded = readProjectRootSidecar(path.join(projects, name));
    if (!recorded) continue;
    try {
      if (fs.realpathSync.native(path.resolve(recorded)) === want) candidates.add(name);
    } catch {
      /* sidecar names a path we cannot resolve */
    }
  }

  for (const from of candidates) {
    if (migrateHashNamedFolder(projects, canonical, from)) return from;
  }
  return null;
}

export function defaultProjectPrefsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  migrateMiscasedPrefsBucket(cwd, env);
  return path.join(globalTrafficOneDir(env), 'projects', projectRootHash(cwd), 'preferences.json');
}

export function projectPrefsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH) return path.resolve(env.TRAFFIC_ONE_PROJECT_PREFS_PATH);
  return defaultProjectPrefsPath(cwd, env);
}

export const PROJECT_PREFS_LOCK_TIMEOUT_MS = 1_000;
const PROJECT_PREFS_LOCK_RETRY_MS = 10;
const PROJECT_PREFS_LOCK_STALE_MS = 10_000;

function acquireProjectPrefsLock(filePath: string) {
  return acquirePerUserDirLock(filePath, {
    timeoutMs: PROJECT_PREFS_LOCK_TIMEOUT_MS,
    retryMs: PROJECT_PREFS_LOCK_RETRY_MS,
    staleMs: PROJECT_PREFS_LOCK_STALE_MS,
  });
}

/**
 * Run `body` while holding the per-user prefs lock. Returns undefined when
 * the lock times out — a refusal, not a throw — so a contended prefs write
 * cannot abort a hook.
 */
export function withProjectPrefsLock<T>(filePath: string, body: () => T): T | undefined {
  const lock = acquireProjectPrefsLock(filePath);
  if (!lock) return undefined;
  try {
    return body();
  } finally {
    releasePerUserDirLock(lock);
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
  const wrote = withProjectPrefsLock(prefsPath, () => {
    writeProjectPrefsFile(prefsPath, normalized);
    return true;
  });
  if (!wrote) return readProjectPrefs(cwd, env);
  writeProjectRootSidecarAt(prefsPath, cwd);
  return normalized;
}

// CREATE veto, extracted so `prefsCapableRoot` and the write path cannot drift.
// True → `updateProjectPrefs` returns the current read and does not mint a bucket.
// Write semantics stay "refuse CREATE on the child" — never redirect the write.
export function prefsCreateRefused(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !fs.existsSync(projectPrefsPath(dir, env))
    && !dirOwnsProject(dir)
    && projectMembershipRoot(path.dirname(path.resolve(dir))) !== null;
}

// The directory whose prefs bucket `updateProjectPrefs` will actually accept.
// Same three clauses as the CREATE veto (no ceiling): an existing hash-keyed file
// keeps an already-strayed root writable; a dir that owns a project writes itself;
// a marker-less child of an enclosing membership is not capable — the enclosing
// project is. Genuinely unclaimed dirs stay themselves. This primitive NAMES the
// capable root; it does not change who the write lands on.
//
// Always absolute: later layers embed this return in `--use`/`--decline` argv,
// and `onboardingRunnerInvocation` rejects a non-absolute cwd. A relative
// spelling (`strategies`, `./pmax-images`) would fail the allow-list.
export function prefsCapableRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = path.resolve(dir);
  if (!prefsCreateRefused(dir, env)) return resolved;
  return projectMembershipRoot(path.dirname(resolved)) ?? resolved;
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
  if (prefsCreateRefused(cwd, env)) {
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
  if (next === undefined) return readProjectPrefs(cwd, env);
  writeProjectRootSidecarAt(prefsPath, cwd);
  return next;
}

