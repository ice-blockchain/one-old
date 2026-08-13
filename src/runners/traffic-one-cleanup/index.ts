// src/runners/traffic-one-cleanup/index.ts
// CLI wrapper for the conservative .traffic-one retention sweep.

import { retentionAdvisory, sweepTrafficOneRetention } from '../../shared/retention';
import { resolveProjectRoot } from '../../shared/hook/paths';

function usage(): string {
  return [
    'Usage: traffic-one-cleanup.cjs [--apply] [--dry-run] [--json] [--cwd <path>]',
    '',
    'Default is --dry-run. Use --apply to remove generated stale artifacts.',
  ].join('\n');
}

export function parseArgs(argv = process.argv.slice(2)): { cwd: string; dryRun: boolean; json: boolean; help: boolean } {
  let cwd = process.cwd();
  let dryRun = true;
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--apply') dryRun = false;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if (arg === '--cwd') {
      const next = argv[i + 1];
      if (next) {
        cwd = next;
        i += 1;
      }
    }
  }
  return { cwd, dryRun, json, help };
}

export function main(): number {
  const args = parseArgs();
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const result = sweepTrafficOneRetention(resolveProjectRoot(args.cwd), { dryRun: args.dryRun });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const mode = result.dryRun ? 'dry-run' : 'apply';
  process.stdout.write(`traffic-one cleanup ${mode}: ${result.actions.length} candidate(s), ${result.removed} removed\n`);
  for (const action of result.actions) {
    process.stdout.write(`- ${action.reason}: ${action.path}\n`);
  }
  // The count above is not the whole answer, and on its own it MISREADS: a
  // project whose `.one.json` will not parse has every run-history cap suspended,
  // so the sweep plans nothing and this line says "0 candidate(s), 0 removed" —
  // a clean bill of health for a directory that is growing without bound. The
  // notices carry the file, the reason and the remedy. They were printed under
  // `--json` only, which is the mode a human is least likely to be reading.
  const advisory = retentionAdvisory(result.notices);
  if (advisory) process.stdout.write(advisory);
  return 0;
}

if (require.main === module) process.exitCode = main();
