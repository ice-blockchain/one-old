// src/runners/opencode-host/jsonc-config.ts
// Bounded JSONC editing for the OpenCode global config: plugin-spec
// normalization, global plugin registration, and the one-mcp disable.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_MANAGED_TOOLS,
  ONE_MCP_REGISTRATION,
  ONE_MCP_SERVER_NAME,
} from '../../config/one-mcp';

import {
  opencodeGlobalConfigPath,
  opencodeGlobalPluginSpecifier,
} from './host-records';
import {
  jsonObject,
  managedPermissionKey,
  parseJsoncObject,
  writeConfig,
  type JsonObject,
} from '../../shared/host/wrapper-jsonc';

export function jsString(value: string): string {
  return JSON.stringify(value);
}

type ConfigUpdate = { ok: true; path: string; spec: string; changed: boolean } | { ok: false; path: string; spec: string; error: string };




function normalizePluginSpec(spec: string, configFile: string): string {
  try {
    if (spec.startsWith('file://')) return path.resolve(fileURLToPath(spec));
  } catch {
    return spec;
  }
  if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) return path.resolve(spec);
  if (spec.startsWith('./') || spec.startsWith('../')) return path.resolve(path.dirname(configFile), spec);
  return spec;
}

function pluginEntrySpec(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return null;
}

function samePluginEntry(entry: unknown, spec: string, configFile: string): boolean {
  const value = pluginEntrySpec(entry);
  if (!value) return false;
  return normalizePluginSpec(value, configFile) === normalizePluginSpec(spec, configFile);
}




function ensureOneMcpDisabled(
  config: JsonObject,
  endpoint: string,
): { ok: true; changed: boolean } | { ok: false; error: string } {
  let changed = false;
  if (config.mcp === undefined) {
    config.mcp = {};
    changed = true;
  }
  const mcp = jsonObject(config.mcp);
  if (!mcp) return { ok: false, error: 'OpenCode global config `mcp` must be an object.' };
  // Same-name entries may be user-owned. Never overwrite them; the wrapper's
  // exact pre-tool deny remains authoritative even if a user enables one.
  if (mcp[ONE_MCP_SERVER_NAME] === undefined) {
    mcp[ONE_MCP_SERVER_NAME] = {
      type: 'remote',
      url: endpoint,
      enabled: false,
    };
    changed = true;
  }

  if (config.permission === undefined) {
    config.permission = {};
    changed = true;
  }
  const permission = jsonObject(config.permission);
  if (!permission) return { ok: false, error: 'OpenCode global config `permission` must be an object.' };
  for (const tool of ONE_MCP_MANAGED_TOOLS) {
    const key = managedPermissionKey(tool);
    if (permission[key] === undefined) {
      permission[key] = 'deny';
      changed = true;
    }
  }
  return { ok: true, changed };
}

function oneMcpDisabledStatus(config: JsonObject): string | null {
  const mcp = jsonObject(config.mcp);
  const entry = mcp ? jsonObject(mcp[ONE_MCP_SERVER_NAME]) : null;
  if (!entry) return `OpenCode global config is missing mcp.${ONE_MCP_SERVER_NAME}.`;
  if (entry.enabled !== false) return `OpenCode mcp.${ONE_MCP_SERVER_NAME} is user-owned or enabled; Traffic One leaves it untouched and relies on the universal tool deny.`;
  const permission = jsonObject(config.permission);
  for (const tool of ONE_MCP_MANAGED_TOOLS) {
    if (permission?.[managedPermissionKey(tool)] !== 'deny') {
      return `OpenCode global config is missing deny permission for ${managedPermissionKey(tool)}.`;
    }
  }
  return null;
}

export function ensureGlobalConfigPlugin(
  env: NodeJS.ProcessEnv = process.env,
  registrationFeatureEnabled?: boolean,
): ConfigUpdate {
  const file = opencodeGlobalConfigPath(env);
  const spec = opencodeGlobalPluginSpecifier(env);
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, spec, error: `Could not parse OpenCode global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, spec, error: 'OpenCode global config must be a JSON object.' };
  let changed = false;
  if (!('$schema' in config)) { config.$schema = 'https://opencode.ai/config.json'; changed = true; }
  if (config.plugin === undefined) { config.plugin = []; changed = true; }
  if (!Array.isArray(config.plugin)) return { ok: false, path: file, spec, error: 'OpenCode global config `plugin` must be an array.' };
  if (!config.plugin.some((entry) => samePluginEntry(entry, spec, file))) {
    config.plugin.push(spec);
    changed = true;
  }
  if (registrationFeatureEnabled ?? ONE_MCP_REGISTRATION) {
    const oneMcp = ensureOneMcpDisabled(config, DEFAULT_PUBLIC_ENDPOINT);
    if (!oneMcp.ok) return { ok: false, path: file, spec, error: oneMcp.error };
    changed = changed || oneMcp.changed;
  }
  if (changed) writeConfig(file, config);
  return { ok: true, path: file, spec, changed };
}

export function removeGlobalConfigPlugin(env: NodeJS.ProcessEnv = process.env): ConfigUpdate {
  const file = opencodeGlobalConfigPath(env);
  const spec = opencodeGlobalPluginSpecifier(env);
  if (!fs.existsSync(file)) return { ok: true, path: file, spec, changed: false };
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, spec, error: `Could not parse OpenCode global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, spec, error: 'OpenCode global config must be a JSON object.' };
  if (config.plugin === undefined) return { ok: true, path: file, spec, changed: false };
  if (!Array.isArray(config.plugin)) return { ok: false, path: file, spec, error: 'OpenCode global config `plugin` must be an array.' };
  const next = config.plugin.filter((entry) => !samePluginEntry(entry, spec, file));
  if (next.length === config.plugin.length) return { ok: true, path: file, spec, changed: false };
  config.plugin = next;
  writeConfig(file, config);
  return { ok: true, path: file, spec, changed: true };
}

export function globalConfigHasPlugin(
  env: NodeJS.ProcessEnv = process.env,
  registrationFeatureEnabled?: boolean,
): ConfigUpdate {
  const file = opencodeGlobalConfigPath(env);
  const spec = opencodeGlobalPluginSpecifier(env);
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, spec, error: `Could not parse OpenCode global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, spec, error: 'OpenCode global config must be a JSON object.' };
  if (!Array.isArray(config.plugin)) return { ok: false, path: file, spec, error: 'OpenCode global config is missing a `plugin` array.' };
  if (!config.plugin.some((entry) => samePluginEntry(entry, spec, file))) return { ok: false, path: file, spec, error: 'Traffic One wrapper is not registered in the OpenCode global `plugin` array.' };
  if (registrationFeatureEnabled ?? ONE_MCP_REGISTRATION) {
    const oneMcpError = oneMcpDisabledStatus(config);
    if (oneMcpError) return { ok: false, path: file, spec, error: oneMcpError };
  }
  return { ok: true, path: file, spec, changed: false };
}
