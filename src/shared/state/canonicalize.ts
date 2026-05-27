// src/shared/state/canonicalize.ts
// Vocabulary canonicalization + the .one.json shape migration. Ported 1:1 from
// scripts/hook-runtime/state/canonicalize.cjs — behavior must match exactly.

import { canonicalTier } from '../model-tiers';
import { PERFORMANCE_CONFIG } from '../performance-config';
import {
  MOBILE_SOURCE_ALIASES,
  MOBILE_SOURCE_IDS,
  OPEN_CODE_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  TEAM_MODE_ALIASES,
  TEAM_MODE_IDS,
  TEAM_SOURCE_ALIASES,
  TEAM_SOURCE_IDS,
} from './constants';

type StateRecord = Record<string, unknown>;

export function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[_\s]+/g, '-') : '';
}

export function canonicalMobileSource(source: unknown): unknown {
  if (typeof source !== 'string') return source;
  if (MOBILE_SOURCE_IDS.has(source)) return source;
  const normalized = source.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (MOBILE_SOURCE_IDS.has(normalized)) return normalized;
  return MOBILE_SOURCE_ALIASES.get(normalized) || source;
}

export function canonicalTeamMode(mode: unknown): unknown {
  if (typeof mode !== 'string') return mode;
  if (TEAM_MODE_IDS.has(mode)) return mode;
  const normalized = mode.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (TEAM_MODE_IDS.has(normalized)) return normalized;
  return TEAM_MODE_ALIASES.get(normalized) || mode;
}

export function canonicalTeamSource(source: unknown): unknown {
  if (typeof source !== 'string') return source;
  if (TEAM_SOURCE_IDS.has(source)) return source;
  const normalized = source.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (TEAM_SOURCE_IDS.has(normalized)) return normalized;
  return TEAM_SOURCE_ALIASES.get(normalized) || source;
}

export function canonicalOpenCodeSource(source: unknown): string {
  if (typeof source !== 'string') return 'prompted';
  const normalized = source.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return OPEN_CODE_SOURCE_IDS.has(normalized) ? normalized : 'prompted';
}

// Canonical { role: tier } map, or null when there are no usable overrides.
export function canonicalTeamOverrides(overrides: unknown, level: unknown): Record<string, string> | null {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
  const levelKey = typeof level === 'string' ? level : '';
  const levelCfg = levelKey ? PERFORMANCE_CONFIG[levelKey] : undefined;
  const baseAgents = levelCfg ? levelCfg.agents : null;
  const validRoles = new Set<string>();
  if (baseAgents) {
    for (const role of Object.keys(baseAgents)) validRoles.add(role);
  } else {
    for (const cfg of Object.values(PERFORMANCE_CONFIG)) {
      for (const role of Object.keys(cfg.agents)) validRoles.add(role);
    }
  }
  const result: Record<string, string> = {};
  for (const [role, tier] of Object.entries(overrides as StateRecord)) {
    if (!validRoles.has(role)) continue;
    const canonical = canonicalTier(tier);
    if (!canonical) continue;
    const base = baseAgents ? baseAgents[role] : undefined;
    if (base && base.tier === canonical) continue;
    result[role] = canonical;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function overridesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const a = left && typeof left === 'object' ? (left as StateRecord) : null;
  const b = right && typeof right === 'object' ? (right as StateRecord) : null;
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

export function canonicalPerformanceLevel(level: unknown): unknown {
  if (typeof level !== 'string') return level;
  if (PERFORMANCE_LEVEL_IDS.has(level)) return level;
  const normalized = level.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return PERFORMANCE_LEVEL_IDS.has(normalized) ? normalized : level;
}

function mobileStateFromString(value: unknown): StateRecord | null {
  const normalized = normalizedString(value);
  if (!normalized) return null;
  if (normalized === 'web' || normalized === 'web-only') return { enabled: false, framework: 'none', source: 'prompted' };
  if (normalized === 'none' || normalized === 'no-mobile' || normalized === 'disabled') return { enabled: false, framework: 'none', source: 'none' };
  if (normalized === 'ionic' || normalized === 'ionic-capacitor') return { enabled: true, framework: 'ionic-capacitor', source: 'prompted' };
  if (normalized === 'react-native' || normalized === 'react-native-expo' || normalized === 'expo') return { enabled: true, framework: 'react-native-expo', source: 'prompted' };
  return null;
}

function teamStateFromString(value: unknown): StateRecord | null {
  const mode = canonicalTeamMode(value);
  return typeof mode === 'string' && TEAM_MODE_IDS.has(mode) ? { mode, source: 'prompted' } : null;
}

export function codeGraphProviderFromString(value: unknown): string | null {
  const normalized = normalizedString(value);
  return normalized === 'gitnexus' || normalized === 'graphify' ? normalized : null;
}

export function codeGraphProviderFromValue(value: unknown): string | null {
  const direct = codeGraphProviderFromString(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as StateRecord;
  for (const key of ['provider', 'codeGraphProvider', 'id', 'name']) {
    const nested = codeGraphProviderFromValue(record[key]);
    if (nested) return nested;
  }
  return null;
}

export function canonicalMode(value: unknown): string | null {
  const normalized = normalizedString(value);
  if (normalized === 'new-project' || normalized === 'existing-codebase') return normalized;
  return typeof value === 'string' ? value : null;
}

export function canonicalBackendValue(value: unknown): unknown {
  const normalized = normalizedString(value);
  if (normalized === 'supabase-ready' || normalized === 'supabase-default' || normalized === 'managed-supabase') {
    return 'supabase';
  }
  return value;
}

export function canonicalizeStateShape(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const s = state as StateRecord;
  let changed = false;

  if (!s.mode && typeof s.projectMode === 'string') {
    const mode = canonicalMode(s.projectMode);
    if (mode) { s.mode = mode; changed = true; }
  }
  if (Object.prototype.hasOwnProperty.call(s, 'projectMode')) { delete s.projectMode; changed = true; }

  const compactStack = s.stack && typeof s.stack === 'object' && !Array.isArray(s.stack)
    ? (s.stack as StateRecord)
    : null;
  if (compactStack) {
    if (typeof compactStack.id === 'string' && compactStack.id.trim()) { s.stack = compactStack.id.trim(); changed = true; }
    if (!s.frontend && typeof compactStack.frontend === 'string') { s.frontend = compactStack.frontend; changed = true; }
    if (!s.backend && typeof compactStack.backend === 'string') { s.backend = compactStack.backend; changed = true; }
    if ((s.mobile === undefined || s.mobile === null) && compactStack.mobile !== undefined) { s.mobile = compactStack.mobile; changed = true; }
    if (!s.codeGraphProvider) {
      const provider = codeGraphProviderFromValue(compactStack.codeGraph || compactStack.codeGraphProvider);
      if (provider) { s.codeGraphProvider = provider; changed = true; }
    }
    if ((s.team === undefined || s.team === null) && compactStack.team !== undefined) { s.team = compactStack.team; changed = true; }
    if (Object.prototype.hasOwnProperty.call(s, 'project')) { delete s.project; changed = true; }
  }

  if (typeof s.backend === 'string') {
    const backend = canonicalBackendValue(s.backend);
    if (backend !== s.backend) { s.backend = backend; changed = true; }
  }

  if (typeof s.mobile === 'string') {
    const mobile = mobileStateFromString(s.mobile);
    if (mobile) { s.mobile = mobile; changed = true; }
  }

  if ((s.team === undefined || s.team === null) && s.subagentTeam !== undefined) { s.team = s.subagentTeam; changed = true; }
  if (Object.prototype.hasOwnProperty.call(s, 'subagentTeam')) { delete s.subagentTeam; changed = true; }

  if (typeof s.team === 'string') {
    const team = teamStateFromString(s.team);
    if (team) { s.team = team; changed = true; }
  }

  const canonicalProvider = codeGraphProviderFromValue(s.codeGraphProvider);
  if (canonicalProvider && s.codeGraphProvider !== canonicalProvider) { s.codeGraphProvider = canonicalProvider; changed = true; }

  if (!s.codeGraphProvider && s.codeGraph !== undefined) {
    const provider = codeGraphProviderFromValue(s.codeGraph);
    if (provider) { s.codeGraphProvider = provider; delete s.codeGraph; changed = true; }
  }

  if (typeof s.performance === 'string') {
    const level = canonicalPerformanceLevel(s.performance);
    if (typeof level === 'string' && PERFORMANCE_LEVEL_IDS.has(level)) { s.performance = { level, source: 'prompted' }; changed = true; }
  }

  return changed;
}
