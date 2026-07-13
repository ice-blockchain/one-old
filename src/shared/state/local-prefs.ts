// src/shared/state/local-prefs.ts
// Per-user, per-project runtime preferences (kept out of the repo-shared
// .one.json). Ported 1:1 from scripts/hook-runtime/state/local-prefs.cjs.

import { obj, type Rec } from '../obj';
import * as fs from 'fs';
import * as path from 'path';

import { HOST_IDS, type HostModelKey } from '../../config/model-tiers';
import { LEGACY_STATE_FILE, STATE_FILE } from '../../config/paths';
import { readJson } from '../fsjson';
import { detectHost } from '../host';
import { canonicalHost, canonicalPlan, planIsRecognized } from '../model-tiers';
import { readOneSettings, writeOneSection } from '../one-settings';
import { sha256 } from '../text';
import {
  ensureProjectLocalTrafficOneGitignore,
  globalTrafficOneDir,
  projectLocalMachinePath,
  projectLocalPrefsPath,
} from './traffic-one-paths';
import {
  canonicalOpenCodeSource,
  canonicalPerformanceLevel,
  canonicalTeamMode,
  canonicalTeamOverrides,
  canonicalTeamSource,
  codeGraphProviderFromValue,
  teamStateFromString,
} from './canonicalize';
import {
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
} from '../../config/state';
import { stateTimestamp } from './io';
import { initializeLocalToolchainState } from './toolchain';

function inSet(set: Set<string>, value: unknown): boolean {
  return typeof value === 'string' && set.has(value);
}

// Preferences that remain shared by all hosts used by this user on this project.
// codeGraphProvider is intentionally NOT here: it is MACHINE-WIDE (one.json).
const PROJECT_PREF_KEYS = new Set([
  'openCode', 'toolchain',
  'codeGraphAutoRun', 'graphifyAutoRun', 'graphifyLastHintedAt', 'graphifyLastRunAt',
  'graphifyLastErrorAt', 'graphifyLastError', 'gitnexusLastRunAt', 'gitnexusLastErrorAt', 'gitnexusLastError',
]);

// Runtime projects these fields from prefs.hosts[activeHost] onto effective
// state. Their old top-level form is recognized only so it can be stripped; it
// is never assigned to a host implicitly.
const HOST_PREF_KEYS = new Set(['performance', 'team', 'configuredFor', 'availableModels']);

export const LOCAL_PREF_KEYS = new Set([
  ...PROJECT_PREF_KEYS,
  ...HOST_PREF_KEYS,
  'hosts',
]);

function knownHost(value: string): value is HostModelKey {
  return (HOST_IDS as readonly string[]).includes(value);
}

function canonicalHostKey(value: unknown): HostModelKey | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return knownHost(normalized) ? normalized : null;
}

function validDateStamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function normalizePerformance(value: unknown): Rec | null {
  if (typeof value === 'string') {
    const level = canonicalPerformanceLevel(value);
    return typeof level === 'string' && PERFORMANCE_LEVEL_IDS.has(level)
      ? { level, source: 'prompted' }
      : null;
  }
  const perf = obj(value);
  if (!perf) return null;
  const level = canonicalPerformanceLevel(perf.level);
  if (typeof level !== 'string' || !PERFORMANCE_LEVEL_IDS.has(level)) return null;
  const rawSource = typeof perf.source === 'string'
    ? perf.source.trim().toLowerCase().replace(/[_\s]+/g, '-')
    : 'prompted';
  return {
    ...perf,
    level,
    source: PERFORMANCE_SOURCE_IDS.has(rawSource) ? rawSource : 'prompted',
  };
}

function normalizeTeam(value: unknown, performance: unknown): Rec | null {
  const fromString = typeof value === 'string' ? teamStateFromString(value) : null;
  const team = fromString || obj(value);
  if (!team) return null;
  const perf = obj(performance);
  const performanceLevel = perf ? perf.level : null;
  const normalized: Rec = {
    ...team,
    mode: canonicalTeamMode(team.mode),
    source: canonicalTeamSource((team.source as string) || 'prompted'),
  };
  const normalizedOverrides = canonicalTeamOverrides(team.overrides, performanceLevel);
  if (normalizedOverrides) normalized.overrides = normalizedOverrides;
  else delete normalized.overrides;
  if (team.approved === true) normalized.approved = true;
  else delete normalized.approved;
  if (normalized.mode !== 'subagents') delete normalized.modeChangeApproval;
  return inSet(TEAM_MODE_IDS, normalized.mode) && inSet(TEAM_SOURCE_IDS, normalized.source)
    ? normalized
    : null;
}

function normalizeConfiguredFor(host: HostModelKey, value: unknown): Rec | null {
  const configured = obj(value);
  if (!configured || !planIsRecognized(configured.plan) || !validDateStamp(configured.modelsUpdatedAt)) return null;
  return {
    plan: canonicalPlan(host, configured.plan),
    modelsUpdatedAt: configured.modelsUpdatedAt,
  };
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeAvailableModels(host: HostModelKey, value: unknown): Rec | null {
  if (host !== 'cursor') return null;
  const capture = obj(value);
  if (!capture || !Array.isArray(capture.models) || !planIsRecognized(capture.plan)
    || !validDateStamp(capture.modelsUpdatedAt)
    || typeof capture.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(capture.capturedAt))) return null;
  const models = [...new Set(capture.models.filter(validModelId).map((model) => model.trim()))];
  if (models.length === 0) return null;
  return {
    models,
    plan: canonicalPlan('cursor', capture.plan),
    modelsUpdatedAt: capture.modelsUpdatedAt,
    capturedAt: capture.capturedAt.trim(),
  };
}

function normalizeHostPrefs(host: HostModelKey, value: unknown): Rec | null {
  const raw = obj(value);
  if (!raw) return null;
  const out: Rec = {};
  const performance = normalizePerformance(raw.performance);
  if (performance) out.performance = performance;
  const team = normalizeTeam(raw.team, performance);
  if (team) out.team = team;
  const configuredFor = normalizeConfiguredFor(host, raw.configuredFor);
  if (configuredFor) out.configuredFor = configuredFor;
  const availableModels = normalizeAvailableModels(host, raw.availableModels);
  if (availableModels) out.availableModels = availableModels;
  return Object.keys(out).length > 0 ? out : null;
}

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
        if (owner && now - owner.createdAt > PROJECT_PREFS_LOCK_STALE_MS
          && !processAlive(owner.pid) && reapObservedProjectPrefsLock(lockPath, owner)) continue;
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
  try {
    const raw = JSON.parse(fs.readFileSync(lock.ownerPath, 'utf8')) as Record<string, unknown>;
    if (raw.token !== lock.token) return;
    fs.unlinkSync(lock.ownerPath);
    fs.rmdirSync(lock.dirPath);
  } catch {
    // Already removed or replaced. Never remove a lock we cannot prove we own.
  }
}

function withProjectPrefsLock<T>(filePath: string, body: () => T): T {
  const lock = acquireProjectPrefsLock(filePath);
  try {
    return body();
  } finally {
    releaseProjectPrefsLock(lock);
  }
}

function writeProjectPrefsFile(filePath: string, prefs: Rec): void {
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

  // Legacy generic performance/team belong to no specific host. Dropping them
  // intentionally makes the first access on every host reopen Performance.
  for (const key of HOST_PREF_KEYS) delete out[key];

  const rawHosts = obj(base.hosts);
  const hosts: Rec = {};
  if (rawHosts) {
    for (const [rawHost, value] of Object.entries(rawHosts)) {
      const host = canonicalHostKey(rawHost);
      if (!host) continue;
      const normalized = normalizeHostPrefs(host, value);
      if (normalized) hosts[host] = normalized;
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
  if (raw && typeof raw === 'object' && Object.keys(obj(raw) || {}).length > 0) {
    return normalizeProjectPrefs(raw);
  }
  // Legacy OpenCode project-local prefs (pre global ~/.traffic-one parity).
  const legacy = projectLocalPrefsPath(cwd);
  if (legacy !== prefsPath) {
    const legacyRaw = readJson(legacy, null);
    if (legacyRaw && typeof legacyRaw === 'object' && Object.keys(obj(legacyRaw) || {}).length > 0) {
      return normalizeProjectPrefs(legacyRaw);
    }
  }
  // Compatibility for the host-env migration: a newer host may force
  // project-local prefs while a just-completed wizard or older install wrote the
  // previous hashed per-project prefs under ~/.traffic-one/projects/<hash>.
  const hashed = defaultProjectPrefsPath(cwd, env);
  if (hashed !== prefsPath && hashed !== legacy) {
    const hashedRaw = readJson(hashed, null);
    if (hashedRaw && typeof hashedRaw === 'object' && Object.keys(obj(hashedRaw) || {}).length > 0) {
      return normalizeProjectPrefs(hashedRaw);
    }
  }
  return normalizeProjectPrefs({});
}

export function writeProjectPrefs(cwd: string, prefs: unknown, env: NodeJS.ProcessEnv = process.env): Rec {
  const normalized = normalizeProjectPrefs(prefs);
  const prefsPath = projectPrefsPath(cwd, env);
  withProjectPrefsLock(prefsPath, () => writeProjectPrefsFile(prefsPath, normalized));
  if (prefsPath === projectLocalPrefsPath(cwd)) {
    ensureProjectLocalTrafficOneGitignore(cwd);
  }
  return normalized;
}

function updateProjectPrefs(
  cwd: string,
  env: NodeJS.ProcessEnv,
  update: (current: Rec) => Rec,
): Rec {
  const prefsPath = projectPrefsPath(cwd, env);
  const next = withProjectPrefsLock(prefsPath, () => {
    // Re-read only after acquiring the cross-process lock. This is the
    // load-bearing part of the read-merge-write protocol: reading beforehand
    // would still let a Cursor capture overwrite a parallel Performance answer.
    const normalized = normalizeProjectPrefs(update(readProjectPrefs(cwd, env)));
    writeProjectPrefsFile(prefsPath, normalized);
    return normalized;
  });
  if (prefsPath === projectLocalPrefsPath(cwd)) ensureProjectLocalTrafficOneGitignore(cwd);
  return next;
}

function mergePlainObject(current: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return { ...(patch as Rec) };
  return { ...(current as Rec), ...(patch as Rec) };
}

function mergeHostPrefsEntry(current: unknown, patch: unknown): Rec {
  const currentHost = obj(current) || {};
  const patchHost = obj(patch) || {};
  const next: Rec = { ...currentHost, ...patchHost };
  if (Object.prototype.hasOwnProperty.call(patchHost, 'performance')) {
    const p = obj(patchHost.performance);
    next.performance = p && !Object.prototype.hasOwnProperty.call(p, 'level')
      ? mergePlainObject(currentHost.performance, patchHost.performance)
      : patchHost.performance;
  }
  if (Object.prototype.hasOwnProperty.call(patchHost, 'team')) {
    const t = obj(patchHost.team);
    next.team = t && !Object.prototype.hasOwnProperty.call(t, 'mode')
      ? mergePlainObject(currentHost.team, patchHost.team)
      : patchHost.team;
  }
  if (Object.prototype.hasOwnProperty.call(patchHost, 'configuredFor')) {
    next.configuredFor = mergePlainObject(currentHost.configuredFor, patchHost.configuredFor);
  }
  if (Object.prototype.hasOwnProperty.call(patchHost, 'availableModels')) {
    const capture = obj(patchHost.availableModels);
    next.availableModels = capture && !Object.prototype.hasOwnProperty.call(capture, 'models')
      ? mergePlainObject(currentHost.availableModels, patchHost.availableModels)
      : patchHost.availableModels;
  }
  return next;
}

function mergeProjectPrefsObject(current: Rec, patch: unknown, activeHost: HostModelKey = detectHost()): Rec {
  const patchObj = obj(patch);
  const normalizedCurrent = normalizeProjectPrefs(current);
  const next: Rec = { ...normalizedCurrent };
  if (patchObj) {
    for (const [key, value] of Object.entries(patchObj)) {
      if (key !== 'hosts' && !HOST_PREF_KEYS.has(key)) next[key] = value;
    }

    const currentHosts = obj(normalizedCurrent.hosts) || {};
    const mergedHosts: Rec = { ...currentHosts };
    const explicitHosts = obj(patchObj.hosts);
    if (explicitHosts) {
      for (const [rawHost, value] of Object.entries(explicitHosts)) {
        const host = canonicalHostKey(rawHost);
        if (!host) continue;
        mergedHosts[host] = mergeHostPrefsEntry(currentHosts[host], value);
      }
    }
    const activePatch: Rec = {};
    for (const key of HOST_PREF_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patchObj, key)) activePatch[key] = patchObj[key];
    }
    if (Object.keys(activePatch).length > 0) {
      mergedHosts[activeHost] = mergeHostPrefsEntry(mergedHosts[activeHost], activePatch);
    }
    if (Object.keys(mergedHosts).length > 0) next.hosts = mergedHosts;
    else delete next.hosts;

    if (Object.prototype.hasOwnProperty.call(patchObj, 'openCode')) {
      const o = obj(patchObj.openCode);
      next.openCode = o && !Object.prototype.hasOwnProperty.call(o, 'enabled')
        ? mergePlainObject(normalizedCurrent.openCode, patchObj.openCode)
        : patchObj.openCode;
    }
    const patchToolchain = obj(patchObj.toolchain);
    if (patchToolchain) {
      const currentToolchain = obj(normalizedCurrent.toolchain) || {};
      const merged: Rec = { ...currentToolchain };
      for (const [name, stamp] of Object.entries(patchToolchain)) {
        const combined = mergePlainObject(currentToolchain[name], stamp);
        // A null/empty installedVersion in the patch must never erase a real
        // stamp: normalize embeds the initialized-null toolchain skeleton in
        // shared state, so every writeState(readState(...)) round-trip carries
        // nulls here — letting them win would wipe a fresh install stamp (e.g.
        // the wizard's install task stamps OpenCode, then finalize's writeState
        // immediately un-stamps it and delegation silently never activates).
        const cur = obj(currentToolchain[name]);
        const out = obj(combined);
        const curVersion = cur && typeof cur.installedVersion === 'string' && cur.installedVersion ? cur.installedVersion : null;
        const outVersion = out && typeof out.installedVersion === 'string' && out.installedVersion ? out.installedVersion : null;
        merged[name] = curVersion && !outVersion && out
          ? {
            ...out,
            installedVersion: curVersion,
            installedAt: typeof cur?.installedAt === 'string' && cur.installedAt ? cur.installedAt : out.installedAt ?? null,
            ...(typeof cur?.binPath === 'string' && cur.binPath ? { binPath: cur.binPath } : {}),
          }
          : combined;
      }
      next.toolchain = merged;
    }
  }
  return normalizeProjectPrefs(next);
}

export function mergeProjectPrefs(cwd: string, patch: unknown, env: NodeJS.ProcessEnv = process.env): Rec {
  return updateProjectPrefs(cwd, env, (current) => mergeProjectPrefsObject(current, patch, detectHost(env)));
}

export function mergeProjectHostPrefs(
  cwd: string,
  host: unknown,
  patch: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Rec {
  const activeHost = canonicalHost(host);
  return updateProjectPrefs(cwd, env, (current) => mergeProjectPrefsObject(current, {
    hosts: { [activeHost]: patch },
  }, activeHost));
}

export function clearProjectHostPrefs(
  cwd: string,
  host: unknown,
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Rec {
  const activeHost = canonicalHost(host);
  return updateProjectPrefs(cwd, env, (prefs) => {
    const hosts = obj(prefs.hosts) || {};
    const current = obj(hosts[activeHost]);
    if (!current) return prefs;
    const nextHost: Rec = { ...current };
    for (const key of keys) {
      if (HOST_PREF_KEYS.has(key)) delete nextHost[key];
    }
    const nextHosts: Rec = { ...hosts };
    if (Object.keys(nextHost).length > 0) nextHosts[activeHost] = nextHost;
    else delete nextHosts[activeHost];
    const next: Rec = { ...prefs };
    if (Object.keys(nextHosts).length > 0) next.hosts = nextHosts;
    else delete next.hosts;
    return next;
  });
}

export function hasLocalPreferenceFields(value: unknown): boolean {
  const v = obj(value);
  if (!v) return false;
  if (Object.keys(v).some((key) => LOCAL_PREF_KEYS.has(key) || key === 'codeGraph' || key === 'subagentTeam')) {
    return true;
  }
  const stack = obj(v.stack);
  return Boolean(stack && (
    Object.prototype.hasOwnProperty.call(stack, 'codeGraph')
    || Object.prototype.hasOwnProperty.call(stack, 'codeGraphProvider')
  ));
}

export function extractProjectPrefs(value: unknown): Rec {
  const source = obj(value) || {};
  const prefs: Rec = {};
  for (const key of PROJECT_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) prefs[key] = source[key];
  }
  // A leaked NEW local shape can be rescued as-is. Legacy generic performance /
  // team are intentionally omitted so they cannot be attributed to whichever
  // host happens to scrub the shared file first.
  if (Object.prototype.hasOwnProperty.call(source, 'hosts')) prefs.hosts = source.hosts;
  const delegation = obj(source.openCodeDelegation);
  if (!prefs.openCode && typeof delegation?.approved === 'boolean') {
    prefs.openCode = {
      enabled: delegation.approved,
      source: 'prompted',
      ...(typeof delegation.decidedAt === 'string' && delegation.decidedAt.trim()
        ? { decidedAt: delegation.decidedAt }
        : {}),
    };
  }
  // codeGraphProvider is no longer extracted into per-project prefs — it is a
  // machine-wide setting (one.json) injected by applyGlobalCodeGraphProvider.
  return normalizeProjectPrefs(prefs);
}

export function stripLocalPreferenceFields(value: unknown): Rec {
  const out: Rec = obj(value) ? { ...(value as Rec) } : {};
  for (const key of LOCAL_PREF_KEYS) delete out[key];
  delete out.codeGraph;
  // codeGraphProvider is machine-wide (one.json) — keep it out of shared state.
  // (No longer covered by the LOCAL_PREF_KEYS loop above.)
  delete out.codeGraphProvider;
  delete out.subagentTeam;
  const stack = obj(out.stack);
  if (stack) {
    const nextStack: Rec = { ...stack };
    delete nextStack.codeGraph;
    delete nextStack.codeGraphProvider;
    out.stack = nextStack;
  }
  return out;
}

export interface SplitResult {
  state: Rec;
  prefs: Rec;
  changed: boolean;
}

export function splitLocalPreferences(cwd: string, state: unknown, env: NodeJS.ProcessEnv = process.env): SplitResult {
  const stateRec = obj(state) || {};
  if (!hasLocalPreferenceFields(state)) {
    return { state: stateRec, prefs: readProjectPrefs(cwd, env), changed: false };
  }
  const localPatch = extractProjectPrefs(state);
  const prefs = mergeProjectPrefs(cwd, localPatch, env);
  return { state: stripLocalPreferenceFields(state), prefs, changed: true };
}

// ── Machine-wide code-graph provider (one.json, not per-project) ─────────────────
// The provider becomes a global setting so a provider already chosen/installed
// locally is reused across projects (onboarding stops re-prompting).

export function readGlobalCodeGraphProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  return codeGraphProviderFromValue(readOneSettings(env).codeGraphProvider);
}

function readDefaultGlobalCodeGraphProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  const fallbackEnv = { ...env };
  delete fallbackEnv.TRAFFIC_ONE_STATE_PATH;
  delete fallbackEnv.TRAFFIC_ONE_AUTH_STATE_PATH;
  return codeGraphProviderFromValue(readOneSettings(fallbackEnv).codeGraphProvider);
}

export function writeGlobalCodeGraphProvider(provider: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const canonical = codeGraphProviderFromValue(provider);
  if (!canonical) return null;
  writeOneSection('codeGraphProvider', canonical, env);
  return canonical;
}

// Inject the machine-wide provider onto an ALREADY-effective state object, so every
// downstream `state.codeGraphProvider` consumer + the onboarding routers read it
// from the same place. Mutates and returns `state`. Used by readEffectiveState and
// by the doctor's raw-state path (which builds effectiveState directly).
export function applyGlobalCodeGraphProvider(
  state: Rec,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Rec {
  let provider = readGlobalCodeGraphProvider(env);
  if (!provider && cwd) {
    const legacyRaw = readJson(projectLocalMachinePath(cwd), null);
    if (legacyRaw && typeof legacyRaw === 'object') {
      provider = codeGraphProviderFromValue((legacyRaw as Rec).codeGraphProvider);
    }
  }
  if (!provider && cwd && env.TRAFFIC_ONE_STATE_PATH
    && path.resolve(env.TRAFFIC_ONE_STATE_PATH) === projectLocalMachinePath(cwd)) {
    provider = readDefaultGlobalCodeGraphProvider(env);
  }
  if (provider) state.codeGraphProvider = provider;
  else delete state.codeGraphProvider;
  return state;
}

export function effectiveState(projectState: unknown, prefs: unknown, host: unknown = detectHost()): Rec {
  const state: Rec = obj(projectState) ? { ...(projectState as Rec) } : {};
  const local = normalizeProjectPrefs(prefs);
  for (const key of PROJECT_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(local, key)) state[key] = local[key];
    else delete state[key];
  }
  for (const key of HOST_PREF_KEYS) delete state[key];
  delete state.hosts;
  const activeHost = canonicalHost(host);
  const hostPrefs = obj(obj(local.hosts)?.[activeHost]);
  if (hostPrefs) {
    for (const key of HOST_PREF_KEYS) {
      if (Object.prototype.hasOwnProperty.call(hostPrefs, key)) state[key] = hostPrefs[key];
    }
  }
  return state;
}

function readRawState(cwd: string): Rec {
  const currentPath = path.join(cwd, STATE_FILE);
  if (fs.existsSync(currentPath)) return readJson(currentPath, {});

  const oldPath = path.join(cwd, LEGACY_STATE_FILE);
  if (fs.existsSync(oldPath)) {
    const legacy = readJson<Rec>(oldPath, {});
    if (legacy && typeof legacy === 'object') legacy.legacyStateFile = LEGACY_STATE_FILE;
    return legacy;
  }

  // Lazy require breaks the normalize ↔ local-prefs cycle (matches legacy).
  const { readState } = require('./normalize') as typeof import('./normalize');
  return readState(cwd);
}

function normalizeRuntimeIds(state: Rec): Rec {
  if (typeof state.currentRunId === 'number' && Number.isFinite(state.currentRunId)) {
    state.currentRunId = String(Math.trunc(state.currentRunId));
  } else if (typeof state.currentRunId === 'string') {
    state.currentRunId = state.currentRunId.trim();
  }
  return state;
}

export function readEffectiveState(cwd: string, env: NodeJS.ProcessEnv = process.env): Rec {
  const state = readRawState(cwd);
  const embeddedPrefs = extractProjectPrefs(state);
  const prefs = Object.keys(embeddedPrefs).length > 0
    ? mergeProjectPrefsObject(readProjectPrefs(cwd, env), embeddedPrefs)
    : readProjectPrefs(cwd, env);
  return normalizeRuntimeIds(applyGlobalCodeGraphProvider(effectiveState(stripLocalPreferenceFields(state), prefs, detectHost(env)), env, cwd));
}
