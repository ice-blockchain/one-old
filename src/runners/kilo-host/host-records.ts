// src/runners/kilo-host/host-records.ts
// Owner/activation records + config paths. runtimePluginRoot resolves the
// compiled layout via __dirname/../../.. -- this file must stay a sibling
// of index.ts at the same directory depth.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  KILO_HOOK_CHAT_MESSAGE,
  KILO_HOOK_EVENT,
  KILO_HOOK_PERMISSION_ASK,
  KILO_HOOK_SHELL_ENV,
  KILO_HOOK_SYSTEM_TRANSFORM,
  KILO_HOOK_TOOL_AFTER,
  KILO_HOOK_TOOL_BEFORE,
  KILO_HOST_GLOBAL_CONFIG_DEFAULT_FILE,
  KILO_HOST_GLOBAL_CONFIG_DIR_REL,
  KILO_HOST_GLOBAL_CONFIG_FILES,
  KILO_HOST_GLOBAL_PLUGIN_FILE,
  KILO_HOST_GLOBAL_PLUGIN_ID,
  KILO_HOST_GLOBAL_PLUGINS_REL,
  KILO_HOST_PACKAGE,
  KILO_HOST_PROJECT_MARKER_REL,
  KILO_HOST_TARGET_VERSION,
} from '../../config/kilo-host';

export interface RunnerOutput { code: number; stdout: string; stderr?: string; }

const OWNER_NAME = 'traffic-one';
const OWNER_RE = /TRAFFIC_ONE_WRAPPER_OWNER\s*=\s*(\{[^\n]+});/;

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function kiloConfigDir(env: NodeJS.ProcessEnv = process.env): string {
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
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetKilo: KILO_HOST_TARGET_VERSION,
    packageName: KILO_HOST_PACKAGE,
    installedAt: new Date().toISOString(),
  };
}

export function projectActivationRecord(pluginRoot: string): ProjectActivationRecord {
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetKilo: KILO_HOST_TARGET_VERSION,
    packageName: KILO_HOST_PACKAGE,
    enabled: true,
    enabledAt: new Date().toISOString(),
  };
}

export function projectDisabledRecord(pluginRoot: string): ProjectActivationRecord {
  return {
    owner: OWNER_NAME,
    version: 1,
    pluginRoot,
    targetKilo: KILO_HOST_TARGET_VERSION,
    packageName: KILO_HOST_PACKAGE,
    enabled: false,
    disabledAt: new Date().toISOString(),
  };
}

export function readOwner(filePath: string): OwnerRecord | null {
  try {
    const body = fs.readFileSync(filePath, 'utf8');
    const match = body.match(OWNER_RE);
    if (!match || !match[1]) return null;
    const parsed = JSON.parse(match[1]) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.owner !== OWNER_NAME || rec.version !== 1 || typeof rec.pluginRoot !== 'string') return null;
    return {
      owner: OWNER_NAME,
      version: 1,
      pluginRoot: rec.pluginRoot,
      targetKilo: typeof rec.targetKilo === 'string' ? rec.targetKilo : '',
      packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
      ...(typeof rec.installedAt === 'string' ? { installedAt: rec.installedAt } : {}),
    };
  } catch {
    return null;
  }
}

export function readProjectActivation(filePath: string): ProjectActivationRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.owner !== OWNER_NAME || rec.version !== 1 || typeof rec.pluginRoot !== 'string') return null;
    return {
      owner: OWNER_NAME,
      version: 1,
      pluginRoot: rec.pluginRoot,
      targetKilo: typeof rec.targetKilo === 'string' ? rec.targetKilo : '',
      packageName: typeof rec.packageName === 'string' ? rec.packageName : '',
      ...(typeof rec.enabled === 'boolean' ? { enabled: rec.enabled } : {}),
      ...(typeof rec.enabledAt === 'string' ? { enabledAt: rec.enabledAt } : {}),
      ...(typeof rec.disabledAt === 'string' ? { disabledAt: rec.disabledAt } : {}),
    };
  } catch {
    return null;
  }
}

export function kiloProjectMarkerPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), KILO_HOST_PROJECT_MARKER_REL);
}

export function explicitCwdArg(args: readonly string[]): string | null {
  const eq = args.find((arg) => arg.startsWith('--cwd='));
  if (eq) return eq.slice('--cwd='.length);
  const index = args.indexOf('--cwd');
  if (index >= 0 && typeof args[index + 1] === 'string') return args[index + 1] as string;
  return null;
}

export function projectRootFromArgs(env: NodeJS.ProcessEnv, args: readonly string[]): string {
  return path.resolve(explicitCwdArg(args) || env.PWD || process.cwd());
}

export function jsString(value: string): string {
  return JSON.stringify(value);
}
