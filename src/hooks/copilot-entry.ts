// src/hooks/copilot-entry.ts
// Thin host entry for GitHub Copilot CLI + VS Code Copilot. Compiles to
// scripts/copilot-hook-runtime.cjs — invoked from hooks/hooks-copilot.json.

import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { detectCopilotWireSurface, makeCopilotAdapter, resolveCopilotSubcommand } from '../adapters/copilot';
import { authFallbackMessage, safeHookFallbackStandsDown } from './auth-fallback';
import { guardedMain } from './entry-guard';
import { copilotPreToolDeny, hasValidPreToolPayload, safeFailClosedRecoveryExemption } from './fail-closed';
import { asRecord, firstString } from '../adapters/coerce';
import { isManagedOneMcpAgentTool, ONE_MCP_AGENT_TOOL_DENY_REASON } from '../shared/one-mcp/agent-tools';

export interface HookOutput { stdout: string; exitCode: number; }

const COPILOT_NOOP_CLI = '';
const COPILOT_NOOP_VSCODE = '{}';

function sessionStartFallback(msg: string, surface: ReturnType<typeof detectCopilotWireSurface>): string {
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

function isManagedCopilotMcpInvocation(raw: unknown): boolean {
  const data = asRecord(raw);
  const names = [firstString(data.tool_name, data.toolName, data.name)];
  const calls = data.tool_calls ?? data.toolCalls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      const rec = asRecord(call);
      names.push(firstString(rec.name, rec.tool_name, rec.toolName));
    }
  }
  return names.some((name) => isManagedOneMcpAgentTool('copilot', name));
}

export async function runCopilotHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  let parsedRaw: unknown = {};
  try { parsedRaw = JSON.parse(stdin); } catch { /* empty stdin */ }
  const argv = subcommand ? [subcommand] : [];
  const resolved = resolveCopilotSubcommand(argv, parsedRaw);
  const surface = detectCopilotWireSurface(env, parsedRaw, argv);
  const noop = surface === 'vscode' ? COPILOT_NOOP_VSCODE : COPILOT_NOOP_CLI;
  if (!resolved) {
    return { stdout: noop, exitCode: 0 };
  }
  const inputValid = resolved === 'before-tool-use'
    ? hasValidPreToolPayload(stdin, resolved, 'copilot')
    : true;
  if (resolved === 'before-tool-use' && !inputValid && !safeFailClosedRecoveryExemption(stdin, resolved, 'copilot')) {
    return { stdout: copilotPreToolDeny(surface), exitCode: 0 };
  }
  if (resolved === 'before-tool-use' && isManagedCopilotMcpInvocation(parsedRaw)) {
    return { stdout: copilotPreToolDeny(surface, ONE_MCP_AGENT_TOOL_DENY_REASON), exitCode: 0 };
  }
  try {
    const adapter = makeCopilotAdapter(surface);
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const stdout = await dispatch(adapter, handlers, { stdin, argv: [resolved] });
    return { stdout: stdout || noop, exitCode: 0 };
  } catch {
    if (safeHookFallbackStandsDown(stdin, env)) return { stdout: noop, exitCode: 0 };
    if (resolved === 'session-start') {
      const message = authFallbackMessage(stdin, env);
      return { stdout: message ? sessionStartFallback(message, surface) : noop, exitCode: 0 };
    }
    if (resolved === 'before-tool-use') {
      if (safeFailClosedRecoveryExemption(stdin, resolved, 'copilot')) return { stdout: noop, exitCode: 0 };
      return { stdout: copilotPreToolDeny(surface), exitCode: 0 };
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

function copilotNoop(env: NodeJS.ProcessEnv = process.env, raw: unknown = {}, argv: readonly string[] = []): string {
  return detectCopilotWireSurface(env, raw, argv) === 'vscode' ? COPILOT_NOOP_VSCODE : COPILOT_NOOP_CLI;
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const argvSubcommand = subcommandFromArgs(argv);
  let parsedRaw: unknown = {};
  let resolved = resolveCopilotSubcommand(argv, parsedRaw);
  try {
    const stdin = await readStdin();
    try { parsedRaw = JSON.parse(stdin); } catch { /* empty stdin */ }
    resolved = resolveCopilotSubcommand(argv, parsedRaw);
    const surface = detectCopilotWireSurface(process.env, parsedRaw, argv);
    const noop = surface === 'vscode' ? COPILOT_NOOP_VSCODE : COPILOT_NOOP_CLI;
    const out = await guardedMain({
      subcommand: resolved,
      stdin,
      isPreTool: resolved === 'before-tool-use',
      surface: 'copilot',
      deny: { stdout: copilotPreToolDeny(surface), exitCode: 0 },
      noop: { stdout: noop, exitCode: 0 },
      // Pass the argv token, not `resolved`: runCopilotHook feeds argv to
      // detectCopilotWireSurface, and a known subcommand would force CLI.
      run: () => runCopilotHook(argvSubcommand, stdin),
    });
    if (out.stdout) process.stdout.write(out.stdout);
    process.exitCode = 0;
  } catch {
    try {
      const fallback = resolved === 'before-tool-use'
        ? copilotPreToolDeny(detectCopilotWireSurface(process.env, parsedRaw, argv))
        : copilotNoop(process.env, parsedRaw, argv);
      if (fallback) process.stdout.write(fallback);
    } catch { /* last-ditch write must not reject */ }
    process.exitCode = 0;
  }
}

if (require.main === module) {
  void main().catch(() => {
    try {
      const argv = process.argv.slice(2);
      const resolved = resolveCopilotSubcommand(argv, {});
      const fallback = resolved === 'before-tool-use'
        ? copilotPreToolDeny(detectCopilotWireSurface(process.env, {}, argv))
        : copilotNoop(process.env, {}, argv);
      if (fallback) process.stdout.write(fallback);
    } catch { /* */ }
    process.exitCode = 0;
  });
}
