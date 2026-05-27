'use strict';

// scripts/hook-runtime/state/canonicalize.cjs
// Canonicalization of state field vocabularies (mobile/team/performance/openCode
// sources, code-graph provider, backend) and the `.traffic-one/.one.json` shape
// migration (`canonicalizeStateShape`).

const { canonicalTier } = require('../model-tiers.cjs');
const { PERFORMANCE_CONFIG } = require('../performance-config.cjs');
const {
  MOBILE_SOURCE_IDS,
  MOBILE_SOURCE_ALIASES,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  TEAM_MODE_ALIASES,
  TEAM_SOURCE_ALIASES,
  PERFORMANCE_LEVEL_IDS,
  OPEN_CODE_SOURCE_IDS,
} = require('./constants.cjs');

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

function canonicalOpenCodeSource(source) {
  if (typeof source !== 'string') return 'prompted';
  const normalized = source.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return OPEN_CODE_SOURCE_IDS.has(normalized) ? normalized : 'prompted';
}

// Returns a canonicalised `{ role: tier }` map, or null when the input has no
// usable overrides (so the field can be omitted from `.traffic-one/.one.json`).
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

module.exports = {
  canonicalMobileSource,
  canonicalTeamMode,
  canonicalTeamSource,
  canonicalOpenCodeSource,
  canonicalTeamOverrides,
  overridesEqual,
  canonicalPerformanceLevel,
  normalizedString,
  mobileStateFromString,
  teamStateFromString,
  codeGraphProviderFromString,
  codeGraphProviderFromValue,
  canonicalMode,
  canonicalBackendValue,
  canonicalizeStateShape,
};
