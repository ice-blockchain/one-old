// One-time bridge from the retired project-local runtime to the canonical
// per-user state tree. Migration MUST happen before cleanup: during a plugin
// upgrade an older Cursor hook can finish onboarding into .traffic-one while a
// newer hook is already polling ~/.traffic-one. Deleting first loses the final
// Performance/team answers and leaves the newer waiter blocked forever.

import * as fs from 'fs';

import type { HostId } from '../../core/types';
import { readJson } from '../fsjson';
import { readOneSettings, updateOneSettings, type OneSettingsPatch } from '../one-settings';
import type { Rec } from '../obj';
import {
  LOCAL_PREF_KEYS,
  mergeMissingProjectPrefs,
  normalizeProjectPrefs,
} from './local-prefs';
import {
  applyTrafficOneEnv,
  projectLocalMachinePath,
  projectLocalPrefsPath,
  removeLegacyProjectLocalTrafficOneRuntime,
  resolveTrafficOneEnv,
} from './traffic-one-paths';

// The project-local bridge is intentionally an allowlist. Older runtimes could
// leave arbitrary top-level fields in preferences.json, and normal preference
// reads preserve unknown canonical fields for forward compatibility. That
// forward-compatible behavior must not turn this one-time bridge into a path
// for obsolete project-local state to enter the canonical per-user store.
const MIGRATABLE_PROJECT_PREF_KEYS = new Set<string>([
  ...LOCAL_PREF_KEYS,
  'pluginUse',
]);

function migratableProjectPrefs(value: unknown): Rec {
  const normalized = normalizeProjectPrefs(value);
  return Object.fromEntries(
    Object.entries(normalized).filter(([key]) => MIGRATABLE_PROJECT_PREF_KEYS.has(key)),
  );
}

/**
 * True only when every migratable key the legacy copy carried is IN the canonical
 * store afterwards.
 *
 * A read-back compare, not a forwarded boolean, because the refusal that matters
 * here is silent in both senses: `updateProjectPrefs` declines to CREATE a
 * per-project prefs root for a directory that belongs to an enclosing project
 * (the nested Go-package case its own comment records) and returns the UNCHANGED
 * current prefs — no throw, no `false`, nothing a caller could have consulted.
 * Verifying against the record it hands back is the only thing that separates
 * "merged" from "declined".
 *
 * Presence, not deep equality: `normalizeProjectPrefs` legitimately rewrites
 * values on the way in (initializeLocalToolchainState is the one that does), and
 * `migratableProjectPrefs` has already normalized the legacy side, so every key
 * left in it is one that survives normalization.
 */
function migrateLegacyProjectPrefs(cwd: string, env: NodeJS.ProcessEnv): boolean {
  const legacyPath = projectLocalPrefsPath(cwd);
  if (!fs.existsSync(legacyPath)) return true;
  const legacy = migratableProjectPrefs(readJson(legacyPath, {}));
  const canonical = mergeMissingProjectPrefs(cwd, legacy, env);
  return Object.keys(legacy).every((key) => Object.prototype.hasOwnProperty.call(canonical, key));
}

function migrateLegacyMachineSettings(cwd: string, env: NodeJS.ProcessEnv): boolean {
  const legacyPath = projectLocalMachinePath(cwd);
  if (!fs.existsSync(legacyPath)) return true;
  const legacy = readOneSettings({ ...env, TRAFFIC_ONE_STATE_PATH: legacyPath });
  const canonical = readOneSettings(env);
  const patch: OneSettingsPatch = {};

  if (!canonical.codeGraphProvider && legacy.codeGraphProvider) {
    patch.codeGraphProvider = legacy.codeGraphProvider;
  }
  if (Object.keys(patch).length === 0) return true;
  updateOneSettings(patch, env);
  // Same read-back rule as the prefs half. `updateOneSettings` throws on a
  // malformed store, which the caller's `catch` turns into "keep the legacy
  // copy", but the question this answers is whether the VALUE is canonical now.
  return readOneSettings(env).codeGraphProvider === patch.codeGraphProvider;
}

/**
 * True only when the answers are in the canonical store AND the legacy copy is
 * gone — the two halves of "this migration is done".
 *
 * THE ORDER IS THE FIX. Every statement here used to run unconditionally and
 * `true` was returned regardless, so a migration the canonical store silently
 * declined was followed by the irreversible delete of the only copy of the user's
 * onboarding answers, and reported as a completed migration. The asymmetry is
 * what makes it obvious: an EACCES already returned `false` and kept the legacy
 * copy (that is what the `catch` below is for), while the refusal nobody
 * anticipated got the unsafe answer. Measured: with the ask-first question
 * disabled (`TRAFFIC_ONE_ASK_USE_PLUGIN=0`, a documented override) in a directory
 * that belongs to an enclosing project, the merge was declined and the legacy
 * `preferences.json` was deleted.
 *
 * Under the SHIPPED default the two refusals happen to coincide — both key off
 * the same absent per-user prefs file, so the consent fence refuses the delete in
 * exactly the case the prefs guard declines the merge — but that is a coincidence
 * of two independent conditions, not a guarantee, and it is not what the override
 * above does.
 */
function migrateLegacyProjectLocalTrafficOneState(
  cwd: string,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    // Preserve the only copy when canonical storage declined it. Runtime still
    // selects the canonical paths and fails closed; a later process retries this
    // migration instead of silently discarding onboarding answers.
    if (!migrateLegacyProjectPrefs(cwd, env)) return false;
    if (!migrateLegacyMachineSettings(cwd, env)) return false;
    // A refused delete leaves the legacy copy in place, which means the bridge is
    // not finished and the next process must run it again — so it is forwarded
    // rather than assumed, and this function no longer has a `true` to invent.
    return removeLegacyProjectLocalTrafficOneRuntime(cwd);
  } catch {
    return false;
  }
}

export function initializeTrafficOneEnv(
  cwd: string,
  host: HostId,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const canonicalEnv = resolveTrafficOneEnv(cwd, host, baseEnv);
  migrateLegacyProjectLocalTrafficOneState(cwd, canonicalEnv);
  return applyTrafficOneEnv(cwd, host, baseEnv);
}
