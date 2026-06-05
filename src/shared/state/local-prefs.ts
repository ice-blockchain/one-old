// src/shared/state/local-prefs.ts
// Per-user, per-project runtime preferences (kept out of the repo-shared
// .one.json). Ported 1:1 from scripts/hook-runtime/state/local-prefs.cjs.

import { obj, type Rec } from '../obj';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LEGACY_STATE_FILE, STATE_FILE } from '../../config/paths';
import { readJson, writeJson } from '../fsjson';
import { sha256 } from '../text';
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

export const LOCAL_PREF_KEYS = new Set([
  'openCode', 'codeGraphProvider', 'performance', 'team', 'toolchain',
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

export function projectPrefsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH) return path.resolve(env.TRAFFIC_ONE_PROJECT_PREFS_PATH);
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
  return path.join(base, 'projects', projectRootHash(cwd), 'preferences.json');
}

export function normalizeProjectPrefs(prefs: unknown): Rec {
  const base = obj(prefs);
  if (!base) return {};
  const out: Rec = { ...base };
  let changed = false;

  const provider = codeGraphProviderFromValue(out.codeGraphProvider);
  if (provider) {
    if (out.codeGraphProvider !== provider) changed = true;
    out.codeGraphProvider = provider;
  } else if (Object.prototype.hasOwnProperty.call(out, 'codeGraphProvider')) {
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
  return normalizeProjectPrefs(readJson(projectPrefsPath(cwd, env), {}));
}

export function writeProjectPrefs(cwd: string, prefs: unknown, env: NodeJS.ProcessEnv = process.env): Rec {
  const normalized = normalizeProjectPrefs(prefs);
  writeJson(projectPrefsPath(cwd, env), normalized);
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
        merged[name] = mergePlainObject(currentToolchain[name], stamp);
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
  const stack = obj(source.stack);
  const nestedProvider = codeGraphProviderFromValue(source.codeGraph)
    || codeGraphProviderFromValue(stack ? (stack.codeGraph || stack.codeGraphProvider) : null);
  if (nestedProvider && !prefs.codeGraphProvider) prefs.codeGraphProvider = nestedProvider;
  if (!prefs.team && source.subagentTeam !== undefined) prefs.team = source.subagentTeam;
  return normalizeProjectPrefs(prefs);
}

export function stripLocalPreferenceFields(value: unknown): Rec {
  const out: Rec = obj(value) ? { ...(value as Rec) } : {};
  for (const key of LOCAL_PREF_KEYS) delete out[key];
  delete out.codeGraph;
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
  try {
    const prefs = mergeProjectPrefs(cwd, localPatch, env);
    return { state: stripLocalPreferenceFields(state), prefs, changed: true };
  } catch {
    const prefs = mergeProjectPrefsObject(readProjectPrefs(cwd, env), localPatch);
    return { state: stateRec, prefs, changed: false };
  }
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

export function readEffectiveState(cwd: string, env: NodeJS.ProcessEnv = process.env): Rec {
  const state = readRawState(cwd);
  const embeddedPrefs = extractProjectPrefs(state);
  const prefs = Object.keys(embeddedPrefs).length > 0
    ? mergeProjectPrefsObject(readProjectPrefs(cwd, env), embeddedPrefs)
    : readProjectPrefs(cwd, env);
  return effectiveState(stripLocalPreferenceFields(state), prefs);
}
