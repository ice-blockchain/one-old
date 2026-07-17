// src/hooks/copilot-entry.ts
// Thin host entry for GitHub Copilot CLI + VS Code Copilot. Compiles to
// scripts/copilot-hook-runtime.cjs — invoked from hooks/hooks-copilot.json.

import { dispatch } from '../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../core/registry';
import { detectCopilotWireSurface, makeCopilotAdapter } from '../adapters/copilot';
import { authFallbackMessage, hookFallbackStandsDown } from './auth-fallback';
import { copilotPreToolDeny, hasValidHookObjectPayload } from './fail-closed';
import { asRecord, firstString } from '../adapters/coerce';
import { isManagedOneMcpAgentTool, ONE_MCP_AGENT_TOOL_DENY_REASON } from '../shared/one-mcp-agent-tools';

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
  if (!subcommand) {
    const surface = detectCopilotWireSurface(env);
    return { stdout: surface === 'vscode' ? COPILOT_NOOP_VSCODE : COPILOT_NOOP_CLI, exitCode: 0 };
  }
  const inputValid = hasValidHookObjectPayload(stdin);
  let parsedRaw: unknown = {};
  try { parsedRaw = JSON.parse(stdin); } catch { /* empty stdin */ }
  const surface = detectCopilotWireSurface(env, parsedRaw);
  const noop = surface === 'vscode' ? COPILOT_NOOP_VSCODE : COPILOT_NOOP_CLI;
  if (subcommand === 'before-tool-use' && !inputValid) {
    return { stdout: copilotPreToolDeny(surface), exitCode: 0 };
  }
  if (subcommand === 'before-tool-use' && isManagedCopilotMcpInvocation(parsedRaw)) {
    return { stdout: copilotPreToolDeny(surface, ONE_MCP_AGENT_TOOL_DENY_REASON), exitCode: 0 };
  }
  try {
    const adapter = makeCopilotAdapter(surface);
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const stdout = await dispatch(adapter, handlers, { stdin, argv: [subcommand] });
    return { stdout: stdout || noop, exitCode: 0 };
  } catch {
    if (hookFallbackStandsDown(stdin, env)) return { stdout: noop, exitCode: 0 };
    if (subcommand === 'session-start') {
      const message = authFallbackMessage(stdin, env);
      return { stdout: message ? sessionStartFallback(message, surface) : noop, exitCode: 0 };
    }
    if (subcommand === 'before-tool-use') {
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
