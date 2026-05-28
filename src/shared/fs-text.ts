// src/shared/fs-text.ts
// Generic text/path fs helpers shared by materialize + the generator (gen).
// Ported from the duplicated copies in materialize/_helpers.cjs + sync-cursor/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { readText } from './fsjson';

export { readText };

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

// Write only when content differs (idempotent generation). Returns true if it wrote.
export function writeTextIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath) && readText(filePath) === content) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}
