// src/shared/host/wrapper-jsonc.ts
// Bounded JSONC parsing + managed-config write shared by the kilo-host and
// opencode-host runners (previously byte-duplicated in each). Host-specific
// policy (the one-mcp disable shape, plugin-spec registration) stays in the
// runners; only the neutral machinery lives here.

import * as fs from 'fs';
import * as path from 'path';

import { ONE_MCP_SERVER_NAME } from '../../config/one-mcp';
import { readRegularFileOrThrow } from '../bounded-read';

export type JsonObject = Record<string, unknown>;
export type ConfigUpdate =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; path: string; error: string };

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

export function parseJsoncObject(file: string): JsonObject | null {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(removeTrailingCommas(stripJsonc(readRegularFileOrThrow(file)))) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
}

export function jsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function managedPermissionKey(tool: string): string {
  return `${ONE_MCP_SERVER_NAME}_${tool}`;
}

export function writeConfig(file: string, config: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
