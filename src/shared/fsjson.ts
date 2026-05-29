// src/shared/fsjson.ts
// The ONE JSON/text IO layer (legacy reimplemented readJson/parseJsonText/
// writeJson per runner). Implements the FsJson service consumed via Ctx.

import * as fs from 'fs';
import * as path from 'path';

import type { FsJson } from '../core/types';

export function parseJson<T = unknown>(text: string, fallback: T): T {
  try {
    const value = JSON.parse(String(text ?? '').trim() || 'null');
    return value == null ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

export function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export function readJson<T = unknown>(filePath: string, fallback: T): T {
  const text = readText(filePath);
  return text == null ? fallback : parseJson<T>(text, fallback);
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export const fsjson: FsJson = { readText, readJson, writeJson };
