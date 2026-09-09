// src/runners/traffic-one-workspace/index.ts
// The CLI entry for `traffic-one-workspace` — argv, project-root resolution,
// exit codes and streams. The conversion it calls lives in
// shared/state/workspace-convert.ts.
//
// Resolving a project root is a filesystem walk and belongs strictly outside
// the lock: this file resolves once and hands the identifier in, so the lock
// body derives no path of its own.

import { resolveProjectRoot } from '../../shared/hook/paths';
import { convertToContainer } from '../../shared/state/workspace-convert';

export interface WorkspaceArgs {
  readonly convertToContainer: true;
  readonly yes: boolean;
  readonly json: boolean;
  readonly cwd: string;
}

function usage(): string {
  return [
    'Usage: traffic-one-workspace.cjs --convert-to-container [--yes] [--json] [--cwd <path>]',
    '',
    'Turn this directory into a Traffic One workspace container. Allowed when the',
    'root has no plan and no runs. With --yes, existing plan/runs/digests move to',
    '.traffic-one/.converted-<ts>/ first.',
  ].join('\n');
}

export function parseWorkspaceArgs(
  argv: readonly string[],
  cwd: string = process.cwd(),
): WorkspaceArgs | null {
  let convert = false;
  let yes = false;
  let json = false;
  let sawCwd = false;
  let resolvedCwd = cwd;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--convert-to-container') {
      if (convert) return null;
      convert = true;
      continue;
    }
    if (arg === '--yes') {
      if (yes) return null;
      yes = true;
      continue;
    }
    if (arg === '--json') {
      if (json) return null;
      json = true;
      continue;
    }
    if (arg === '--cwd') {
      const value = String(argv[i + 1] ?? '').trim();
      if (sawCwd || !value) return null;
      sawCwd = true;
      resolvedCwd = value;
      i += 1;
      continue;
    }
    return null;
  }
  return convert ? { convertToContainer: true, yes, json, cwd: resolvedCwd } : null;
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const args = parseWorkspaceArgs(argv, cwd);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  cwd = args.cwd;
  const projectRoot = resolveProjectRoot(cwd);
  const result = convertToContainer(projectRoot, { yes: args.yes });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.outcome === 'converted' || result.outcome === 'already') {
    process.stdout.write(`traffic-one-workspace: ${result.message}\n`);
  } else {
    process.stderr.write(`traffic-one-workspace: ${result.message}\n`);
  }
  return result.outcome === 'converted' || result.outcome === 'already' ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
