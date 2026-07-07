// src/hooks/copilot-entry.ts
// Thin host entry for GitHub Copilot CLI + VS Code Copilot. Compiles to
// scripts/copilot-hook-runtime.cjs — invoked from hooks/hooks-copilot.json.

import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { detectCopilotWireSurface, makeCopilotAdapter } from '../adapters/copilot';
import { authRequiredMessage } from '../shared/auth';

export interface HookOutput { stdout: string; exitCode: number; }

const COPILOT_NOOP_CLI = '';
const COPILOT_NOOP_VSCODE = '{}';

function sessionStartFallback(env: NodeJS.ProcessEnv, surface: ReturnType<typeof detectCopilotWireSurface>): string {
  const msg = authRequiredMessage(env);
  if (surface === 'cli') {
    return JSON.stringify({ additionalContext: msg });
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
  });
}

function subcommandFromArgs(args: readonly string[]): string | undefined {
  return args.find((arg) => typeof arg === 'string' && arg.length > 0 && !arg.startsWith('--'));
}

export async function runCopilotHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  if (!subcommand) {
    const surface = detectCopilotWireSurface(env);
    return { stdout: surface === 'vscode' ? COPILOT_NOOP_VSCODE : COPILOT_NOOP_CLI, exitCode: 0 };
  }
  let parsedRaw: unknown = {};
  try { parsedRaw = JSON.parse(stdin); } catch { /* empty stdin */ }
  const surface = detectCopilotWireSurface(env, parsedRaw);
  const adapter = makeCopilotAdapter(surface);
  const noop = surface === 'vscode' ? COPILOT_NOOP_VSCODE : COPILOT_NOOP_CLI;
  try {
    const handlers = collectHandlers(loadModules(defaultModulesDir()));
    const stdout = await dispatch(adapter, handlers, { stdin, argv: [subcommand] });
    return { stdout: stdout || noop, exitCode: 0 };
  } catch {
    if (subcommand === 'session-start') {
      return { stdout: sessionStartFallback(env, surface), exitCode: 0 };
    }
    return { stdout: noop, exitCode: 0 };
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
  const subcommand = subcommandFromArgs(process.argv.slice(2));
  const stdin = await readStdin();
  const { stdout } = await runCopilotHook(subcommand, stdin);
  if (stdout) process.stdout.write(stdout);
  process.exitCode = 0;
}

if (require.main === module) {
  void main();
}
