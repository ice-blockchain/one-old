'use strict';

// scripts/hook-runtime/state.cjs
// Low-level JSON / file I/O helpers and the .traffic-one.json read/write API.
// Every module that needs to touch the state file goes through here.

const fs = require('fs');
const path = require('path');

const {
  STATE_FILE,
  LEGACY_LOCK_FILE,
  STACK_IDS,
  LEGACY_STACK_ALIASES,
  pluginRoot,
} = require('./config.cjs');
const { canonicalTier } = require('./model-tiers.cjs');
const { PERFORMANCE_CONFIG } = require('./performance-config.cjs');

const PLUGIN_MANIFEST_DIRS = ['.codex-plugin', '.claude-plugin', '.cursor-plugin'];

// Cache the plugin's own version so we can stamp it into every
// `.traffic-one.json` write. The cache is set once at module load; the plugin
// version doesn't change mid-session.
let cachedPluginVersion = null;
function getPluginVersion() {
  if (cachedPluginVersion !== null) return cachedPluginVersion;
  const root = pluginRoot();
  for (const manifestDir of PLUGIN_MANIFEST_DIRS) {
    try {
      const manifestPath = path.join(root, manifestDir, 'plugin.json');
      const text = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(text);
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        cachedPluginVersion = parsed.version;
        return cachedPluginVersion;
      }
    } catch {
      // Try the next host-specific manifest.
    }
  }
  cachedPluginVersion = '';
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

const MOBILE_SOURCE_IDS = new Set(['explicit', 'prompted', 'none']);
const MOBILE_SOURCE_ALIASES = new Map([
  ['asked', 'prompted'],
  ['chat', 'prompted'],
  ['fallback-chat', 'prompted'],
  ['onboarding', 'prompted'],
  ['popup', 'prompted'],
  ['prompt', 'prompted'],
  ['user-onboarding', 'prompted'],
  ['user-prompted', 'prompted'],
  ['disabled', 'none'],
  ['n/a', 'none'],
  ['na', 'none'],
  ['not-applicable', 'none'],
  ['web', 'none'],
  ['web-only', 'none'],
  ['explicit-user-request', 'explicit'],
  ['explicitly-requested', 'explicit'],
  ['requested', 'explicit'],
  ['user-requested', 'explicit'],
]);

const TEAM_MODE_IDS = new Set(['subagents', 'main-agent']);
const TEAM_SOURCE_IDS = new Set(['prompted', 'explicit', 'unavailable']);

const PERFORMANCE_LEVEL_IDS = new Set(['low', 'balanced', 'high']);
const PERFORMANCE_SOURCE_IDS = new Set(['prompted', 'explicit']);
const TEAM_MODE_ALIASES = new Map([
  ['enabled', 'subagents'],
  ['true', 'subagents'],
  ['yes', 'subagents'],
  ['run-team', 'subagents'],
  ['team', 'subagents'],
  ['traffic-one', 'subagents'],
  ['traffic-one-team', 'subagents'],
  ['subagent', 'subagents'],
  ['subagents-only', 'subagents'],
  ['disabled', 'main-agent'],
  ['false', 'main-agent'],
  ['no', 'main-agent'],
  ['main', 'main-agent'],
  ['main-agent-only', 'main-agent'],
  ['manual', 'main-agent'],
  ['same-thread', 'main-agent'],
]);
const TEAM_SOURCE_ALIASES = new Map([
  ['chat', 'prompted'],
  ['fallback-chat', 'prompted'],
  ['onboarding', 'prompted'],
  ['popup', 'prompted'],
  ['prompt', 'prompted'],
  ['user-onboarding', 'prompted'],
  ['blocked', 'unavailable'],
  ['not-available', 'unavailable'],
  ['runtime-unavailable', 'unavailable'],
  ['explicit-user-request', 'explicit'],
  ['requested', 'explicit'],
  ['user-requested', 'explicit'],
]);

function canonicalMobileSource(source) {
  if (typeof source !== 'string') {
    return source;
  }
  if (MOBILE_SOURCE_IDS.has(source)) {
    return source;
  }
  const normalized = source.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (MOBILE_SOURCE_IDS.has(normalized)) {
    return normalized;
  }
  return MOBILE_SOURCE_ALIASES.get(normalized) || source;
}

function canonicalTeamMode(mode) {
  if (typeof mode !== 'string') return mode;
  if (TEAM_MODE_IDS.has(mode)) return mode;
  const normalized = mode.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (TEAM_MODE_IDS.has(normalized)) return normalized;
  return TEAM_MODE_ALIASES.get(normalized) || mode;
}

function canonicalTeamSource(source) {
  if (typeof source !== 'string') return source;
  if (TEAM_SOURCE_IDS.has(source)) return source;
  const normalized = source.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (TEAM_SOURCE_IDS.has(normalized)) return normalized;
  return TEAM_SOURCE_ALIASES.get(normalized) || source;
}

// Returns a canonicalised `{ role: tier }` map, or null when the input has no
// usable overrides (so the field can be omitted from `.traffic-one.json`).
// - Unknown role names are dropped silently.
// - Tier strings that don't resolve via `canonicalTier` (highest|balanced|
//   cheapest plus the well-known aliases in `model-tiers.cjs`) are dropped.
// - Overrides that match the level's default tier are dropped too — once a
//   default tier is restored, the role is no longer "customised".
function canonicalTeamOverrides(overrides, level) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return null;
  }
  const baseAgents = level && PERFORMANCE_CONFIG[level] ? PERFORMANCE_CONFIG[level].agents : null;
  const validRoles = new Set();
  if (baseAgents && typeof baseAgents === 'object') {
    for (const role of Object.keys(baseAgents)) validRoles.add(role);
  } else {
    // No level recorded yet: accept any role configured under any level so a
    // mid-onboarding write isn't lossy.
    for (const cfg of Object.values(PERFORMANCE_CONFIG)) {
      if (cfg && cfg.agents) {
        for (const role of Object.keys(cfg.agents)) validRoles.add(role);
      }
    }
  }
  const result = {};
  for (const [role, tier] of Object.entries(overrides)) {
    if (!validRoles.has(role)) continue;
    const canonical = canonicalTier(tier);
    if (!canonical) continue;
    if (baseAgents && baseAgents[role] && baseAgents[role].tier === canonical) continue;
    result[role] = canonical;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function overridesEqual(left, right) {
  if (left === right) return true;
  const a = left && typeof left === 'object' ? left : null;
  const b = right && typeof right === 'object' ? right : null;
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function canonicalPerformanceLevel(level) {
  if (typeof level !== 'string') return level;
  if (PERFORMANCE_LEVEL_IDS.has(level)) return level;
  const normalized = level.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return PERFORMANCE_LEVEL_IDS.has(normalized) ? normalized : level;
}

function normalizedString(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[_\s]+/g, '-')
    : '';
}

function mobileStateFromString(value) {
  const normalized = normalizedString(value);
  if (!normalized) return null;
  if (normalized === 'web' || normalized === 'web-only') {
    return { enabled: false, framework: 'none', source: 'prompted' };
  }
  if (normalized === 'none' || normalized === 'no-mobile' || normalized === 'disabled') {
    return { enabled: false, framework: 'none', source: 'none' };
  }
  if (normalized === 'ionic' || normalized === 'ionic-capacitor') {
    return { enabled: true, framework: 'ionic-capacitor', source: 'prompted' };
  }
  if (normalized === 'react-native' || normalized === 'react-native-expo' || normalized === 'expo') {
    return { enabled: true, framework: 'react-native-expo', source: 'prompted' };
  }
  return null;
}

function teamStateFromString(value) {
  const mode = canonicalTeamMode(value);
  return TEAM_MODE_IDS.has(mode)
    ? { mode, source: 'prompted' }
    : null;
}

function codeGraphProviderFromString(value) {
  const normalized = normalizedString(value);
  return normalized === 'gitnexus' || normalized === 'graphify' ? normalized : null;
}

function codeGraphProviderFromValue(value) {
  const direct = codeGraphProviderFromString(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ['provider', 'codeGraphProvider', 'id', 'name']) {
    const nested = codeGraphProviderFromValue(value[key]);
    if (nested) return nested;
  }
  return null;
}

function canonicalMode(value) {
  const normalized = normalizedString(value);
  if (normalized === 'new-project' || normalized === 'existing-codebase') return normalized;
  return typeof value === 'string' ? value : null;
}

function canonicalBackendValue(value) {
  const normalized = normalizedString(value);
  if (normalized === 'supabase-ready' || normalized === 'supabase-default' || normalized === 'managed-supabase') {
    return 'supabase';
  }
  return typeof value === 'string' ? value : value;
}

function canonicalizeStateShape(state) {
  if (!state || typeof state !== 'object') return false;

  let changed = false;
  if (!state.mode && typeof state.projectMode === 'string') {
    const mode = canonicalMode(state.projectMode);
    if (mode) {
      state.mode = mode;
      changed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(state, 'projectMode')) {
    delete state.projectMode;
    changed = true;
  }

  const compactStack = state.stack && typeof state.stack === 'object' && !Array.isArray(state.stack)
    ? state.stack
    : null;

  if (compactStack) {
    if (typeof compactStack.id === 'string' && compactStack.id.trim()) {
      state.stack = compactStack.id.trim();
      changed = true;
    }
    if (!state.frontend && typeof compactStack.frontend === 'string') {
      state.frontend = compactStack.frontend;
      changed = true;
    }
    if (!state.backend && typeof compactStack.backend === 'string') {
      state.backend = compactStack.backend;
      changed = true;
    }
    if ((state.mobile === undefined || state.mobile === null) && compactStack.mobile !== undefined) {
      state.mobile = compactStack.mobile;
      changed = true;
    }
    if (!state.codeGraphProvider) {
      const codeGraphProvider = codeGraphProviderFromValue(compactStack.codeGraph || compactStack.codeGraphProvider);
      if (codeGraphProvider) {
        state.codeGraphProvider = codeGraphProvider;
        changed = true;
      }
    }
    if ((state.team === undefined || state.team === null) && compactStack.team !== undefined) {
      state.team = compactStack.team;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(state, 'project')) {
      delete state.project;
      changed = true;
    }
  }

  if (typeof state.backend === 'string') {
    const backend = canonicalBackendValue(state.backend);
    if (backend !== state.backend) {
      state.backend = backend;
      changed = true;
    }
  }

  if (typeof state.mobile === 'string') {
    const mobile = mobileStateFromString(state.mobile);
    if (mobile) {
      state.mobile = mobile;
      changed = true;
    }
  }

  if ((state.team === undefined || state.team === null) && state.subagentTeam !== undefined) {
    state.team = state.subagentTeam;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(state, 'subagentTeam')) {
    delete state.subagentTeam;
    changed = true;
  }

  if (typeof state.team === 'string') {
    const team = teamStateFromString(state.team);
    if (team) {
      state.team = team;
      changed = true;
    }
  }

  const canonicalCodeGraphProvider = codeGraphProviderFromValue(state.codeGraphProvider);
  if (canonicalCodeGraphProvider && state.codeGraphProvider !== canonicalCodeGraphProvider) {
    state.codeGraphProvider = canonicalCodeGraphProvider;
    changed = true;
  }

  if (!state.codeGraphProvider && state.codeGraph !== undefined) {
    const codeGraphProvider = codeGraphProviderFromValue(state.codeGraph);
    if (codeGraphProvider) {
      state.codeGraphProvider = codeGraphProvider;
      delete state.codeGraph;
      changed = true;
    }
  }

  if (typeof state.performance === 'string') {
    const level = canonicalPerformanceLevel(state.performance);
    if (PERFORMANCE_LEVEL_IDS.has(level)) {
      state.performance = { level, source: 'prompted' };
      changed = true;
    }
  }

  return changed;
}

function hasValidPerformanceState(performance) {
  return Boolean(
    performance
    && typeof performance === 'object'
    && PERFORMANCE_LEVEL_IDS.has(performance.level)
    && PERFORMANCE_SOURCE_IDS.has(performance.source),
  );
}

function hasValidTeamState(team) {
  return Boolean(
    team
    && typeof team === 'object'
    && TEAM_MODE_IDS.has(team.mode)
    && TEAM_SOURCE_IDS.has(team.source)
  );
}

function hasValidProjectContext(projectContext) {
  return Boolean(
    projectContext
    && typeof projectContext === 'object'
    && !Array.isArray(projectContext)
    && typeof projectContext.source === 'string'
    && projectContext.source.trim() !== ''
    && typeof projectContext.originalPrompt === 'string'
    && typeof projectContext.summary === 'string'
    && projectContext.summary.trim() !== ''
    && projectContext.answers
    && typeof projectContext.answers === 'object'
    && !Array.isArray(projectContext.answers)
    && typeof projectContext.collectedAt === 'string'
    && projectContext.collectedAt.trim() !== ''
  );
}

// Team Confirmation sets `team.approved: true` when the user
// explicitly Approves the team line-up. Used by the spawn gate to enforce
// that the model can't bypass confirmation with "I'll auto-approve the default".
function isTeamApproved(team) {
  return Boolean(team && typeof team === 'object' && team.approved === true);
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
  const source = state && typeof state === 'object' ? { ...state } : {};
  delete source.pluginVersion;
  if (source.stack) {
    canonicalizeStateShape(source);
    if (typeof source.stack === 'string') {
      normalizeState(source, source.mode || 'new-project');
    }
  }
  const nextState = {
    ...source,
    version: getPluginVersion(),
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

// Returns a stable string fingerprint of the stack dimensions that determine
// which rules and skills are active. Used to detect when the active set needs
// to be re-materialized (e.g. after stack change or plugin update).
function stackFingerprint(state) {
  if (!state || typeof state !== 'object') return 'minimal|none|none|none';
  return [
    state.stack   || 'minimal',
    state.frontend || 'none',
    state.backend  || 'none',
    (state.mobile && state.mobile.framework) || 'none',
  ].join('|');
}

// Returns true when .traffic-one.json already carries a valid materialization
// stamp that matches the current stack. If not, implementation tools should be
// blocked until the stamp is written by SessionStart.
function isMaterialized(state) {
  if (!state || typeof state !== 'object') return false;
  if (!state.onboardingComplete) return true; // pre-onboarding: don't block
  if (!state.materializedStack) return false;
  return state.materializedStack === stackFingerprint(state);
}

// SUBAGENT SIGNAL.
// The orchestrator skill writes `currentRunId` (ISO timestamp) and
// `activeAgentRole` (e.g. 'senior-frontend') to .traffic-one.json before each
// subagent spawn. The hook reads these to emit a slim, role-scoped bundle
// instead of re-inlining the full 117KB rule set the parent already loaded.
//
// Safety: only treats the session as a subagent when materialization is fresh
// (< 30 min) and the fingerprint matches. Stale runs fall back to the full
// parent bundle so abandoned/restarted sessions stay safe.
const SUBAGENT_STALE_MS = 30 * 60 * 1000;
const VALID_AGENT_ROLES = new Set([
  'senior-architect',
  'senior-frontend',
  'senior-backend',
  'senior-reviewer',
  'senior-tester',
  'senior-shipper',
]);

function isSubagentSession(state) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.currentRunId !== 'string' || !state.currentRunId) return false;
  if (!state.materializedStack) return false;
  if (state.materializedStack !== stackFingerprint(state)) return false;
  if (state.materializedAt) {
    const ageMs = Date.now() - Date.parse(state.materializedAt);
    if (Number.isFinite(ageMs) && ageMs > SUBAGENT_STALE_MS) return false;
  }
  return true;
}

function activeAgentRole(state) {
  if (!state || typeof state !== 'object') return null;
  const role = state.activeAgentRole;
  return typeof role === 'string' && VALID_AGENT_ROLES.has(role) ? role : null;
}

// FIX-CYCLE DETECTION.
// `spawnIndex` is a map { role -> integer } that the orchestrator increments
// before each subagent spawn for that role within a single `currentRunId`.
//   1 = first spawn (build / plan / review pass 0)
//   2+ = re-spawn (fix cycle, re-review, etc.)
// The SessionStart hook checks this to emit an ULTRA-slim bundle for
// re-spawns: just pointers to the prior digest + the fix-cycle context file
// the orchestrator wrote before the re-spawn. Saves ~25K-30K tokens per
// fix-cycle spawn vs the already-slim role-scoped bundle.
function getSpawnIndex(state, role) {
  if (!state || typeof state !== 'object') return 0;
  const map = state.spawnIndex;
  if (!map || typeof map !== 'object') return 0;
  const n = map[role];
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function isFixCycleSession(state) {
  if (!isSubagentSession(state)) return false;
  const role = activeAgentRole(state);
  if (!role) return false;
  return getSpawnIndex(state, role) > 1;
}

module.exports = {
  parseJsonText,
  safeReadText,
  safeReadJson,
  writeJson,
  nowIso,
  readState,
  writeState,
  canonicalizeStateShape,
  normalizeState,
  initializeToolchainState,
  defaultTechnologiesFor,
  hasValidTeamState,
  hasValidProjectContext,
  isTeamApproved,
  canonicalTeamOverrides,
  overridesEqual,
  codeGraphProviderFromValue,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  canonicalPerformanceLevel,
  hasValidPerformanceState,
  requireAddon,
  KNOWN_ADDONS,
  getPluginVersion,  // exported for testing + diagnostic
  stackFingerprint,
  isMaterialized,
  isSubagentSession,
  activeAgentRole,
  VALID_AGENT_ROLES,
  getSpawnIndex,
  isFixCycleSession,
};
