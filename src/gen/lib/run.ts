// src/gen/lib/run.ts
// The codegen run context: in normal mode it writes generated plugin files; in
// --check mode it compares against what's on disk and records drift. The output
// root is the generated plugin root (dist/ by default); sourceRoot is the
// authoring checkout where src/modules and static source docs live.

import * as fs from 'fs';
import * as path from 'path';

export interface GenRunOptions { check: boolean; root: string; sourceRoot?: string; }

export class GenRun {
  readonly check: boolean;
  readonly root: string;
  readonly sourceRoot: string;
  readonly drift: string[] = [];
  readonly written: string[] = [];

  constructor(opts: GenRunOptions) {
    this.check = opts.check;
    this.root = opts.root;
    this.sourceRoot = opts.sourceRoot ?? opts.root;
  }

  // Emit (or check) a single file at a plugin-root-relative path.
  file(relPath: string, content: string): void {
    const abs = path.join(this.root, relPath);
    if (this.check) {
      const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (current !== content) this.drift.push(relPath);
      return;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    this.written.push(relPath);
  }

  // Canonical JSON: 2-space indent + trailing newline (matches the hand-authored
  // configs/manifests, all verified canonical).
  json(relPath: string, value: unknown): void {
    this.file(relPath, `${JSON.stringify(value, null, 2)}\n`);
  }
}
