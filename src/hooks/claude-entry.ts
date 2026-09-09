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
import { authFallbackMessage, safeHookFallbackStandsDown } from './auth-fallback';
import { guardedMain } from './entry-guard';
import { hasValidPreToolPayload, isGatePreToolSubcommand, nestedPreToolDeny, safeFailClosedRecoveryExemption } from './fail-closed';
import { ONE_MCP_AGENT_TOOL_DENY_REASON } from '../shared/one-mcp/agent-tools';
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
  // detectHost reads env. A throw here used to escape the never-throw contract
  // (hostile/unreadable env) and skip the catch's fail-closed deny.
  let host: ReturnType<typeof detectHost> = 'claude';
  try {
    host = detectHost(env, ['--host', subcommand]); // never cursor here
    if (isGatePreToolSubcommand(subcommand)
      && !hasValidPreToolPayload(stdin, subcommand, 'nested')
      && !safeFailClosedRecoveryExemption(stdin, subcommand, 'nested')) {
      return { stdout: nestedPreToolDeny(host === 'codex' ? 'Codex' : 'Claude'), exitCode: 0 };
    }
    // This subcommand is wired only to the exact managed MCP matcher. Deny before
    // module loading so pluginUse opt-out or a damaged runtime cannot reopen it.
    if (subcommand === 'check-one-mcp-tool') {
      return { stdout: nestedPreToolDeny(host === 'codex' ? 'Codex' : 'Claude', ONE_MCP_AGENT_TOOL_DENY_REASON), exitCode: 0 };
    }
    const adapter = selectAdapter(host === 'codex' ? 'codex' : 'claude');
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const stdout = await dispatchSubcommand(adapter, handlers, subcommand, { stdin, argv: [subcommand] });
    return { stdout, exitCode: 0 };
  } catch {
    if (safeHookFallbackStandsDown(stdin, env)) return { stdout: '', exitCode: 0 };
    if (subcommand === 'session-start') {
      const message = authFallbackMessage(stdin, env);
      return { stdout: message ? sessionStartFallback(message, host) : '', exitCode: 0 };
    }
    if (isGatePreToolSubcommand(subcommand)) {
      // The runtime just threw — module discovery, the pipeline, or state I/O
      // is damaged, exactly the case PRE_TOOL_REMEDIATION tells the user to
      // run doctor for. Recognize that exact recovery command here so it is
      // not itself denied by the failure it is meant to diagnose.
      if (safeFailClosedRecoveryExemption(stdin, subcommand, 'nested')) return { stdout: '', exitCode: 0 };
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

function claudePreToolDeny(subcommand: string | undefined): string {
  const host = detectHost(process.env, subcommand === undefined ? [] : ['--host', subcommand]);
  return nestedPreToolDeny(host === 'codex' ? 'Codex' : 'Claude');
}

export async function main(): Promise<void> {
  const subcommand = process.argv[2];
  try {
    const stdin = await readStdin();
    const out = await guardedMain({
      subcommand,
      stdin,
      isPreTool: isGatePreToolSubcommand(subcommand),
      surface: 'nested',
      deny: { stdout: claudePreToolDeny(subcommand), exitCode: 0 },
      noop: { stdout: '', exitCode: 0 },
      run: () => runClaudeHook(subcommand, stdin),
    });
    if (out.stdout) process.stdout.write(out.stdout);
    process.exitCode = 0;
  } catch {
    try {
      if (isGatePreToolSubcommand(subcommand)) process.stdout.write(claudePreToolDeny(subcommand));
    } catch { /* last-ditch write must not reject */ }
    process.exitCode = 0;
  }
}

if (require.main === module) {
  void main().catch(() => {
    try {
      if (isGatePreToolSubcommand(process.argv[2])) process.stdout.write(claudePreToolDeny(process.argv[2]));
    } catch { /* */ }
    process.exitCode = 0;
  });
}
