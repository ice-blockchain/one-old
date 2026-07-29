// src/shared/state/local-prefs/index.ts
// Machine-global code-graph provider + effective state, plus the re-export
// barrel keeping every './local-prefs' specifier working.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { LEGACY_STATE_FILE, STATE_FILE } from '../../../config/paths';
import { readJson } from '../../fsjson';
import { detectHost } from '../../host';
import { canonicalHost, canonicalPlan, planIsRecognized } from '../../model-tiers';
import { readOneSettings, writeOneSection } from '../../one-settings';
import {
  canonicalOpenCodeSource,
  canonicalPerformanceLevel,
  canonicalTeamMode,
  canonicalTeamOverrides,
  canonicalTeamSource,
  codeGraphProviderFromValue,
  teamStateFromString,
} from '../canonicalize';

import {
  HOST_PREF_KEYS,
  PROJECT_PREF_KEYS,
  RETIRED_LOCAL_PREF_KEYS,
} from './pref-schema';
import {
  normalizeProjectPrefs,
  readProjectPrefs,
} from './prefs-store';
import {
  mergeProjectPrefsObject,
} from './prefs-merge';
import {
  extractProjectPrefs,
  stripLocalPreferenceFields,
} from './prefs-split';

// ── Machine-wide code-graph provider (one.json, not per-project) ─────────────────
// The provider becomes a global setting so a provider already chosen/installed
// locally is reused across projects (onboarding stops re-prompting).

export function readGlobalCodeGraphProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  return codeGraphProviderFromValue(readOneSettings(env).codeGraphProvider);
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
  _cwd?: string,
): Rec {
  const provider = readGlobalCodeGraphProvider(env);
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
  for (const key of RETIRED_LOCAL_PREF_KEYS) delete state[key];
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
  const { readState } = require('../normalize') as typeof import('../normalize');
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

export {
  LOCAL_PREF_KEYS,
  type PerformanceTarget,
} from './pref-schema';
export {
  PROJECT_PREFS_LOCK_TIMEOUT_MS,
  defaultProjectPrefsPath,
  normalizeProjectPrefs,
  projectPrefsPath,
  projectRootHash,
  readProjectPrefs,
  writeProjectPrefs,
} from './prefs-store';
export {
  advanceProjectHostPerformanceTargetMetadata,
  clearProjectHostPrefs,
  mergeMissingProjectPrefs,
  mergeProjectHostPrefs,
  mergeProjectPrefs,
} from './prefs-merge';
export {
  extractProjectPrefs,
  hasLocalPreferenceFields,
  splitLocalPreferences,
  stripLocalPreferenceFields,
  type SplitResult,
} from './prefs-split';
