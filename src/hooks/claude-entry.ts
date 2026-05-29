// src/hooks/claude-entry.ts
// Thin host entry for Claude Code + Codex (both speak the nested
// hookSpecificOutput wire shape). Compiles to scripts/hook-runtime.cjs at
// cutover — the path every Claude/Codex hook command already invokes:
//   node "${TRAFFIC_ONE_PLUGIN_ROOT:-…}/scripts/hook-runtime.cjs" <subcommand>
//
// Responsibilities: resolve argv→subcommand, detect host, discover module
// handlers (registry readdir), route the subcommand through the pipeline, and
// uphold the always-exit-0 contract with a SessionStart fail-closed fallback.

import { dispatchSubcommand } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { selectAdapter } from '../adapters/select';
import { authRequiredMessage } from '../shared/auth';
import { detectHost } from '../shared/host';

export interface HookOutput { stdout: string; exitCode: number; }

// Fail-closed SessionStart fallback: a crashed session-start must still surface
// the auth gate (fail toward "unverified") rather than emit nothing.
function sessionStartFallback(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: authRequiredMessage(env),
    },
  });
}

// Testable core: given a subcommand + raw stdin, produce the host stdout string.
// Never throws — upholds the always-exit-0 contract.
export async function runClaudeHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  if (!subcommand) return { stdout: '', exitCode: 0 };
  const host = detectHost(env, ['--host', subcommand]); // never cursor here
  const adapter = selectAdapter(host === 'codex' ? 'codex' : 'claude');
  try {
    const handlers = collectHandlers(loadModules(defaultModulesDir()));
    const stdout = await dispatchSubcommand(adapter, handlers, subcommand, { stdin, argv: [subcommand] });
    return { stdout, exitCode: 0 };
  } catch {
    if (subcommand === 'session-start') {
      return { stdout: sessionStartFallback(env), exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
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
    // No piped stdin (interactive/no input) — don't hang.
    if (stdin.isTTY) done();
  });
}

export async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const stdin = await readStdin();
  const { stdout } = await runClaudeHook(subcommand, stdin);
  if (stdout) process.stdout.write(stdout);
  process.exitCode = 0;
}

if (require.main === module) {
  void main();
}
