// src/gen/lib/content-walk.ts
// Recursively collect every file under a content subtree, returning each file's
// path relative to the subtree base (POSIX-stable) + its absolute path. Shared
// by the rules + skills content gather emitters.

import * as fs from 'fs';
import * as path from 'path';

export interface CollectedFile { rel: string; abs: string; }

export function collectFiles(dir: string, base: string = dir, out: CollectedFile[] = []): CollectedFile[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, base, out);
    else if (entry.isFile()) out.push({ rel: path.relative(base, abs), abs });
  }
  return out;
}
