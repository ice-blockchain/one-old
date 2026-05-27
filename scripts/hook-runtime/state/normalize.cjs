'use strict';

// scripts/hook-runtime/state/normalize.cjs
// The .traffic-one/.one.json read/write API plus partial-state normalization,
// toolchain seeding, default technologies, legacy-stack migration, and the
// Supabase add-on approval gate.

const fs = require('fs');
const path = require('path');

const {
  STATE_FILE,
  LEGACY_STATE_FILE,
  LEGACY_LOCK_FILE,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
} = require('../config.cjs');
const {
  safeReadText,
  safeReadJson,
  writeJson,
  getPluginVersion,
  nowIso,
} = require('./io.cjs');
const {
  canonicalizeStateShape,
  canonicalMobileSource,
  canonicalTeamMode,
  canonicalTeamSource,
  canonicalPerformanceLevel,
  canonicalTeamOverrides,
  overridesEqual,
  canonicalOpenCodeSource,
  mobileStateFromString,
} = require('./canonicalize.cjs');
const { KNOWN_ADDONS } = require('./constants.cjs');
const {
  stripLocalPreferenceFields,
  splitLocalPreferences,
} = require('./local-prefs.cjs');

function arrayEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function toolNamesFromSpec() {
  try {
    const specPath = path.resolve(__dirname, '..', '..', 'toolchain-versions.json');
    const parsed = safeReadJson(specPath, {});
    const tools = parsed && typeof parsed.tools === 'object' ? parsed.tools : {};
    const names = Object.keys(tools).sort();
    return names.length > 0 ? names : ['gitnexus', 'graphify', 'gitleaks', 'trufflehog'];
  } catch {
    return ['gitnexus', 'graphify', 'gitleaks', 'trufflehog'];
  }
}

function initializeToolchainState(existing = {}) {
  const out = {};
  const source = existing && typeof existing === 'object' ? existing : {};
  for (const name of toolNamesFromSpec()) {
    const current = source[name] && typeof source[name] === 'object' ? source[name] : {};
    out[name] = {
      installedVersion: current.installedVersion || null,
      installedAt: current.installedAt || null,
      ...(current.binPath ? { binPath: current.binPath } : {}),
    };
  }
  return out;
}

function defaultMobileState() {
  return {
    enabled: false,
    framework: 'none',
    source: 'none',
  };
}

function defaultTechnologiesFor(state) {
  const frontend = [];
  const backend = [];
  const mobile = [];
  const frontendValue = state.frontend || 'none';
  const backendValue = state.backend || 'none';
  const mobileValue = state.mobile && state.mobile.framework;

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

function setIfMissingOrDifferent(state, key, value) {
  if (Array.isArray(value)) {
    if (!arrayEqual(state[key], value)) {
      state[key] = value;
      return true;
    }
    return false;
  }
  if (state[key] !== value) {
    state[key] = value;
    return true;
  }
  return false;
}

function normalizeLegacyStack(state) {
  if (!state || typeof state !== 'object' || !state.stack) {
    return false;
  }

  const original = state.stack;
  const mapped = LEGACY_STACK_ALIASES[original];
  if (!mapped) {
    return false;
  }

  state.stack = mapped;
  if (!state.legacyStack) {
    state.legacyStack = original;
  }

  if (original === 'react-realtime-monorepo') {
    state.frontend = state.frontend || 'react-vite';
    state.backend = state.backend || 'supabase';
  } else if (original === 'react-frontend-only') {
    state.frontend = state.frontend || 'react-vite';
    state.backend = state.backend || 'none';
  } else if (original === 'react-native-expo-monorepo' || original === 'react-native-expo-app') {
    state.frontend = state.frontend || 'none';
    state.backend = state.backend || 'supabase';
    const existingMobile = state.mobile && typeof state.mobile === 'object' ? state.mobile : {};
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

// ── .traffic-one/.one.json read / write ───────────────────────────────────────────
function statePath(cwd) {
  return path.join(cwd, STATE_FILE);
}

function legacyStatePath(cwd) {
  return path.join(cwd, LEGACY_STATE_FILE);
}

function readState(cwd) {
  const currentPath = statePath(cwd);
  if (fs.existsSync(currentPath)) {
    return stripLocalPreferenceFields(safeReadJson(currentPath, {}));
  }

  const oldPath = legacyStatePath(cwd);
  if (fs.existsSync(oldPath)) {
    const legacy = safeReadJson(oldPath, {});
    if (legacy && typeof legacy === 'object') {
      legacy.legacyStateFile = LEGACY_STATE_FILE;
    }
    return stripLocalPreferenceFields(legacy);
  }

  // Legacy migration: very old projects used a flat .claude-plugin-mode file
  const legacyPath = path.join(cwd, LEGACY_LOCK_FILE);
  const legacy = safeReadText(legacyPath);
  if (legacy !== null) {
    return {
      version: getPluginVersion(),
      mode: legacy.trim(),
      stack: null,
      confirmed: false,
    };
  }
  return {};
}

function writeState(cwd, state) {
  // Stamp the plugin version (which build of traffic-one produced this state).
  // It doubles as the project-state version visible to users; the legacy
  // `pluginVersion` field is intentionally stripped.
  let source = state && typeof state === 'object' ? { ...state } : {};
  delete source.pluginVersion;
  if (source.stack) {
    canonicalizeStateShape(source);
    if (typeof source.stack === 'string') {
      normalizeState(source, source.mode || 'new-project');
    }
  }
  const split = splitLocalPreferences(cwd, source);
  source = split.state;
  const nextState = {
    ...source,
    version: getPluginVersion(),
  };
  writeJson(statePath(cwd), nextState);
}

// ── Tolerate partial state ───────────────────────────────────────────────────
// The model sometimes writes `.traffic-one/.one.json` with just `{stack, backend,
// realtime, version}`, dropping `mode`, `confirmed`, `onboardingComplete`,
// `confirmedAt`. We treat that as "the user picked a stack, we just need to
// fill in the bookkeeping" rather than restart onboarding from scratch.
//
// `defaultMode` is the mode to use when state.mode is missing — pass the
// detected mode here so we don't re-detect from the calling site.
//
// Returns `true` if any field was added (so the caller knows to write back).
function normalizeState(state, defaultMode) {
  if (!state || typeof state !== 'object') {
    return false;
  }

  let changed = canonicalizeStateShape(state);
  if (!state.stack) {
    return changed;
  }

  changed = normalizeLegacyStack(state) || changed;
  if (typeof state.stack !== 'string' || !STACK_IDS.has(state.stack)) {
    return changed;
  }

  if (!state.mode && defaultMode) {
    state.mode = defaultMode;
    changed = true;
  }
  if (state.confirmed !== true) {
    state.confirmed = true;
    changed = true;
  }
  if (state.onboardingComplete !== true) {
    state.onboardingComplete = true;
    changed = true;
  }
  if (!state.confirmedAt) {
    state.confirmedAt = nowIso();
    changed = true;
  }
  if (!state.realtime) {
    state.realtime = 'none';
    changed = true;
  }
  if (!state.frontend) {
    state.frontend = state.stack === 'default' || state.stack === 'custom-backend'
      ? 'react-vite'
      : 'none';
    changed = true;
  }
  if (!state.backend) {
    state.backend = state.stack === 'minimal' ? 'none' : 'supabase';
    changed = true;
  }
  if (!state.mobile || typeof state.mobile !== 'object') {
    state.mobile = defaultMobileState();
    changed = true;
  } else {
    const frameworkAlias = mobileStateFromString(state.mobile.framework);
    const normalizedMobile = {
      ...defaultMobileState(),
      ...state.mobile,
    };
    if (frameworkAlias) {
      normalizedMobile.enabled = frameworkAlias.enabled;
      normalizedMobile.framework = frameworkAlias.framework;
      if (!state.mobile.source) {
        normalizedMobile.source = frameworkAlias.source;
      }
    }
    normalizedMobile.source = canonicalMobileSource(normalizedMobile.source);
    if (
      state.mobile.enabled !== normalizedMobile.enabled
      || state.mobile.framework !== normalizedMobile.framework
      || state.mobile.source !== normalizedMobile.source
    ) {
      state.mobile = normalizedMobile;
      changed = true;
    }
  }
  if (!state.technologies || typeof state.technologies !== 'object') {
    state.technologies = defaultTechnologiesFor(state);
    changed = true;
  } else {
    const defaults = defaultTechnologiesFor(state);
    const technologies = state.technologies;
    for (const key of ['frontend', 'backend', 'mobile']) {
      if (!Array.isArray(technologies[key])) {
        technologies[key] = defaults[key];
        changed = true;
      }
    }
  }
  if (state.team && typeof state.team === 'object') {
    const normalizedTeam = {
      ...state.team,
      mode: canonicalTeamMode(state.team.mode),
      source: canonicalTeamSource(state.team.source || 'prompted'),
    };
    const performanceLevel = state.performance && typeof state.performance === 'object'
      ? canonicalPerformanceLevel(state.performance.level)
      : null;
    const normalizedOverrides = canonicalTeamOverrides(state.team.overrides, performanceLevel);
    if (normalizedOverrides) {
      normalizedTeam.overrides = normalizedOverrides;
    } else if ('overrides' in normalizedTeam) {
      delete normalizedTeam.overrides;
    }
    // The subagents -> main-agent approval marker is transient. Once the
    // team is no longer in subagent mode, it must not survive as durable state.
    if (normalizedTeam.mode !== 'subagents' && 'modeChangeApproval' in normalizedTeam) {
      delete normalizedTeam.modeChangeApproval;
    } else if (
      'modeChangeApproval' in normalizedTeam
      && (!normalizedTeam.modeChangeApproval || typeof normalizedTeam.modeChangeApproval !== 'object')
    ) {
      delete normalizedTeam.modeChangeApproval;
    }
    // team.approved is a strict boolean. Anything truthy-but-not-true is
    // coerced away so the spawn gate can rely on `=== true`.
    if (state.team.approved === true) {
      normalizedTeam.approved = true;
    } else if ('approved' in normalizedTeam) {
      delete normalizedTeam.approved;
    }
    if (
      state.team.mode !== normalizedTeam.mode
      || state.team.source !== normalizedTeam.source
      || !overridesEqual(state.team.overrides, normalizedTeam.overrides)
      || state.team.modeChangeApproval !== normalizedTeam.modeChangeApproval
      || state.team.approved !== normalizedTeam.approved
    ) {
      state.team = normalizedTeam;
      changed = true;
    }
  }
  if (state.performance && typeof state.performance === 'object') {
    const normalizedPerformance = {
      ...state.performance,
      level: canonicalPerformanceLevel(state.performance.level),
      source: typeof state.performance.source === 'string' ? state.performance.source : 'prompted',
    };
    if (
      state.performance.level !== normalizedPerformance.level
      || state.performance.source !== normalizedPerformance.source
    ) {
      state.performance = normalizedPerformance;
      changed = true;
    }
  }
  // OpenCode opt-in: coerce `enabled` to a strict boolean (the spawn/routing
  // logic added in a later task relies on `=== true`), canonicalize `source`,
  // and stamp `decidedAt`. Only touched when the model has written the field.
  if (state.openCode && typeof state.openCode === 'object' && !Array.isArray(state.openCode)) {
    const normalizedOpenCode = {
      ...state.openCode,
      enabled: state.openCode.enabled === true,
      source: canonicalOpenCodeSource(state.openCode.source),
    };
    if (typeof normalizedOpenCode.decidedAt !== 'string' || !normalizedOpenCode.decidedAt.trim()) {
      normalizedOpenCode.decidedAt = nowIso();
    }
    if (
      state.openCode.enabled !== normalizedOpenCode.enabled
      || state.openCode.source !== normalizedOpenCode.source
      || state.openCode.decidedAt !== normalizedOpenCode.decidedAt
    ) {
      state.openCode = normalizedOpenCode;
      changed = true;
    }
  }
  const nextToolchain = initializeToolchainState(state.toolchain);
  if (JSON.stringify(state.toolchain || {}) !== JSON.stringify(nextToolchain)) {
    state.toolchain = nextToolchain;
    changed = true;
  }

  // Supabase-specific bookkeeping. Only seed when this project is using
  // Supabase as its backend; other backends don't need these flags.
  if (state.backend === 'supabase' || state.backend === 'our-fork') {
    if (state.supabaseFunctionsAutoDeploy === undefined) {
      state.supabaseFunctionsAutoDeploy = 'ask';
      changed = true;
    }
    if (!state.supabaseAddons || typeof state.supabaseAddons !== 'object') {
      state.supabaseAddons = {};
      changed = true;
    }
  }

  return changed;
}

// ── Supabase add-on approval gate ────────────────────────────────────────────
// Used by skills (library-pick, create-service) and handlers when generating
// code that uses a Supabase add-on (storage / auth / realtime / vector / etc.).
// The first call returns `{approved: false, status: "pending"}`; the model
// then asks the user once, runs the activation, and writes
// state.supabaseAddons[name] = "approved". Future calls return approved=true.
//
// Statuses: "pending" | "approved" | "skipped".
function requireAddon(state, name) {
  if (!KNOWN_ADDONS.has(name)) {
    // Unknown add-on — treat as pending so the model surfaces it explicitly.
    return { approved: false, skipped: false, status: 'pending', known: false };
  }
  const addons = (state && typeof state === 'object' && state.supabaseAddons) || {};
  const status = addons[name] || 'pending';
  return {
    approved: status === 'approved',
    skipped:  status === 'skipped',
    status,
    known: true,
  };
}

module.exports = {
  initializeToolchainState,
  defaultTechnologiesFor,
  statePath,
  legacyStatePath,
  readState,
  writeState,
  normalizeState,
  requireAddon,
};
