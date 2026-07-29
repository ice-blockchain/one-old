// src/runners/kilo-host/host-records.ts
// Kilo paths + typed owner/activation wrappers over the shared machinery in
// shared/host/wrapper-records. runtimePluginRoot resolves the compiled layout
// via __dirname/../../.. -- this file must stay a sibling of index.ts at the
// same directory depth.

import * as fs from 'fs';
import * as path from 'path';
import {
  KILO_HOST_GLOBAL_CONFIG_DEFAULT_FILE,
  KILO_HOST_GLOBAL_CONFIG_DIR_REL,
  KILO_HOST_GLOBAL_CONFIG_FILES,
  KILO_HOST_GLOBAL_PLUGIN_FILE,
  KILO_HOST_GLOBAL_PLUGINS_REL,
  KILO_HOST_PACKAGE,
  KILO_HOST_PROJECT_MARKER_REL,
  KILO_HOST_TARGET_VERSION,
} from '../../config/kilo-host';
import {
  buildActivationRecord,
  buildOwnerRecord,
  homeDir,
  readActivationRecord,
  readOwnerRecord,
  type WrapperRecordSpec,
} from '../../shared/host/wrapper-records';

export {
  explicitCwdArg,
  jsString,
  projectRootFromArgs,
  type RunnerOutput,
} from '../../shared/host/wrapper-records';

const SPEC: WrapperRecordSpec = {
  targetField: 'targetKilo',
  targetVersion: KILO_HOST_TARGET_VERSION,
  packageName: KILO_HOST_PACKAGE,
};

function kiloConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'kilo');
  return path.join(homeDir(env), KILO_HOST_GLOBAL_CONFIG_DIR_REL);
}

export function kiloGlobalPluginPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(kiloConfigDir(env), KILO_HOST_GLOBAL_PLUGINS_REL, KILO_HOST_GLOBAL_PLUGIN_FILE);
}

export function kiloGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = kiloConfigDir(env);
  for (const file of KILO_HOST_GLOBAL_CONFIG_FILES) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, KILO_HOST_GLOBAL_CONFIG_DEFAULT_FILE);
}

export function runtimePluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..', '..');
}

interface OwnerRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetKilo: string;
  packageName: string;
  installedAt?: string;
}

interface ProjectActivationRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetKilo: string;
  packageName: string;
  enabled?: boolean;
  enabledAt?: string;
  disabledAt?: string;
}

export function ownerRecord(pluginRoot: string): OwnerRecord {
  return buildOwnerRecord(SPEC, pluginRoot) as unknown as OwnerRecord;
}

export function projectActivationRecord(pluginRoot: string): ProjectActivationRecord {
  return buildActivationRecord(SPEC, pluginRoot, true) as unknown as ProjectActivationRecord;
}

export function projectDisabledRecord(pluginRoot: string): ProjectActivationRecord {
  return buildActivationRecord(SPEC, pluginRoot, false) as unknown as ProjectActivationRecord;
}

export function readOwner(filePath: string): OwnerRecord | null {
  return readOwnerRecord(SPEC, filePath) as unknown as OwnerRecord | null;
}

export function readProjectActivation(filePath: string): ProjectActivationRecord | null {
  return readActivationRecord(SPEC, filePath) as unknown as ProjectActivationRecord | null;
}

export function kiloProjectMarkerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), KILO_HOST_PROJECT_MARKER_REL);
}
