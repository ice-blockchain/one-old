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
import { detectHost } from '../shared/host';
import { authFallbackMessage, hookFallbackStandsDown } from './auth-fallback';
import { hasValidPreToolPayload, isGatePreToolSubcommand, nestedPreToolDeny } from './fail-closed';
import { ONE_MCP_AGENT_TOOL_DENY_REASON } from '../shared/one-mcp-agent-tools';
import { markCodexHookContext } from '../shared/codex-hook-evidence';

export interface HookOutput { stdout: string; exitCode: number; }

// Fail-closed SessionStart fallback: a crashed session-start must still surface
// the auth gate (fail toward "unverified") rather than emit nothing.
function sessionStartFallback(message: string, host: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: host === 'codex' ? markCodexHookContext('SessionStart', message) : message,
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
  if (isGatePreToolSubcommand(subcommand) && !hasValidPreToolPayload(stdin, subcommand, 'nested')) {
    return { stdout: nestedPreToolDeny(host === 'codex' ? 'Codex' : 'Claude'), exitCode: 0 };
  }
  // This subcommand is wired only to the exact managed MCP matcher. Deny before
  // module loading so pluginUse opt-out or a damaged runtime cannot reopen it.
  if (subcommand === 'check-one-mcp-tool') {
    return { stdout: nestedPreToolDeny(host === 'codex' ? 'Codex' : 'Claude', ONE_MCP_AGENT_TOOL_DENY_REASON), exitCode: 0 };
  }
  try {
    const adapter = selectAdapter(host === 'codex' ? 'codex' : 'claude');
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const stdout = await dispatchSubcommand(adapter, handlers, subcommand, { stdin, argv: [subcommand] });
    return { stdout, exitCode: 0 };
  } catch {
    if (hookFallbackStandsDown(stdin, env)) return { stdout: '', exitCode: 0 };
    if (subcommand === 'session-start') {
      const message = authFallbackMessage(stdin, env);
      return { stdout: message ? sessionStartFallback(message, host) : '', exitCode: 0 };
    }
    if (isGatePreToolSubcommand(subcommand)) {
      return { stdout: nestedPreToolDeny(host === 'codex' ? 'Codex' : 'Claude'), exitCode: 0 };
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
