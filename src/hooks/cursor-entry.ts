// src/hooks/cursor-entry.ts
// Thin host entry for Cursor. Compiles to scripts/cursor-hook-runtime.cjs at
// cutover — the path Cursor's hooks-cursor.json already invokes:
//   node ./scripts/cursor-hook-runtime.cjs <subcommand>
//
// Cursor exposes COARSE events (one hook per event), so unlike the Claude entry
// (which routes its fine-grained subcommands to specific handlers), this runs
// the full pipeline: the cursor adapter maps the subcommand → canonical
// (event, tool class), and runPipeline fans out to every handler that matches —
// the coarse-event fan-out the legacy mergeCursorOutputs did by hand. Merged
// context becomes one Cursor output, so there is no double-emit to guard.

import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { makeCursorAdapter } from '../adapters/cursor';
import { authRequiredMessage } from '../shared/auth';

export interface HookOutput { stdout: string; exitCode: number; }

// Cursor's empty/no-op output is the empty JSON object (not an empty string).
const CURSOR_NOOP = '{}';

function sessionStartFallback(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({ additional_context: authRequiredMessage(env) });
}

export async function runCursorHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  if (!subcommand) return { stdout: CURSOR_NOOP, exitCode: 0 };
  const adapter = makeCursorAdapter();
  try {
    const handlers = collectHandlers(loadModules(defaultModulesDir()));
    const stdout = await dispatch(adapter, handlers, { stdin, argv: [subcommand] });
    return { stdout: stdout || CURSOR_NOOP, exitCode: 0 };
  } catch {
    if (subcommand === 'session-start') {
      return { stdout: sessionStartFallback(env), exitCode: 0 };
    }
    return { stdout: CURSOR_NOOP, exitCode: 0 };
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stdin = process.stdin;
    let settled = false;
    const done = (): void => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    stdin.on('end', done);
    stdin.on('error', done);
    if (stdin.isTTY) done();
  });
}

export async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const stdin = await readStdin();
  const { stdout } = await runCursorHook(subcommand, stdin);
  process.stdout.write(stdout);
  process.exitCode = 0;
}

if (require.main === module) {
  void main();
}
