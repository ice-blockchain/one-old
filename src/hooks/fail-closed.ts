// Last-resort host-wire fallbacks. runPipeline protects failures thrown by a
// handler, while these helpers protect the wider boundary: module discovery,
// adapter parsing, context construction, and serialization. A pre-tool hook must
// never become an empty success merely because the plugin runtime is damaged.

import { codexHookEvidenceMarker } from '../shared/codex-hook-evidence';

// Shared remediation sentence — interpolated into every fail-closed deny,
// including generated host wrappers (kilo-host), so the prose can't drift.
export const PRE_TOOL_REMEDIATION = 'Run Traffic One doctor or reinstall/update the plugin, then retry.';

// Host hook payloads are required to be JSON objects. The shared adapters use a
// permissive parser for lifecycle compatibility, so validate at the entry
// boundary before a pre-tool dispatch: otherwise malformed/truncated stdin is
// normalized to `{}` and silently becomes an allow.
export function hasValidHookObjectPayload(stdin: string): boolean {
  try {
    const parsed = JSON.parse(stdin);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

type HookRecord = Record<string, unknown>;
type PreToolPayloadSurface = 'nested' | 'wrapper' | 'cursor' | 'copilot' | 'windsurf';

function hookRecord(stdin: string): HookRecord | null {
  try {
    const parsed = JSON.parse(stdin) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as HookRecord
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): HookRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as HookRecord
    : {};
}

function firstText(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function hasOwnValue(value: HookRecord, ...keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key)
    && value[key] !== undefined
    && value[key] !== null);
}

function workspaceIdentity(data: HookRecord): string {
  const input = record(data.input);
  const session = record(data.session);
  const workspace = record(data.workspace);
  const info = record(data.tool_info ?? data.toolInfo);
  const direct = firstText(
    data.cwd, data.projectRoot, data.workspaceRoot, data.workspace_root, data.root,
    data.workdir, data.workingDir,
    input.cwd, input.projectRoot, input.workspaceRoot,
    session.cwd, session.root,
    workspace.root, workspace.path,
    info.cwd, info.working_directory, info.workingDirectory,
    // Cascade file hooks may omit cwd and identify the project only through an
    // absolute file target; its adapter intentionally derives cwd from this.
    data.file_path, data.filePath, data.path, data.uri,
    info.file_path, info.filePath, info.path, info.uri,
  );
  if (direct) return direct;
  const roots = data.workspace_roots ?? data.workspaceRoots ?? data.workspaceFolders;
  const values = Array.isArray(roots) ? roots : (roots == null ? [] : [roots]);
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    const item = record(value);
    const path = firstText(item.path, item.uri, item.fsPath);
    if (path) return path;
  }
  return '';
}

function genericToolName(data: HookRecord): string {
  const tool = record(data.tool);
  const output = record(data.output);
  const outputArgs = record(output.args);
  const input = record(
    data.tool_input
      ?? data.toolInput
      ?? output.args
      ?? data.input
      ?? data.args
      ?? data.arguments
      ?? tool.input
      ?? tool.args
      ?? tool.arguments,
  );
  return firstText(
    data.tool_name, data.toolName, data.toolNameRaw, data.name,
    typeof data.tool === 'string' ? data.tool : undefined,
    tool.name, tool.id, tool.tool, tool.type,
    input.tool_name, input.toolName, input.name, input.tool,
    outputArgs.tool_name, outputArgs.toolName, outputArgs.name,
  );
}

function genericToolInputPresent(data: HookRecord): boolean {
  const tool = record(data.tool);
  const output = record(data.output);
  return hasOwnValue(data, 'tool_input', 'toolInput', 'input', 'args', 'arguments')
    || hasOwnValue(output, 'args')
    || hasOwnValue(tool, 'input', 'args', 'arguments');
}

function commandText(data: HookRecord): string {
  const input = record(data.input ?? data.tool_input ?? data.toolInput);
  const info = record(data.tool_info ?? data.toolInfo);
  return firstText(
    data.command, data.cmd, data.shell_command, data.shellCommand,
    input.command, input.cmd,
    info.command_line, info.commandLine, info.command, info.cmd,
  );
}

function filePathText(data: HookRecord): string {
  const input = record(data.input ?? data.tool_input ?? data.toolInput);
  const info = record(data.tool_info ?? data.toolInfo);
  const document = record(data.document);
  return firstText(
    data.file_path, data.filePath, data.path, data.uri,
    input.file_path, input.filePath, input.path, input.uri,
    info.file_path, info.filePath, info.path, info.uri,
    document.path, document.uri,
  );
}

// Syntax alone is insufficient at a blocking boundary: `{ "cwd": "..." }`
// is valid JSON but gives the adapter no tool to classify, which becomes a
// silent allow. Validate the minimum fields each host/subcommand needs while
// leaving lifecycle and post-tool payloads on their existing fail-open path.
export function hasValidPreToolPayload(
  stdin: string,
  subcommand: string | undefined,
  surface: PreToolPayloadSurface,
): boolean {
  const data = hookRecord(stdin);
  if (!data || !workspaceIdentity(data)) return false;
  const sub = String(subcommand || '');

  if (surface === 'nested') {
    return Boolean(firstText(data.tool_name, data.toolName))
      && hasOwnValue(data, 'tool_input', 'toolInput');
  }
  if (surface === 'wrapper') {
    return Boolean(genericToolName(data)) && genericToolInputPresent(data);
  }
  if (surface === 'copilot') {
    const calls = data.tool_calls ?? data.toolCalls;
    const callHasTool = Array.isArray(calls) && calls.some((value) => {
      const call = record(value);
      return Boolean(firstText(call.name, call.tool_name, call.toolName))
        && hasOwnValue(call, 'args', 'arguments', 'input');
    });
    return callHasTool || (Boolean(genericToolName(data))
      && hasOwnValue(data, 'tool_args', 'toolArgs', 'tool_input', 'toolInput', 'input', 'args', 'arguments'));
  }
  if (surface === 'cursor') {
    if (sub === 'before-shell-execution') return Boolean(commandText(data));
    if (sub === 'before-read-file') return Boolean(filePathText(data));
    if (sub === 'before-mcp-execution') {
      const server = firstText(
        data.mcp_server_name, data.mcpServerName, data.server_name, data.serverName,
        data.server, data.command, data.url,
      );
      const tool = firstText(data.mcp_tool_name, data.mcpToolName, data.tool_name, data.toolName, data.name);
      return Boolean(server && tool);
    }
    return Boolean(genericToolName(data)) && genericToolInputPresent(data);
  }

  const info = record(data.tool_info ?? data.toolInfo ?? data.input);
  if (sub === 'pre_run_command') return Boolean(commandText(data));
  if (sub === 'pre_read_code' || sub === 'pre_write_code') return Boolean(filePathText(data));
  if (sub === 'pre_mcp_tool_use') {
    return Boolean(firstText(info.mcp_server_name, info.mcpServerName)
      && firstText(info.mcp_tool_name, info.mcpToolName));
  }
  return false;
}

export function preToolFailureReason(host: string): string {
  return `Traffic One ${host} pre-tool gate failed before it could make a decision, so this tool call is blocked fail-closed. ${PRE_TOOL_REMEDIATION}`;
}

export function isGatePreToolSubcommand(subcommand: string | undefined): boolean {
  const value = String(subcommand || '');
  return value.startsWith('check-') || value === 'pre-graphify-hint';
}

export function isCursorPreToolSubcommand(subcommand: string | undefined): boolean {
  return new Set(['before-shell-execution', 'before-read-file', 'before-mcp-execution', 'before-tool-use']).has(String(subcommand || ''));
}

export function isWindsurfPreToolAction(action: string | undefined): boolean {
  return new Set(['pre_read_code', 'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use']).has(String(action || ''));
}

export function nestedPreToolDeny(host: string, reason: string = preToolFailureReason(host)): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      ...(host.trim().toLowerCase() === 'codex'
        ? { additionalContext: codexHookEvidenceMarker('PreToolUse') }
        : {}),
    },
  });
}

export function cursorPreToolDeny(reason: string = preToolFailureReason('Cursor')): string {
  return JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason });
}

export function copilotPreToolDeny(surface: 'cli' | 'vscode', reason: string = preToolFailureReason('Copilot')): string {
  return surface === 'cli'
    ? JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })
    : nestedPreToolDeny('Copilot', reason);
}

export function wrapperPreToolDeny(host: string): string {
  return JSON.stringify({ kind: 'deny', reason: preToolFailureReason(host) });
}

export function devinPreToolDeny(): string {
  return JSON.stringify({ decision: 'block', reason: preToolFailureReason('Windsurf/Devin') });
}
