// src/shared/state/normalize.ts
// .one.json read/write + partial-state normalization, toolchain seeding, default
// technologies, legacy-stack migration, Supabase add-on gate. Ported 1:1 from
// scripts/hook-runtime/state/normalize.cjs (dead helper setIfMissingOrDifferent
// dropped). Uses shared fsjson; state timestamps keep the legacy ms-stripped form.

import { obj, type Rec } from '../obj';
import * as fs from 'fs';
import * as path from 'path';

import { LEGACY_STACK_ALIASES, STACK_IDS } from '../../config/stacks';
import { LEGACY_LOCK_FILE, LEGACY_STATE_FILE, STATE_FILE } from '../../config/paths';
import { isNonProjectRoot } from '../authoring-root';
import { readJson, readText, writeJson } from '../fsjson';
import {
  canonicalizeStateShape,
  canonicalMobileSource,
  canonicalOpenCodeSource,
  canonicalPerformanceLevel,
  canonicalTeamMode,
  canonicalTeamOverrides,
  canonicalTeamSource,
  mobileStateFromString,
  overridesEqual,
} from './canonicalize';
import { KNOWN_ADDONS } from '../../config/state';
import { stateTimestamp, stateVersion } from './io';
import { hasLocalPreferenceFields, splitLocalPreferences, stripLocalPreferenceFields } from './local-prefs';
import { initializeToolchainState } from './toolchain';
import { preserveCurrentRunId, preserveOneMcpReportId, withProjectStateLock } from './project-state-lock';

function defaultMobileState(): Rec {
  return { enabled: false, framework: 'none', source: 'none' };
}

export function defaultTechnologiesFor(state: Rec): { frontend: string[]; backend: string[]; mobile: string[] } {
  const frontend: string[] = [];
  const backend: string[] = [];
  const mobile: string[] = [];
  const frontendValue = (typeof state.frontend === 'string' && state.frontend) || 'none';
  const backendValue = (typeof state.backend === 'string' && state.backend) || 'none';
  const mobileObj = obj(state.mobile);
  const mobileValue = mobileObj ? mobileObj.framework : undefined;

  if (frontendValue === 'react-vite') frontend.push('react', 'vite');
  else if (frontendValue && frontendValue !== 'none') frontend.push(frontendValue);

  if (backendValue === 'supabase' || backendValue === 'our-fork') backend.push('supabase', 'postgres');
  else if (backendValue === 'firebase') backend.push('firebase');
  else if (backendValue === 'mongo') backend.push('mongo');
  else if (backendValue && backendValue !== 'none' && backendValue !== 'external-api') backend.push(backendValue);

  if (mobileValue === 'ionic-capacitor') mobile.push('ionic', 'capacitor');
  if (mobileValue === 'react-native-expo') mobile.push('react-native', 'expo');

  return { frontend, backend, mobile };
}

function normalizeLegacyStack(state: Rec): boolean {
  if (!state.stack) return false;
  const original = state.stack;
  if (typeof original !== 'string') return false;
  const mapped = LEGACY_STACK_ALIASES[original];
  if (!mapped) return false;

  state.stack = mapped;
  if (!state.legacyStack) state.legacyStack = original;

  if (original === 'react-realtime-monorepo') {
    state.frontend = state.frontend || 'react-vite';
    state.backend = state.backend || 'supabase';
  } else if (original === 'react-frontend-only') {
    state.frontend = state.frontend || 'react-vite';
    state.backend = state.backend || 'none';
  } else if (original === 'react-native-expo-monorepo' || original === 'react-native-expo-app') {
    state.frontend = state.frontend || 'none';
    state.backend = state.backend || 'supabase';
    const existingMobile = obj(state.mobile) || {};
    state.mobile = {
      ...existingMobile,
      enabled: true,
      framework: 'react-native-expo',
      source: existingMobile.source || 'explicit',
    };
  } else if (original === 'node-backend') {
    state.frontend = state.frontend || 'none';
    state.backend = state.backend || 'node';
  } else if (original === 'framework-web') {
    state.frontend = state.frontend || 'other';
    state.backend = state.backend || 'other';
  }
  return true;
}

export function statePath(cwd: string): string {
  return path.join(cwd, STATE_FILE);
}

export function legacyStatePath(cwd: string): string {
  return path.join(cwd, LEGACY_STATE_FILE);
}

export function readState(cwd: string): Rec {
  const currentPath = statePath(cwd);
  if (fs.existsSync(currentPath)) return stripLocalPreferenceFields(readJson(currentPath, {}));

  const oldPath = legacyStatePath(cwd);
  if (fs.existsSync(oldPath)) {
    const legacy = readJson<Rec>(oldPath, {});
    if (legacy && typeof legacy === 'object') legacy.legacyStateFile = LEGACY_STATE_FILE;
    return stripLocalPreferenceFields(legacy);
  }

  const legacyPath = path.join(cwd, LEGACY_LOCK_FILE);
  const legacy = readText(legacyPath);
  if (legacy !== null) {
    return { version: stateVersion(), mode: legacy.trim(), stack: null, confirmed: false };
  }
  return {};
}

export function writeState(cwd: string, state: unknown): void {
  // Contract: the plugin's own repo/install never gets a .one.json — a silent
  // no-op here covers every state writer (onboarding server, run claims, session
  // flows) in one place. See authoring-root.test.ts + normalize tests.
  if (isNonProjectRoot(cwd)) return;
  let source: Rec = obj(state) ? { ...(state as Rec) } : {};
  delete source.pluginVersion;
  if (source.stack) {
    canonicalizeStateShape(source);
    if (typeof source.stack === 'string') {
      normalizeState(source, (typeof source.mode === 'string' && source.mode) || 'new-project');
    }
  }
  const split = splitLocalPreferences(cwd, source);
  source = split.state;
  const filePath = statePath(cwd);
  const replacement = { ...source, version: stateVersion() };
  withProjectStateLock(cwd, () => {
    const current = readJson<Rec>(filePath, {});
    writeJson(filePath, preserveCurrentRunId(current, preserveOneMcpReportId(current, replacement)));
  });
}

// Deterministic self-heal for machine-local preference fields that leaked into the
// COMMITTED project state file. writeState strips LOCAL_PREF_KEYS and routes them to the
// per-user preferences.json, but a stale long-lived runner (started before the prefs split
// was wired into its writer) can still write the merged state raw — leaving `team`,
// `toolchain` (with a machine-absolute binPath), `performance`, etc. in `.one.json`, which
// is NOT gitignored. Run this at SessionStart: it reads the RAW on-disk file (NOT readState,
// which strips on read and would hide the leak); if any local-pref field is present it
// rewrites through writeState — stripping them and merging them into preferences.json. No-op
// when the file is absent, already clean, or in the plugin authoring repo (writeState guards
// that). Returns true when it scrubbed.
export function scrubProjectStateLocalPrefs(cwd: string): boolean {
  const raw = readJson<Rec>(statePath(cwd), null as unknown as Rec);
  if (!raw || typeof raw !== 'object' || !hasLocalPreferenceFields(raw)) return false;
  writeState(cwd, raw);
  return true;
}

export function normalizeState(state: unknown, defaultMode?: string): boolean {
  const s = obj(state);
  if (!s) return false;

  let changed = canonicalizeStateShape(s);
  if (typeof s.currentRunId === 'number' && Number.isFinite(s.currentRunId)) {
    s.currentRunId = String(Math.trunc(s.currentRunId));
    changed = true;
  } else if (typeof s.currentRunId === 'string' && s.currentRunId.trim() && s.currentRunId !== s.currentRunId.trim()) {
    s.currentRunId = s.currentRunId.trim();
    changed = true;
  }
  if (!s.stack) return changed;

  changed = normalizeLegacyStack(s) || changed;
  if (typeof s.stack !== 'string' || !STACK_IDS.has(s.stack)) return changed;

  if (!s.mode && defaultMode) { s.mode = defaultMode; changed = true; }
  if (s.confirmed !== true) { s.confirmed = true; changed = true; }
  if (s.onboardingComplete !== true) { s.onboardingComplete = true; changed = true; }
  if (!s.confirmedAt) { s.confirmedAt = stateTimestamp(); changed = true; }
  if (!s.realtime) { s.realtime = 'none'; changed = true; }
  if (!s.frontend) {
    s.frontend = s.stack === 'default' || s.stack === 'custom-backend' ? 'react-vite' : 'none';
    changed = true;
  }
  if (!s.backend) { s.backend = s.stack === 'minimal' ? 'none' : 'supabase'; changed = true; }

  const mobile = obj(s.mobile);
  if (!mobile) { s.mobile = defaultMobileState(); changed = true; } else {
    const frameworkAlias = mobileStateFromString(mobile.framework);
    const normalizedMobile: Rec = { ...defaultMobileState(), ...mobile };
    if (frameworkAlias) {
      normalizedMobile.enabled = frameworkAlias.enabled;
      normalizedMobile.framework = frameworkAlias.framework;
      if (!mobile.source) normalizedMobile.source = frameworkAlias.source;
    }
    normalizedMobile.source = canonicalMobileSource(normalizedMobile.source);
    if (
      mobile.enabled !== normalizedMobile.enabled
      || mobile.framework !== normalizedMobile.framework
      || mobile.source !== normalizedMobile.source
    ) { s.mobile = normalizedMobile; changed = true; }
  }

  const technologies = obj(s.technologies);
  if (!technologies) { s.technologies = defaultTechnologiesFor(s); changed = true; } else {
    const defaults = defaultTechnologiesFor(s);
    for (const key of ['frontend', 'backend', 'mobile'] as const) {
      if (!Array.isArray(technologies[key])) { technologies[key] = defaults[key]; changed = true; }
    }
  }

  const team = obj(s.team);
  if (team) {
    const normalizedTeam: Rec = {
      ...team,
      mode: canonicalTeamMode(team.mode),
      source: canonicalTeamSource((team.source as string) || 'prompted'),
    };
    const perf = obj(s.performance);
    const performanceLevel = perf ? canonicalPerformanceLevel(perf.level) : null;
    const normalizedOverrides = canonicalTeamOverrides(team.overrides, performanceLevel);
    if (normalizedOverrides) normalizedTeam.overrides = normalizedOverrides;
    else if ('overrides' in normalizedTeam) delete normalizedTeam.overrides;

    const mca = normalizedTeam.modeChangeApproval;
    if (normalizedTeam.mode !== 'subagents' && 'modeChangeApproval' in normalizedTeam) {
      delete normalizedTeam.modeChangeApproval;
    } else if ('modeChangeApproval' in normalizedTeam && (!mca || typeof mca !== 'object')) {
      delete normalizedTeam.modeChangeApproval;
    }

    if (team.approved === true) normalizedTeam.approved = true;
    else if ('approved' in normalizedTeam) delete normalizedTeam.approved;

    if (
      team.mode !== normalizedTeam.mode
      || team.source !== normalizedTeam.source
      || !overridesEqual(team.overrides, normalizedTeam.overrides)
      || team.modeChangeApproval !== normalizedTeam.modeChangeApproval
      || team.approved !== normalizedTeam.approved
    ) { s.team = normalizedTeam; changed = true; }
  }

  const performance = obj(s.performance);
  if (performance) {
    const normalizedPerformance: Rec = {
      ...performance,
      level: canonicalPerformanceLevel(performance.level),
      source: typeof performance.source === 'string' ? performance.source : 'prompted',
    };
    if (performance.level !== normalizedPerformance.level || performance.source !== normalizedPerformance.source) {
      s.performance = normalizedPerformance;
      changed = true;
    }
  }

  const openCode = obj(s.openCode);
  if (openCode) {
    const normalizedOpenCode: Rec = {
      ...openCode,
      enabled: openCode.enabled === true,
      source: canonicalOpenCodeSource(openCode.source),
    };
    if (typeof normalizedOpenCode.decidedAt !== 'string' || !(normalizedOpenCode.decidedAt as string).trim()) {
      normalizedOpenCode.decidedAt = stateTimestamp();
    }
    if (
      openCode.enabled !== normalizedOpenCode.enabled
      || openCode.source !== normalizedOpenCode.source
      || openCode.decidedAt !== normalizedOpenCode.decidedAt
    ) { s.openCode = normalizedOpenCode; changed = true; }
  }

  const nextToolchain = initializeToolchainState(s.toolchain);
  if (JSON.stringify(s.toolchain || {}) !== JSON.stringify(nextToolchain)) { s.toolchain = nextToolchain; changed = true; }

  if (s.backend === 'supabase' || s.backend === 'our-fork') {
    if (s.supabaseFunctionsAutoDeploy === undefined) { s.supabaseFunctionsAutoDeploy = 'ask'; changed = true; }
    if (!obj(s.supabaseAddons)) { s.supabaseAddons = {}; changed = true; }
  }

  return changed;
}

export interface AddonGate {
  approved: boolean;
  skipped: boolean;
  status: string;
  known: boolean;
}

export function requireAddon(state: unknown, name: string): AddonGate {
  if (!KNOWN_ADDONS.has(name)) {
    return { approved: false, skipped: false, status: 'pending', known: false };
  }
  const s = obj(state);
  const addons = (s && obj(s.supabaseAddons)) || {};
  const status = typeof addons[name] === 'string' ? (addons[name] as string) : 'pending';
  return { approved: status === 'approved', skipped: status === 'skipped', status, known: true };
}
