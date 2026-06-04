// src/gen/index.ts
// Codegen entry (run via tsx: `npm run gen`, `npm run gen -- --check`). Emits
// the generated config/manifest/content layer from single sources into dist/,
// which is the generated plugin root. --check compares against dist and exits
// 1 on drift.
//
// Currently wired: the host manifests + .mcp.json + hook configs + agents/ +
// rules/ + skills-catalog/ + .cursor/rules + static plugin-root docs.

import * as path from 'path';

import { pluginRoot } from '../shared/paths';
import { emitAgents } from './emit/agents';
import { emitCursorRules } from './emit/cursor-rules';
import { emitHooks } from './emit/hooks';
import { emitManifests, emitMcp } from './emit/manifests';
import { emitRules } from './emit/rules';
import { emitSkills } from './emit/skills';
import { emitStaticPluginFiles } from './emit/static';
import { GenRun } from './lib/run';

export function distRoot(sourceRoot: string = pluginRoot()): string {
  return path.join(sourceRoot, 'dist');
}

export function runGen(opts: { check: boolean; root?: string; sourceRoot?: string }): GenRun {
  const sourceRoot = opts.sourceRoot ?? pluginRoot();
  const run = new GenRun({ check: opts.check, root: opts.root ?? distRoot(sourceRoot), sourceRoot });
  emitManifests(run);
  emitMcp(run);
  emitHooks(run);
  emitAgents(run); // before cursor-rules: the cursor mirror reads agents/
  emitRules(run); // before cursor-rules: slugForSource reads rules/
  emitSkills(run);
  emitCursorRules(run);
  emitStaticPluginFiles(run);
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
  process.stdout.write(`gen: wrote ${run.written.length} file(s) to dist.\n`);
}

if (require.main === module) main();
