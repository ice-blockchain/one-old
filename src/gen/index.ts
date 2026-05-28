// src/gen/index.ts
// Codegen entry (run via tsx: `npm run gen`, `npm run gen -- --check`). Emits
// the generated config/manifest/content layer from single sources onto the
// legacy root paths. --check compares against what's committed and exits 1 on
// drift, so CI fails when the committed output is stale.
//
// Currently wired: the 5 manifests + .mcp.json + the 3 hook configs
// (settings.json, hooks/hooks.json, hooks/hooks-cursor.json) + agents/ (from
// the agent content modules) + .cursor/rules. The AGENTS.md regions + the
// remaining content trees (skills, skills-templates, rules-templates) land here
// as their content modules + emitters are built.

import { pluginRoot } from '../shared/paths';
import { emitAgents } from './emit/agents';
import { emitCursorRules } from './emit/cursor-rules';
import { emitHooks } from './emit/hooks';
import { emitManifests, emitMcp } from './emit/manifests';
import { emitRules } from './emit/rules';
import { GenRun } from './lib/run';

export function runGen(opts: { check: boolean; root?: string }): GenRun {
  const run = new GenRun({ check: opts.check, root: opts.root ?? pluginRoot() });
  emitManifests(run);
  emitMcp(run);
  emitHooks(run);
  emitAgents(run); // before cursor-rules: the cursor mirror reads agents/
  emitRules(run); // before cursor-rules: slugForSource reads rules-templates/
  emitCursorRules(run);
  return run;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const check = argv.includes('--check');
  const run = runGen({ check });
  if (check) {
    if (run.drift.length > 0) {
      process.stderr.write(`gen --check: ${run.drift.length} generated artifact(s) out of sync:\n${run.drift.map((p) => `  - ${p}`).join('\n')}\n`);
      process.stderr.write('Run `npm run gen` and commit the result.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('gen --check: all generated artifacts are in sync.\n');
    return;
  }
  process.stdout.write(`gen: wrote ${run.written.length} file(s).\n`);
}

if (require.main === module) main();
