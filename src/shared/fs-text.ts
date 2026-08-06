// src/shared/fs-text.ts
// Generic text/path fs helpers shared by materialize + the generator (gen).
// Ported from the duplicated copies in materialize/_helpers.cjs + sync-cursor/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { readText, writeTextFile } from './fsjson';

export { readText };

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

// Write only when content differs (idempotent generation). Returns true if it wrote.
// Routes through fsjson's guarded writer, so the ~190 project-state files a
// materialization emits are covered by the consent fence AND the symlink fence
// for free — this helper is the single busiest writer under
// `<project>/.traffic-one/`.
//
// The skip-if-identical check reads through a symlink (`existsSync`/`readText`
// both follow), so a link whose target already holds the desired bytes returns
// `false` — "nothing to write" — before writeTextFile ever sees it. That reads as
// a no-op and IS one: no write is performed either way, and the caller's contract
// here is only "did I write". Every path that actually mutates goes through
// writeTextFile, which refuses the link.
export function writeTextIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath) && readText(filePath) === content) return false;
  return writeTextFile(filePath, content);
}
