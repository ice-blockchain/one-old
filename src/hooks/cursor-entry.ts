// src/hooks/cursor-entry.ts
// Thin host entry for Cursor. Compiles to scripts/cursor-hook-runtime.cjs at
// cutover — the path Cursor's hooks-cursor.json already invokes:
//   node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-hook-runtime.cjs" <subcommand>
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
import { authFallbackMessage, hookFallbackStandsDown } from './auth-fallback';
import { cursorPreToolDeny, hasValidPreToolPayload, isCursorPreToolSubcommand } from './fail-closed';
import { asRecord, firstString } from '../adapters/coerce';
import { parseJson } from '../shared/fsjson';
import { canonicalOneMcpServerHint, isManagedOneMcpPair, ONE_MCP_AGENT_TOOL_DENY_REASON } from '../shared/one-mcp-agent-tools';

export interface HookOutput { stdout: string; exitCode: number; }

// Cursor's empty/no-op output is the empty JSON object (not an empty string).
const CURSOR_NOOP = '{}';

function sessionStartFallback(message: string): string {
  return JSON.stringify({ additional_context: message });
}

function isManagedCursorMcpInvocation(stdin: string): boolean {
  const data = asRecord(parseJson<Record<string, unknown>>(stdin, {}));
  return isManagedOneMcpPair(
    canonicalOneMcpServerHint(firstString(data.mcp_server_name, data.mcpServerName, data.server_name, data.serverName, data.server, data.command, data.url)),
    firstString(data.mcp_tool_name, data.mcpToolName, data.tool_name, data.toolName, data.name),
  );
}

export async function runCursorHook(
  subcommand: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HookOutput> {
  if (!subcommand) return { stdout: CURSOR_NOOP, exitCode: 0 };
  if (isCursorPreToolSubcommand(subcommand) && !hasValidPreToolPayload(stdin, subcommand, 'cursor')) {
    return { stdout: cursorPreToolDeny(), exitCode: 0 };
  }
  if (subcommand === 'before-mcp-execution' && isManagedCursorMcpInvocation(stdin)) {
    return { stdout: cursorPreToolDeny(ONE_MCP_AGENT_TOOL_DENY_REASON), exitCode: 0 };
  }
  try {
    const adapter = makeCursorAdapter();
    const handlers = collectHandlers(loadModules(defaultModulesDir(), { strict: true }));
    const stdout = await dispatch(adapter, handlers, { stdin, argv: [subcommand] });
    return { stdout: stdout || CURSOR_NOOP, exitCode: 0 };
  } catch {
    if (hookFallbackStandsDown(stdin, env)) return { stdout: CURSOR_NOOP, exitCode: 0 };
    if (subcommand === 'session-start') {
      const message = authFallbackMessage(stdin, env);
      return { stdout: message ? sessionStartFallback(message) : CURSOR_NOOP, exitCode: 0 };
    }
    if (isCursorPreToolSubcommand(subcommand)) {
      return { stdout: cursorPreToolDeny(), exitCode: 0 };
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
