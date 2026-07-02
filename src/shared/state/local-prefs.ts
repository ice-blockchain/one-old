// src/shared/state/local-prefs.ts
// Per-user, per-project runtime preferences (kept out of the repo-shared
// .one.json). Ported 1:1 from scripts/hook-runtime/state/local-prefs.cjs.

import { obj, type Rec } from '../obj';
import * as fs from 'fs';
import * as path from 'path';

import { LEGACY_STATE_FILE, STATE_FILE } from '../../config/paths';
import { readJson, writeJson } from '../fsjson';
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
  overridesEqual,
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

// codeGraphProvider is intentionally NOT here: it is a MACHINE-WIDE setting (the
// codeGraphProvider section of one.json), injected into the effective state by
// applyGlobalCodeGraphProvider rather than carried per-project.
export const LOCAL_PREF_KEYS = new Set([
  'openCode', 'performance', 'team', 'toolchain',
  'codeGraphAutoRun', 'graphifyAutoRun', 'graphifyLastHintedAt', 'graphifyLastRunAt',
  'graphifyLastErrorAt', 'graphifyLastError', 'gitnexusLastRunAt', 'gitnexusLastErrorAt', 'gitnexusLastError',
]);

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

export function normalizeProjectPrefs(prefs: unknown): Rec {
  const base = obj(prefs);
  if (!base) return {};
  const out: Rec = { ...base };
  let changed = false;

  // codeGraphProvider is machine-wide now (one.json), not a per-project pref —
  // strip any stale value left in an old preferences.json.
  if (Object.prototype.hasOwnProperty.call(out, 'codeGraphProvider')) {
    delete out.codeGraphProvider;
    changed = true;
  }

  if (typeof out.performance === 'string') {
    const level = canonicalPerformanceLevel(out.performance);
    if (typeof level === 'string' && PERFORMANCE_LEVEL_IDS.has(level)) {
      out.performance = { level, source: 'prompted' };
      changed = true;
    } else {
      delete out.performance;
      changed = true;
    }
  }

  const perf = obj(out.performance);
  if (perf) {
    const level = canonicalPerformanceLevel(perf.level);
    const rawSource = typeof perf.source === 'string'
      ? perf.source.trim().toLowerCase().replace(/[_\s]+/g, '-')
      : 'prompted';
    const normalized: Rec = { ...perf, level, source: PERFORMANCE_SOURCE_IDS.has(rawSource) ? rawSource : 'prompted' };
    if (perf.level !== normalized.level || perf.source !== normalized.source) changed = true;
    if (typeof level === 'string' && PERFORMANCE_LEVEL_IDS.has(level)) {
      out.performance = normalized;
    } else {
      delete out.performance;
      changed = true;
    }
  }

  if (typeof out.team === 'string') {
    const team = teamStateFromString(out.team);
    if (team) { out.team = team; changed = true; } else { delete out.team; changed = true; }
  }

  const team = obj(out.team);
  if (team) {
    const perfNow = obj(out.performance);
    const performanceLevel = perfNow ? perfNow.level : null;
    const normalized: Rec = {
      ...team,
      mode: canonicalTeamMode(team.mode),
      source: canonicalTeamSource((team.source as string) || 'prompted'),
    };
    const normalizedOverrides = canonicalTeamOverrides(team.overrides, performanceLevel);
    if (normalizedOverrides) normalized.overrides = normalizedOverrides;
    else if ('overrides' in normalized) delete normalized.overrides;
    if (team.approved === true) normalized.approved = true;
    else if ('approved' in normalized) delete normalized.approved;
    if (normalized.mode !== 'subagents' && 'modeChangeApproval' in normalized) delete normalized.modeChangeApproval;
    if (inSet(TEAM_MODE_IDS, normalized.mode) && inSet(TEAM_SOURCE_IDS, normalized.source)) {
      if (
        team.mode !== normalized.mode
        || team.source !== normalized.source
        || team.approved !== normalized.approved
        || !overridesEqual(team.overrides, normalized.overrides)
        || team.modeChangeApproval !== normalized.modeChangeApproval
      ) changed = true;
      out.team = normalized;
    } else {
      delete out.team;
      changed = true;
    }
  }

  const toolchain = obj(out.toolchain);
  if (toolchain) {
    const normalizedToolchain = initializeLocalToolchainState(toolchain);
    if (JSON.stringify(toolchain) !== JSON.stringify(normalizedToolchain)) changed = true;
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

  return changed ? { ...out } : out;
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
  writeJson(prefsPath, normalized);
  if (prefsPath === projectLocalPrefsPath(cwd)) {
    ensureProjectLocalTrafficOneGitignore(cwd);
  }
  return normalized;
}

function mergePlainObject(current: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return { ...(patch as Rec) };
  return { ...(current as Rec), ...(patch as Rec) };
}

function mergeProjectPrefsObject(current: Rec, patch: unknown): Rec {
  const patchObj = obj(patch);
  const next: Rec = { ...current, ...(patchObj || {}) };
  if (patchObj) {
    if (Object.prototype.hasOwnProperty.call(patchObj, 'performance')) {
      const p = obj(patchObj.performance);
      next.performance = p && !Object.prototype.hasOwnProperty.call(p, 'level')
        ? mergePlainObject(current.performance, patchObj.performance)
        : patchObj.performance;
    }
    if (Object.prototype.hasOwnProperty.call(patchObj, 'team')) {
      const t = obj(patchObj.team);
      next.team = t && !Object.prototype.hasOwnProperty.call(t, 'mode')
        ? mergePlainObject(current.team, patchObj.team)
        : patchObj.team;
    }
    if (Object.prototype.hasOwnProperty.call(patchObj, 'openCode')) {
      const o = obj(patchObj.openCode);
      next.openCode = o && !Object.prototype.hasOwnProperty.call(o, 'enabled')
        ? mergePlainObject(current.openCode, patchObj.openCode)
        : patchObj.openCode;
    }
    const patchToolchain = obj(patchObj.toolchain);
    if (patchToolchain) {
      const currentToolchain = obj(current.toolchain) || {};
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
  return writeProjectPrefs(cwd, mergeProjectPrefsObject(readProjectPrefs(cwd, env), patch), env);
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
  for (const key of LOCAL_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) prefs[key] = source[key];
  }
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
  if (!prefs.team && source.subagentTeam !== undefined) prefs.team = source.subagentTeam;
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

export function effectiveState(projectState: unknown, prefs: unknown): Rec {
  const state: Rec = obj(projectState) ? { ...(projectState as Rec) } : {};
  const local = normalizeProjectPrefs(prefs);
  for (const key of LOCAL_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(local, key)) state[key] = local[key];
    else delete state[key];
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
  return normalizeRuntimeIds(applyGlobalCodeGraphProvider(effectiveState(stripLocalPreferenceFields(state), prefs), env, cwd));
}
