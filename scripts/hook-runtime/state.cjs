'use strict';

// scripts/hook-runtime/state.cjs
// Low-level JSON / file I/O helpers and the .traffic-one.json read/write API.
// Every module that needs to touch the state file goes through here.

const fs = require('fs');
const path = require('path');

const {
  STATE_FILE,
  LEGACY_LOCK_FILE,
  STATE_VERSION,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
  pluginRoot,
} = require('./config.cjs');

// Cache the plugin's own version (from .claude-plugin/plugin.json) so we can
// stamp it into every `.traffic-one.json` write. The cache is set once at
// module load; the plugin version doesn't change mid-session.
let cachedPluginVersion = null;
function getPluginVersion() {
  if (cachedPluginVersion !== null) return cachedPluginVersion;
  try {
    const manifestPath = path.join(pluginRoot(), '.claude-plugin', 'plugin.json');
    const text = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(text);
    cachedPluginVersion = typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    cachedPluginVersion = '';
  }
  return cachedPluginVersion;
}

// ── JSON / file helpers ──────────────────────────────────────────────────────
function parseJsonText(text, fallback = {}) {
  if (!text || !text.trim()) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReadJson(filePath, fallback = {}) {
  const text = safeReadText(filePath);
  return text === null ? fallback : parseJsonText(text, fallback);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function arrayEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function toolNamesFromSpec() {
  try {
    const specPath = path.resolve(__dirname, '..', 'toolchain-versions.json');
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

// ── .traffic-one.json read / write ───────────────────────────────────────────
function readState(cwd) {
  const statePath = path.join(cwd, STATE_FILE);
  if (fs.existsSync(statePath)) {
    return safeReadJson(statePath, {});
  }

  // Legacy migration: very old projects used a flat .claude-plugin-mode file
  const legacyPath = path.join(cwd, LEGACY_LOCK_FILE);
  const legacy = safeReadText(legacyPath);
  if (legacy !== null) {
    return {
      version: STATE_VERSION,
      mode: legacy.trim(),
      stack: null,
      confirmed: false,
    };
  }
  return {};
}

function writeState(cwd, state) {
  // Stamp the schema version (state shape) AND the plugin version (which
  // build of traffic-one produced this state). The plugin version helps
  // diagnose cache-mismatch problems: when a user reports a hook didn't
  // fire, we can check `pluginVersion` in their `.traffic-one.json` against
  // the source-of-truth manifest to confirm which version actually ran.
  const pluginVersion = getPluginVersion();
  if (state && typeof state === 'object' && state.stack) {
    normalizeState(state, state.mode || 'new-project');
  }
  const nextState = {
    ...state,
    version: STATE_VERSION,
    ...(pluginVersion ? { pluginVersion } : {}),
  };
  writeJson(path.join(cwd, STATE_FILE), nextState);
}

// ── Tolerate partial state ───────────────────────────────────────────────────
// The model sometimes writes `.traffic-one.json` with just `{stack, backend,
// realtime, version}`, dropping `mode`, `confirmed`, `onboardingComplete`,
// `confirmedAt`. We treat that as "the user picked a stack, we just need to
// fill in the bookkeeping" rather than restart onboarding from scratch.
//
// `defaultMode` is the mode to use when state.mode is missing — pass the
// detected mode here so we don't re-detect from the calling site.
//
// Returns `true` if any field was added (so the caller knows to write back).
function normalizeState(state, defaultMode) {
  if (!state || typeof state !== 'object' || !state.stack) {
    return false;
  }

  let changed = normalizeLegacyStack(state);

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
  if (!STACK_IDS.has(state.stack)) {
    state.stack = 'minimal';
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
    const normalizedMobile = {
      ...defaultMobileState(),
      ...state.mobile,
    };
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
const KNOWN_ADDONS = new Set([
  'storage', 'auth', 'realtime', 'vector', 'pg_cron', 'pg_net', 'edge_functions',
]);

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
  parseJsonText,
  safeReadText,
  safeReadJson,
  writeJson,
  nowIso,
  readState,
  writeState,
  normalizeState,
  initializeToolchainState,
  defaultTechnologiesFor,
  requireAddon,
  KNOWN_ADDONS,
  getPluginVersion,  // exported for testing + diagnostic
};
