// src/shared/state/local-prefs/prefs-merge.ts
// Merge machinery: missing-value fills, host-pref entries, and the
// performance-target metadata advance.

import { obj, type Rec } from '../../obj';
import { HOST_IDS, type HostModelKey } from '../../../config/model-tiers';
import { detectHost } from '../../host';
import { canonicalHost, canonicalPlan, planIsRecognized } from '../../model-tiers';

import {
  HOST_PREF_KEYS,
  canonicalHostKey,
  normalizePerformanceTarget,
} from './pref-schema';
import {
  normalizeProjectPrefs,
  projectPrefsPath,
  readProjectPrefs,
  updateProjectPrefs,
  withProjectPrefsLock,
  writeProjectPrefs,
  writeProjectPrefsFile,
} from './prefs-store';

function mergeMissingValues(canonical: unknown, fallback: unknown): unknown {
  if (canonical === undefined || canonical === null) return fallback;
  const canonicalObj = obj(canonical);
  const fallbackObj = obj(fallback);
  if (!canonicalObj || !fallbackObj) return canonical;
  const merged: Rec = { ...fallbackObj, ...canonicalObj };
  for (const key of Object.keys(fallbackObj)) {
    merged[key] = mergeMissingValues(canonicalObj[key], fallbackObj[key]);
  }
  return merged;
}

// The project-local migration must merge only after acquiring the same lock used
// by ordinary preference writers. Reading before the lock and then calling
// writeProjectPrefs could overwrite a concurrently committed answer.
export function mergeMissingProjectPrefs(
  cwd: string,
  fallback: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Rec {
  const normalizedFallback = normalizeProjectPrefs(fallback);
  return updateProjectPrefs(cwd, env, (current) => (
    normalizeProjectPrefs(mergeMissingValues(current, normalizedFallback))
  ));
}

function mergePlainObject(current: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return { ...(patch as Rec) };
  return { ...(current as Rec), ...(patch as Rec) };
}

function mergeHostPrefsEntry(current: unknown, patch: unknown): Rec {
  const currentHost = obj(current) || {};
  const patchHost = obj(patch) || {};
  const next: Rec = { ...currentHost, ...patchHost };
  if (Object.prototype.hasOwnProperty.call(patchHost, 'performance')) {
    const p = obj(patchHost.performance);
    next.performance = p && !Object.prototype.hasOwnProperty.call(p, 'level')
      ? mergePlainObject(currentHost.performance, patchHost.performance)
      : patchHost.performance;
  }
  if (Object.prototype.hasOwnProperty.call(patchHost, 'team')) {
    const t = obj(patchHost.team);
    next.team = t && !Object.prototype.hasOwnProperty.call(t, 'mode')
      ? mergePlainObject(currentHost.team, patchHost.team)
      : patchHost.team;
  }
  if (Object.prototype.hasOwnProperty.call(patchHost, 'availableModels')) {
    const capture = obj(patchHost.availableModels);
    next.availableModels = capture && !Object.prototype.hasOwnProperty.call(capture, 'models')
      ? mergePlainObject(currentHost.availableModels, patchHost.availableModels)
      : patchHost.availableModels;
  }
  return next;
}

export function mergeProjectPrefsObject(current: Rec, patch: unknown, activeHost: HostModelKey = detectHost()): Rec {
  const patchObj = obj(patch);
  const normalizedCurrent = normalizeProjectPrefs(current);
  const next: Rec = { ...normalizedCurrent };
  if (patchObj) {
    for (const [key, value] of Object.entries(patchObj)) {
      if (key !== 'hosts' && !HOST_PREF_KEYS.has(key)) next[key] = value;
    }

    const currentHosts = obj(normalizedCurrent.hosts) || {};
    const mergedHosts: Rec = { ...currentHosts };
    const explicitHosts = obj(patchObj.hosts);
    if (explicitHosts) {
      for (const [rawHost, value] of Object.entries(explicitHosts)) {
        const host = canonicalHostKey(rawHost);
        if (!host) continue;
        mergedHosts[host] = mergeHostPrefsEntry(currentHosts[host], value);
      }
    }
    const activePatch: Rec = {};
    for (const key of HOST_PREF_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patchObj, key)) activePatch[key] = patchObj[key];
    }
    if (Object.keys(activePatch).length > 0) {
      mergedHosts[activeHost] = mergeHostPrefsEntry(mergedHosts[activeHost], activePatch);
    }
    if (Object.keys(mergedHosts).length > 0) next.hosts = mergedHosts;
    else delete next.hosts;

    if (Object.prototype.hasOwnProperty.call(patchObj, 'openCode')) {
      const o = obj(patchObj.openCode);
      next.openCode = o && !Object.prototype.hasOwnProperty.call(o, 'enabled')
        ? mergePlainObject(normalizedCurrent.openCode, patchObj.openCode)
        : patchObj.openCode;
    }
    const patchToolchain = obj(patchObj.toolchain);
    if (patchToolchain) {
      const currentToolchain = obj(normalizedCurrent.toolchain) || {};
      const merged: Rec = { ...currentToolchain };
      for (const [name, stamp] of Object.entries(patchToolchain)) {
        const combined = mergePlainObject(currentToolchain[name], stamp);
        // A null/empty installedVersion in the patch must never erase a real
        // stamp: normalize embeds the initialized-null toolchain skeleton in
        // shared state, so every writeState(readState(...)) round-trip carries
        // nulls here — letting them win would wipe a fresh install stamp (e.g.
        // the wizard's install task stamps OpenCode, then finalize's writeState
        // immediately un-stamps it and delegation silently never activates).
        const cur = obj(currentToolchain[name]);
        const out = obj(combined);
        const curVersion = cur && typeof cur.installedVersion === 'string' && cur.installedVersion ? cur.installedVersion : null;
        const outVersion = out && typeof out.installedVersion === 'string' && out.installedVersion ? out.installedVersion : null;
        merged[name] = curVersion && !outVersion && out
          ? {
            ...out,
            installedVersion: curVersion,
            installedAt: typeof cur?.installedAt === 'string' && cur.installedAt ? cur.installedAt : out.installedAt ?? null,
            ...(typeof cur?.binPath === 'string' && cur.binPath ? { binPath: cur.binPath } : {}),
          }
          : combined;
      }
      next.toolchain = merged;
    }
  }
  return normalizeProjectPrefs(next);
}

export function mergeProjectPrefs(cwd: string, patch: unknown, env: NodeJS.ProcessEnv = process.env): Rec {
  return updateProjectPrefs(cwd, env, (current) => mergeProjectPrefsObject(current, patch, detectHost(env)));
}

export function mergeProjectHostPrefs(
  cwd: string,
  host: unknown,
  patch: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Rec {
  const activeHost = canonicalHost(host);
  return updateProjectPrefs(cwd, env, (current) => mergeProjectPrefsObject(current, {
    hosts: { [activeHost]: patch },
  }, activeHost));
}

// Advance only non-semantic acknowledgement metadata. The plan and applied
// fingerprint are the drift keys; when both still match, a remote config
// version change is acknowledged silently under the same per-project lock.
// Missing/pre-release targets are deliberately not backfilled: they reopen the
// Performance step once and become canonical when the user submits it.
export function advanceProjectHostPerformanceTargetMetadata(
  cwd: string,
  host: unknown,
  targetInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const activeHost = canonicalHost(host);
  const target = normalizePerformanceTarget(activeHost, targetInput);
  if (!target) return false;
  const prefsPath = projectPrefsPath(cwd, env);
  let changed = false;
  withProjectPrefsLock(prefsPath, () => {
    const current = readProjectPrefs(cwd, env);
    const hosts = obj(current.hosts);
    const hostPrefs = obj(hosts?.[activeHost]);
    const performance = obj(hostPrefs?.performance);
    const acknowledged = normalizePerformanceTarget(activeHost, performance?.target);
    if (!hosts || !hostPrefs || !performance || !acknowledged
      || acknowledged.plan !== target.plan
      || acknowledged.appliedFingerprint !== target.appliedFingerprint
      || acknowledged.configVersion === target.configVersion) return;
    const next = normalizeProjectPrefs({
      ...current,
      hosts: {
        ...hosts,
        [activeHost]: {
          ...hostPrefs,
          performance: {
            ...performance,
            target,
          },
        },
      },
    });
    writeProjectPrefsFile(prefsPath, next);
    changed = true;
  });
  return changed;
}

function clearedProjectHostPrefs(
  prefs: Rec,
  activeHost: HostModelKey,
  keys: readonly string[],
): Rec {
  const hosts = obj(prefs.hosts) || {};
  const current = obj(hosts[activeHost]);
  if (!current) return prefs;
  const nextHost: Rec = { ...current };
  for (const key of keys) {
    if (HOST_PREF_KEYS.has(key)) delete nextHost[key];
  }
  const nextHosts: Rec = { ...hosts };
  if (Object.keys(nextHost).length > 0) nextHosts[activeHost] = nextHost;
  else delete nextHosts[activeHost];
  const next: Rec = { ...prefs };
  if (Object.keys(nextHosts).length > 0) next.hosts = nextHosts;
  else delete next.hosts;
  return next;
}

export function clearProjectHostPrefs(
  cwd: string,
  host: unknown,
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Rec {
  const activeHost = canonicalHost(host);
  return updateProjectPrefs(cwd, env, (prefs) => (
    clearedProjectHostPrefs(prefs, activeHost, keys)
  ));
}

