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

function migrateLegacyProjectPrefs(cwd: string, env: NodeJS.ProcessEnv): void {
  const legacyPath = projectLocalPrefsPath(cwd);
  if (!fs.existsSync(legacyPath)) return;
  const legacy = migratableProjectPrefs(readJson(legacyPath, {}));
  mergeMissingProjectPrefs(cwd, legacy, env);
}

function migrateLegacyMachineSettings(cwd: string, env: NodeJS.ProcessEnv): void {
  const legacyPath = projectLocalMachinePath(cwd);
  if (!fs.existsSync(legacyPath)) return;
  const legacy = readOneSettings({ ...env, TRAFFIC_ONE_STATE_PATH: legacyPath });
  const canonical = readOneSettings(env);
  const patch: OneSettingsPatch = {};

  if (!canonical.codeGraphProvider && legacy.codeGraphProvider) {
    patch.codeGraphProvider = legacy.codeGraphProvider;
  }
  if (Object.keys(patch).length > 0) updateOneSettings(patch, env);
}

function migrateLegacyProjectLocalTrafficOneState(
  cwd: string,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    migrateLegacyProjectPrefs(cwd, env);
    migrateLegacyMachineSettings(cwd, env);
    removeLegacyProjectLocalTrafficOneRuntime(cwd);
    return true;
  } catch {
    // Preserve the only copy when canonical storage is temporarily unavailable.
    // Runtime still selects the canonical paths and fails closed; a later process
    // retries this migration instead of silently discarding onboarding answers.
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
