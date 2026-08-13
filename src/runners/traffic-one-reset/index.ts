// src/runners/traffic-one-reset/index.ts
// The CLI entry for `traffic-one-reset` — argv, project-root resolution, exit
// codes and streams. The transaction it calls lives in reset.ts.
//
// The split is not organisational. Resolving a project root is a filesystem
// WALK, and it belongs strictly outside the critical section it feeds: this
// file resolves once, here, and hands the result in, so the lock body derives
// no path of its own. reset.ts's header has the full argument (a second
// spelling entering a nested acquisition misses `heldLocks` and spins to the
// deadline) and shared/__tests__/path-spelling-contract.test.ts enforces it by
// import closure over every module that acquires the lock — which is why the
// resolver import lives in THIS file and must not move into that one.
//
// Nothing imports this module: it is a shim entry point (build-runtime.ts's
// SHIMS maps `traffic-one-reset.cjs` here), so it stays out of every lock
// body's closure by construction rather than by luck.

import { resolveProjectRoot } from '../../shared/hook/paths';
// The SAME id authority the doctor gate-exemption uses for `--run <id>`; see
// tool-classify.ts's resetCommandInvocation for why there is only one of these.
import { isDoctorIdArgument } from '../../shared/doctor-command';
import { resetRun } from './reset';

export type { ResetResult } from './reset';
export { resetRun } from './reset';

export interface ResetArgs {
  readonly runId: string;
  readonly json: boolean;
}

function usage(): string {
  return [
    'Usage: traffic-one-reset.cjs --run-id <id> [--json]',
    '',
    'Recovers a project wedged on a terminal `failed` run: retires it, releases its',
    'claims, and repoints currentRunId at a fresh planned run. The failed run keeps',
    'its ledger and its artifacts; only the pointer moves.',
  ].join('\n');
}

/**
 * Strict, and a SUPERSET of the gate grammar rather than a copy of it.
 *
 * tool-classify.ts admits exactly `node <script> --run-id <id>` — four words,
 * no options — so `--json` and `--help` are reachable only from a plain shell,
 * where no hook fires. That containment is the right direction: the gate stays
 * the narrower of the two, so nothing this parser accepts can widen what an
 * agent may emit.
 */
export function parseResetArgs(argv: readonly string[]): ResetArgs | null {
  let runId = '';
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--json') {
      if (json) return null;
      json = true;
      continue;
    }
    if (arg === '--run-id') {
      const value = String(argv[i + 1] ?? '').trim();
      if (runId || !isDoctorIdArgument(value)) return null;
      runId = value;
      i += 1;
      continue;
    }
    return null;
  }
  return runId ? { runId, json } : null;
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const args = parseResetArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  // Resolved HERE, before the call and therefore before the lock: the one
  // spelling settled at the entry is the only one the transaction ever sees.
  const projectRoot = resolveProjectRoot(cwd);
  const result = resetRun(projectRoot, args.runId);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.ok) {
    process.stdout.write(`traffic-one-reset: ${result.message}\n`);
    for (const warning of result.warnings) process.stderr.write(`traffic-one-reset: ${warning}\n`);
  } else {
    process.stderr.write(`traffic-one-reset: ${result.message}\n`);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
