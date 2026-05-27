'use strict';

// Per-user, per-project Traffic One runtime preferences.
//
// Project state in `.traffic-one/.one.json` is shared with the repo. Runtime
// choices that depend on the current developer machine live here instead:
// OpenCode opt-in, code graph provider, graph toolchain stamps, agent
// performance/team choice, and graph runner cooldown/error stamps.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { safeReadJson, writeJson, nowIso } = require('./io.cjs');
const {
  canonicalTeamMode,
  canonicalTeamSource,
  canonicalPerformanceLevel,
  canonicalTeamOverrides,
  canonicalOpenCodeSource,
  teamStateFromString,
  codeGraphProviderFromValue,
  overridesEqual,
} = require('./canonicalize.cjs');
const {
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
} = require('./constants.cjs');

const LOCAL_PREF_KEYS = new Set([
  'openCode',
  'codeGraphProvider',
  'performance',
  'team',
  'toolchain',
  'codeGraphAutoRun',
  'graphifyAutoRun',
  'graphifyLastHintedAt',
  'graphifyLastRunAt',
  'graphifyLastErrorAt',
  'graphifyLastError',
  'gitnexusLastRunAt',
  'gitnexusLastErrorAt',
  'gitnexusLastError',
]);

function projectRootHash(cwd) {
  let root;
  try {
    root = fs.realpathSync(path.resolve(cwd));
  } catch {
    root = path.resolve(cwd);
  }
  return crypto.createHash('sha256').update(root).digest('hex');
}

function projectPrefsPath(cwd, env = process.env) {
  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH) {
    return path.resolve(env.TRAFFIC_ONE_PROJECT_PREFS_PATH);
  }
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
  return path.join(base, 'projects', projectRootHash(cwd), 'preferences.json');
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

function initializeLocalToolchainState(existing = {}) {
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

function normalizeProjectPrefs(prefs) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return {};
  }
  const out = { ...prefs };
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
    if (PERFORMANCE_LEVEL_IDS.has(level)) {
      out.performance = { level, source: 'prompted' };
      changed = true;
    } else {
      delete out.performance;
      changed = true;
    }
  }

  if (out.performance && typeof out.performance === 'object' && !Array.isArray(out.performance)) {
    const level = canonicalPerformanceLevel(out.performance.level);
    const source = typeof out.performance.source === 'string'
      ? out.performance.source.trim().toLowerCase().replace(/[_\s]+/g, '-')
      : 'prompted';
    const normalized = {
      ...out.performance,
      level,
      source: PERFORMANCE_SOURCE_IDS.has(source) ? source : 'prompted',
    };
    if (
      out.performance.level !== normalized.level
      || out.performance.source !== normalized.source
    ) changed = true;
    if (PERFORMANCE_LEVEL_IDS.has(normalized.level)) {
      out.performance = normalized;
    } else {
      delete out.performance;
      changed = true;
    }
  }

  if (typeof out.team === 'string') {
    const team = teamStateFromString(out.team);
    if (team) {
      out.team = team;
      changed = true;
    } else {
      delete out.team;
      changed = true;
    }
  }

  if (out.team && typeof out.team === 'object' && !Array.isArray(out.team)) {
    const performanceLevel = out.performance && typeof out.performance === 'object'
      ? out.performance.level
      : null;
    const normalized = {
      ...out.team,
      mode: canonicalTeamMode(out.team.mode),
      source: canonicalTeamSource(out.team.source || 'prompted'),
    };
    const normalizedOverrides = canonicalTeamOverrides(out.team.overrides, performanceLevel);
    if (normalizedOverrides) {
      normalized.overrides = normalizedOverrides;
    } else if ('overrides' in normalized) {
      delete normalized.overrides;
    }
    if (out.team.approved === true) {
      normalized.approved = true;
    } else if ('approved' in normalized) {
      delete normalized.approved;
    }
    if (normalized.mode !== 'subagents' && 'modeChangeApproval' in normalized) {
      delete normalized.modeChangeApproval;
    }
    if (TEAM_MODE_IDS.has(normalized.mode) && TEAM_SOURCE_IDS.has(normalized.source)) {
      if (
        out.team.mode !== normalized.mode
        || out.team.source !== normalized.source
        || out.team.approved !== normalized.approved
        || !overridesEqual(out.team.overrides, normalized.overrides)
        || out.team.modeChangeApproval !== normalized.modeChangeApproval
      ) changed = true;
      out.team = normalized;
    } else {
      delete out.team;
      changed = true;
    }
  }

  if (out.toolchain && typeof out.toolchain === 'object' && !Array.isArray(out.toolchain)) {
    const normalizedToolchain = initializeLocalToolchainState(out.toolchain);
    if (JSON.stringify(out.toolchain) !== JSON.stringify(normalizedToolchain)) changed = true;
    out.toolchain = normalizedToolchain;
  }

  if (out.openCode && typeof out.openCode === 'object' && !Array.isArray(out.openCode)) {
    out.openCode = {
      ...out.openCode,
      enabled: out.openCode.enabled === true,
      source: canonicalOpenCodeSource(out.openCode.source),
      decidedAt: typeof out.openCode.decidedAt === 'string' && out.openCode.decidedAt.trim()
        ? out.openCode.decidedAt
        : nowIso(),
    };
  }

  return changed ? { ...out } : out;
}

function readProjectPrefs(cwd, env = process.env) {
  return normalizeProjectPrefs(safeReadJson(projectPrefsPath(cwd, env), {}));
}

function writeProjectPrefs(cwd, prefs, env = process.env) {
  const normalized = normalizeProjectPrefs(prefs);
  writeJson(projectPrefsPath(cwd, env), normalized);
  return normalized;
}

function mergePlainObject(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return { ...patch };
  return { ...current, ...patch };
}

function mergeProjectPrefs(cwd, patch, env = process.env) {
  const current = readProjectPrefs(cwd, env);
  const next = { ...current, ...(patch || {}) };
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    if (Object.prototype.hasOwnProperty.call(patch, 'performance')) {
      next.performance = patch.performance
        && typeof patch.performance === 'object'
        && !Array.isArray(patch.performance)
        && !Object.prototype.hasOwnProperty.call(patch.performance, 'level')
        ? mergePlainObject(current.performance, patch.performance)
        : patch.performance;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'team')) {
      next.team = patch.team
        && typeof patch.team === 'object'
        && !Array.isArray(patch.team)
        && !Object.prototype.hasOwnProperty.call(patch.team, 'mode')
        ? mergePlainObject(current.team, patch.team)
        : patch.team;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'openCode')) {
      next.openCode = patch.openCode
        && typeof patch.openCode === 'object'
        && !Array.isArray(patch.openCode)
        && !Object.prototype.hasOwnProperty.call(patch.openCode, 'enabled')
        ? mergePlainObject(current.openCode, patch.openCode)
        : patch.openCode;
    }
    if (
      patch.toolchain
      && typeof patch.toolchain === 'object'
      && !Array.isArray(patch.toolchain)
    ) {
      next.toolchain = { ...(current.toolchain || {}) };
      for (const [name, stamp] of Object.entries(patch.toolchain)) {
        next.toolchain[name] = mergePlainObject(current.toolchain && current.toolchain[name], stamp);
      }
    }
  }
  return writeProjectPrefs(cwd, next, env);
}

function hasLocalPreferenceFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => LOCAL_PREF_KEYS.has(key) || key === 'codeGraph' || key === 'subagentTeam')) {
    return true;
  }
  return Boolean(
    value.stack
    && typeof value.stack === 'object'
    && !Array.isArray(value.stack)
    && (
      Object.prototype.hasOwnProperty.call(value.stack, 'codeGraph')
      || Object.prototype.hasOwnProperty.call(value.stack, 'codeGraphProvider')
    )
  );
}

function extractProjectPrefs(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const prefs = {};
  for (const key of LOCAL_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      prefs[key] = source[key];
    }
  }
  const nestedProvider = codeGraphProviderFromValue(source.codeGraph)
    || codeGraphProviderFromValue(
      source.stack && typeof source.stack === 'object' && !Array.isArray(source.stack)
        ? (source.stack.codeGraph || source.stack.codeGraphProvider)
        : null,
    );
  if (nestedProvider && !prefs.codeGraphProvider) {
    prefs.codeGraphProvider = nestedProvider;
  }
  if (!prefs.team && source.subagentTeam !== undefined) {
    prefs.team = source.subagentTeam;
  }
  return normalizeProjectPrefs(prefs);
}

function stripLocalPreferenceFields(value) {
  const out = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  for (const key of LOCAL_PREF_KEYS) {
    delete out[key];
  }
  delete out.codeGraph;
  delete out.subagentTeam;
  if (out.stack && typeof out.stack === 'object' && !Array.isArray(out.stack)) {
    out.stack = { ...out.stack };
    delete out.stack.codeGraph;
    delete out.stack.codeGraphProvider;
  }
  return out;
}

function splitLocalPreferences(cwd, state, env = process.env) {
  if (!hasLocalPreferenceFields(state)) {
    return { state, prefs: readProjectPrefs(cwd, env), changed: false };
  }
  const localPatch = extractProjectPrefs(state);
  const prefs = mergeProjectPrefs(cwd, localPatch, env);
  return {
    state: stripLocalPreferenceFields(state),
    prefs,
    changed: true,
  };
}

function effectiveState(projectState, prefs) {
  const state = projectState && typeof projectState === 'object' && !Array.isArray(projectState)
    ? { ...projectState }
    : {};
  const local = normalizeProjectPrefs(prefs);
  for (const key of LOCAL_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(local, key)) {
      state[key] = local[key];
    } else {
      delete state[key];
    }
  }
  return state;
}

function readEffectiveState(cwd, env = process.env) {
  const { readState } = require('./normalize.cjs');
  return effectiveState(stripLocalPreferenceFields(readState(cwd)), readProjectPrefs(cwd, env));
}

module.exports = {
  LOCAL_PREF_KEYS,
  projectRootHash,
  projectPrefsPath,
  initializeLocalToolchainState,
  normalizeProjectPrefs,
  readProjectPrefs,
  writeProjectPrefs,
  mergeProjectPrefs,
  hasLocalPreferenceFields,
  extractProjectPrefs,
  stripLocalPreferenceFields,
  splitLocalPreferences,
  effectiveState,
  readEffectiveState,
};
