// src/gen/lib/run.ts
// The codegen run context: in normal mode it writes generated plugin files; in
// --check mode it compares against what's on disk and records drift. The output
// root is the generated plugin root (dist/ by default); sourceRoot is the
// authoring checkout where src/modules and static source docs live.

import * as fs from 'fs';
import * as path from 'path';

export interface GenRunOptions { check: boolean; root: string; sourceRoot?: string; }

export interface EmittedDoc { relPath: string; content: string; }

export class GenRun {
  readonly check: boolean;
  readonly root: string;
  readonly sourceRoot: string;
  readonly drift: string[] = [];
  readonly written: string[] = [];
  readonly pruned: string[] = [];
  private readonly emittedByPath = new Map<string, string>();

  constructor(opts: GenRunOptions) {
    this.check = opts.check;
    this.root = opts.root;
    this.sourceRoot = opts.sourceRoot ?? opts.root;
  }

  private posixKey(relPath: string): string {
    return relPath.split(path.sep).join('/');
  }

  // Emit (or check) a single file at a plugin-root-relative path.
  file(relPath: string, content: string): void {
    const key = this.posixKey(relPath);
    const previous = this.emittedByPath.get(key);
    if (previous !== undefined && previous !== content) {
      throw new Error(`gen: colliding emit for ${key}`);
    }
    this.emittedByPath.set(key, content);
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

  // Everything emitted so far under a posix relPath prefix, sorted by relPath.
  // Later emitters derive from this instead of reading the output tree back, so
  // --check sees downstream drift caused by upstream source changes.
  emitted(prefix: string): EmittedDoc[] {
    const docs: EmittedDoc[] = [];
    for (const [relPath, content] of this.emittedByPath) {
      if (relPath.startsWith(prefix)) docs.push({ relPath, content });
    }
    docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return docs;
  }

  // Sweep managed output dirs for files no emitter produced this run: stale
  // copies of deleted source content. Write mode deletes them; check mode
  // reports them as drift so gen:check fails until a real gen runs.
  sweepOrphans(managedDirs: readonly string[]): void {
    for (const dirRel of managedDirs) {
      const baseAbs = path.join(this.root, dirRel);
      if (!fs.existsSync(baseAbs)) continue;
      this.sweepDir(baseAbs);
      if (!this.check) removeEmptyDirs(baseAbs);
    }
  }

  private sweepDir(dirAbs: string): void {
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        this.sweepDir(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = this.posixKey(path.relative(this.root, abs));
      if (this.emittedByPath.has(rel)) continue;
      if (this.check) {
        this.drift.push(`${rel} (orphan: no longer generated)`);
        continue;
      }
      fs.unlinkSync(abs);
      this.pruned.push(rel);
    }
  }
}

// Remove now-empty subdirectories left behind by pruning (keeps base itself).
function removeEmptyDirs(baseAbs: string): void {
  for (const entry of fs.readdirSync(baseAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(baseAbs, entry.name);
    removeEmptyDirs(abs);
    if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
  }
}
