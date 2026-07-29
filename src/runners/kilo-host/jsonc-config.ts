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

type JsonObject = Record<string, unknown>;
type ConfigUpdate = { ok: true; path: string; changed: boolean } | { ok: false; path: string; error: string };

function stripJsonc(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] || '';
    const next = input[i + 1] || '';
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function removeTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] || '';
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (/\s/.test(input[j] || '')) j += 1;
      if (input[j] === '}' || input[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseJsoncObject(file: string): JsonObject | null {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(removeTrailingCommas(stripJsonc(fs.readFileSync(file, 'utf8')))) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
}

function jsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function managedPermissionKey(tool: string): string {
  return `${ONE_MCP_SERVER_NAME}_${tool}`;
}

function writeConfig(file: string, config: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

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
