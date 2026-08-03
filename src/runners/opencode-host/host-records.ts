// src/runners/opencode-host/host-records.ts
// OpenCode paths + typed owner/activation wrappers over the shared machinery
// in shared/host/wrapper-records. runtimePluginRoot resolves the compiled
// layout via __dirname/../../.. -- this file must stay a sibling of index.ts
// at the same directory depth.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
  OPENCODE_HOST_GLOBAL_CONFIG_DEFAULT_FILE,
  OPENCODE_HOST_GLOBAL_CONFIG_DIR_REL,
  OPENCODE_HOST_GLOBAL_CONFIG_FILES,
  OPENCODE_HOST_GLOBAL_PLUGIN_FILE,
  OPENCODE_HOST_GLOBAL_PLUGINS_REL,
  OPENCODE_HOST_PACKAGE,
  OPENCODE_HOST_PROJECT_MARKER_REL,
  OPENCODE_HOST_TARGET_VERSION,
  OPENCODE_HOST_WRAPPER_API,
} from '../../config/opencode-host';
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
  targetField: 'targetOpenCode',
  targetVersion: OPENCODE_HOST_TARGET_VERSION,
  packageName: OPENCODE_HOST_PACKAGE,
  wrapperApi: OPENCODE_HOST_WRAPPER_API,
};

function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'opencode');
  return path.join(homeDir(env), OPENCODE_HOST_GLOBAL_CONFIG_DIR_REL);
}

export function opencodeGlobalPluginPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(opencodeConfigDir(env), OPENCODE_HOST_GLOBAL_PLUGINS_REL, OPENCODE_HOST_GLOBAL_PLUGIN_FILE);
}

export function opencodeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = opencodeConfigDir(env);
  for (const file of OPENCODE_HOST_GLOBAL_CONFIG_FILES) {
    const candidate = path.join(dir, file);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, OPENCODE_HOST_GLOBAL_CONFIG_DEFAULT_FILE);
}

export function opencodeGlobalPluginSpecifier(env: NodeJS.ProcessEnv = process.env): string {
  return pathToFileURL(opencodeGlobalPluginPath(env)).href;
}

export function runtimePluginRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..', '..');
}

interface OwnerRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetOpenCode: string;
  packageName: string;
  wrapperApi?: number;
  installedAt?: string;
}

interface ProjectActivationRecord {
  owner: string;
  version: 1;
  pluginRoot: string;
  targetOpenCode: string;
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

export function opencodeProjectMarkerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), OPENCODE_HOST_PROJECT_MARKER_REL);
}
