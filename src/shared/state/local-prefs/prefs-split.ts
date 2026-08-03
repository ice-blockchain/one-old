// src/shared/state/local-prefs/prefs-split.ts
// Strip/extract/split of local preference fields. Leaf-most on purpose:
// state/normalize imports THIS module and must never pull the lock code.

import { obj, type Rec } from '../../obj';

import {
  LOCAL_PREF_KEYS,
  PROJECT_PREF_KEYS,
} from './pref-schema';
import {
  normalizeProjectPrefs,
  readProjectPrefs,
} from './prefs-store';
import {
  mergeProjectPrefs,
} from './prefs-merge';

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
  for (const key of PROJECT_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) prefs[key] = source[key];
  }
  // A leaked NEW local shape can be rescued as-is. Legacy generic performance /
  // team are intentionally omitted so they cannot be attributed to whichever
  // host happens to scrub the shared file first.
  if (Object.prototype.hasOwnProperty.call(source, 'hosts')) prefs.hosts = source.hosts;
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

