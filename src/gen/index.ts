// src/gen/index.ts
// Codegen entry (run via tsx: `npm run gen`, `npm run gen -- --check`). Emits
// the generated config/manifest/content layer from single sources into dist/,
// which is the generated plugin root. --check compares against dist and exits
// 1 on drift.
//
// Currently wired: the host manifests + .mcp.json + hook configs + agents/ +
// rules/ + skills-catalog/ + .cursor/rules + static plugin-root docs.

import * as path from 'path';
import * as fs from 'fs';

import { emitAgents } from './emit/agents';
import { emitCursorRules } from './emit/cursor-rules';
import { emitHooks } from './emit/hooks';
import { emitManifests, emitMcp } from './emit/manifests';
import { emitRules } from './emit/rules';
import { emitSkills } from './emit/skills';
import { emitStaticPluginFiles } from './emit/static';
import { GenRun } from './lib/run';

export function sourceRepoRoot(): string {
  // Codegen is authoring tooling, not installed runtime code. Runtime hooks must
  // honor *_PLUGIN_ROOT env vars, but `npm run gen` should always read the source
  // checkout even when a maintainer shell inherited TRAFFIC_ONE_PLUGIN_ROOT=dist.
  const candidates = [
    process.env.TRAFFIC_ONE_SOURCE_ROOT,
    process.cwd(),
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (fs.existsSync(path.join(root, 'src', 'gen', 'static', 'plugin-instructions.md'))
      && fs.existsSync(path.join(root, 'package.json'))) {
      return root;
    }
  }
  return path.resolve(__dirname, '..', '..');
}

export function distRoot(sourceRoot: string = sourceRepoRoot()): string {
  return path.join(sourceRoot, 'dist');
}

// Output dirs gen owns end-to-end: files inside them that no emitter produced
// are stale copies of deleted source content and get swept. skills/ stays out —
// the session-start surgery populates it at runtime.
export const MANAGED_OUTPUT_DIRS = ['agents', 'rules', 'skills-catalog', path.join('.cursor', 'rules')] as const;

export function runGen(opts: { check: boolean; root?: string; sourceRoot?: string }): GenRun {
  const sourceRoot = opts.sourceRoot ?? sourceRepoRoot();
  const run = new GenRun({ check: opts.check, root: opts.root ?? distRoot(sourceRoot), sourceRoot });
  emitManifests(run);
  emitMcp(run);
  emitHooks(run);
  emitAgents(run); // before cursor-rules: the cursor mirror derives from emitted agents/
  emitRules(run); // before cursor-rules: the cursor mirror derives from emitted rules/
  emitSkills(run);
  emitCursorRules(run);
  emitStaticPluginFiles(run);
  run.sweepOrphans(MANAGED_OUTPUT_DIRS);
  return run;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const check = argv.includes('--check');
  const run = runGen({ check });
  if (check) {
    if (run.drift.length > 0) {
      process.stderr.write(`gen --check: ${run.drift.length} generated artifact(s) out of sync in dist:\n${run.drift.map((p) => `  - ${p}`).join('\n')}\n`);
      process.stderr.write('Run `npm run gen` to refresh dist.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('gen --check: all generated dist artifacts are in sync.\n');
    return;
  }
  const prunedNote = run.pruned.length > 0 ? `, pruned ${run.pruned.length} orphan(s)` : '';
  process.stdout.write(`gen: wrote ${run.written.length} file(s) to dist${prunedNote}.\n`);
}

if (require.main === module) main();
