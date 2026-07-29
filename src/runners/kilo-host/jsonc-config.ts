// src/runners/kilo-host/jsonc-config.ts
// Bounded JSONC read/strip/write for the Kilo global config plus the
// managed one-mcp disable status.

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_MANAGED_TOOLS,
  ONE_MCP_REGISTRATION,
  ONE_MCP_SERVER_NAME,
} from '../../config/one-mcp';

import {
  kiloGlobalConfigPath,
} from './host-records';
import {
  jsonObject,
  managedPermissionKey,
  parseJsoncObject,
  writeConfig,
  type JsonObject,
  type ConfigUpdate,
} from '../../shared/host/wrapper-jsonc';








export function ensureOneMcpDisabled(env: NodeJS.ProcessEnv = process.env): ConfigUpdate {
  const file = kiloGlobalConfigPath(env);
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, error: `Could not parse Kilo global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, error: 'Kilo global config must be a JSON object.' };
  let changed = false;
  if (!('$schema' in config)) { config.$schema = 'https://app.kilo.ai/config.json'; changed = true; }
  if (config.mcp === undefined) { config.mcp = {}; changed = true; }
  const mcp = jsonObject(config.mcp);
  if (!mcp) return { ok: false, path: file, error: 'Kilo global config `mcp` must be an object.' };
  if (mcp[ONE_MCP_SERVER_NAME] === undefined) {
    mcp[ONE_MCP_SERVER_NAME] = {
      type: 'remote',
      url: DEFAULT_PUBLIC_ENDPOINT,
      enabled: false,
      oauth: false,
    };
    changed = true;
  }
  if (config.permission === undefined) { config.permission = {}; changed = true; }
  const permission = jsonObject(config.permission);
  if (!permission) return { ok: false, path: file, error: 'Kilo global config `permission` must be an object.' };
  for (const tool of ONE_MCP_MANAGED_TOOLS) {
    const key = managedPermissionKey(tool);
    if (permission[key] === undefined) { permission[key] = 'deny'; changed = true; }
  }
  if (changed) writeConfig(file, config);
  return { ok: true, path: file, changed };
}

export function oneMcpDisabledStatus(env: NodeJS.ProcessEnv = process.env): ConfigUpdate {
  const file = kiloGlobalConfigPath(env);
  let config: JsonObject | null;
  try {
    config = parseJsoncObject(file);
  } catch (error) {
    return { ok: false, path: file, error: `Could not parse Kilo global config: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!config) return { ok: false, path: file, error: 'Kilo global config must be a JSON object.' };
  const mcp = jsonObject(config.mcp);
  const entry = mcp ? jsonObject(mcp[ONE_MCP_SERVER_NAME]) : null;
  if (!entry) return { ok: false, path: file, error: `Kilo global config is missing mcp.${ONE_MCP_SERVER_NAME}.` };
  if (entry.enabled !== false) {
    return { ok: false, path: file, error: `Kilo mcp.${ONE_MCP_SERVER_NAME} is user-owned or enabled; Traffic One leaves it untouched and relies on the universal tool deny.` };
  }
  const permission = jsonObject(config.permission);
  for (const tool of ONE_MCP_MANAGED_TOOLS) {
    if (permission?.[managedPermissionKey(tool)] !== 'deny') {
      return { ok: false, path: file, error: `Kilo global config is missing deny permission for ${managedPermissionKey(tool)}.` };
    }
  }
  return { ok: true, path: file, changed: false };
}
