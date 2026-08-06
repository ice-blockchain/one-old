// Last-resort host-wire fallbacks. runPipeline protects failures thrown by a
// handler, while these helpers protect the wider boundary: module discovery,
// adapter parsing, context construction, and serialization. A pre-tool hook must
// never become an empty success merely because the plugin runtime is damaged.

import { codexHookEvidenceMarker } from '../shared/codex-hook-evidence';
import { isShellToolName, isTrafficOneDoctorCommand } from '../shared/tool-classify';

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

// The generic ("wrapper"/fallback) input record, shared by every helper below
// that needs to look at a wrapper tool call's arguments regardless of which
// of the several documented field names carries them (`tool_input`, `output.
// args`, `tool.args`, …) — kept as ONE priority list so a caller who wants
// the wrapper's tool name and a caller who wants its command argument agree
// on which field wins when more than one is present.
function genericToolInputRecord(data: HookRecord): HookRecord {
  const tool = record(data.tool);
  const output = record(data.output);
  return record(
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
}

function genericToolName(data: HookRecord): string {
  const tool = record(data.tool);
  const output = record(data.output);
  const outputArgs = record(output.args);
  const input = genericToolInputRecord(data);
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

// ── Per-surface EXECUTED command text ────────────────────────────────────
//
// commandText() above is a deliberately permissive union used for payload
// VALIDATION ("is there a command at all"), where reading one field too many
// only ever rejects more. It is the wrong reader for an exemption: it puts
// top-level `data.command` ahead of everything, so a payload carrying a
// stray `command` sibling would be JUDGED on that string while the host
// actually executes a different field. Each reader below instead mirrors, in
// order, exactly what that surface's own adapter reads — so the text this
// exemption inspects is the text that runs.
//
// Claude/Codex (adapters/claude.ts): `tool_input.command ?? .cmd`, nothing
// top-level.
function nestedShellCommand(data: HookRecord): string {
  const input = record(data.tool_input ?? data.toolInput);
  return firstText(input.command, input.cmd);
}

// Cursor (adapters/cursor.ts).
function cursorShellCommand(data: HookRecord): string {
  const input = record(data.input ?? data.tool_input ?? data.toolInput);
  return firstText(data.command, data.cmd, data.shell_command, data.shellCommand, input.command, input.cmd);
}

// Windsurf/Devin (adapters/windsurf.ts): the command lives ONLY on the
// tool_info record — this surface is why the union reader was wrong.
function windsurfShellCommand(data: HookRecord): string {
  const info = record(data.tool_info ?? data.toolInfo ?? data.input);
  return firstText(info.command_line, info.commandLine, info.command, info.cmd);
}

// Kilo/OpenCode wrapper (adapters/kilo.ts): top-level first, then the nested
// input record (which is where output.args/tool.args land), then tool.command.
function wrapperShellCommand(data: HookRecord): string {
  const input = genericToolInputRecord(data);
  const tool = record(data.tool);
  return firstText(data.command, data.cmd, input.command, input.cmd, tool.command);
}

// Copilot flat shape (adapters/copilot.ts).
function copilotFlatShellCommand(data: HookRecord): string {
  const toolArgs = parseArgsRecord(data.tool_args ?? data.toolArgs ?? data.tool_input ?? data.toolInput);
  const input = record(data.input ?? toolArgs);
  return firstText(data.command, data.cmd, input.command, input.cmd, toolArgs.command, toolArgs.cmd);
}

// Copilot sends tool-call arguments either as an object or as a JSON STRING;
// its adapter parses both (parseToolArgs), so this must too or a legitimate
// doctor call in the stringified shape would stay blocked.
function parseArgsRecord(value: unknown): HookRecord {
  if (typeof value === 'string' && value.trim()) {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return record(value);
}

// Every shell command this payload would execute, IF the payload is shaped as a
// shell tool invocation on this surface — null when it is not one (a file edit,
// an MCP call, a bare read; none of those is how doctor is invoked) or when any
// member of a batch is not a shell call. A LIST, not a string, because Copilot
// can carry several `tool_calls` in one payload: the exemption below has to
// clear all of them, not the first one that happens to be doctor.
function shellCommandBatchForSurface(
  data: HookRecord,
  subcommand: string,
  surface: PreToolPayloadSurface,
): string[] | null {
  if (surface === 'cursor') {
    return subcommand === 'before-shell-execution'
      ? [cursorShellCommand(data)]
      : (isShellToolName(genericToolName(data)) ? [wrapperShellCommand(data)] : null);
  }
  if (surface === 'windsurf') {
    return subcommand === 'pre_run_command'
      ? [windsurfShellCommand(data)]
      : (isShellToolName(genericToolName(data)) ? [wrapperShellCommand(data)] : null);
  }
  if (surface === 'nested') {
    return isShellToolName(firstText(data.tool_name, data.toolName)) ? [nestedShellCommand(data)] : null;
  }
  if (surface === 'copilot') {
    const calls = data.tool_calls ?? data.toolCalls;
    if (Array.isArray(calls)) {
      if (calls.length === 0) return null;
      const commands: string[] = [];
      for (const value of calls) {
        const call = record(value);
        if (!isShellToolName(firstText(call.name, call.tool_name, call.toolName))) return null;
        const args = parseArgsRecord(call.args ?? call.arguments ?? call.toolArgs ?? call.tool_args ?? call.input);
        commands.push(firstText(args.command, args.cmd));
      }
      return commands;
    }
    return isShellToolName(genericToolName(data)) ? [copilotFlatShellCommand(data)] : null;
  }
  // 'wrapper' (Kilo/OpenCode).
  return isShellToolName(genericToolName(data)) ? [wrapperShellCommand(data)] : null;
}

// ── The recovery allowlist ───────────────────────────────────────────────────
// One row per RUNNER that must stay reachable when everything else is broken,
// each row an exact argv grammar. A table rather than an `if` on doctor because
// the property being asserted is about the SET ("recovery is never gated"), and
// a set spread across call sites is a set nobody can audit; this way the
// complete answer to "what can bypass the fail-closed boundary?" is the length
// of this array.
//
// THE RULE FOR ADDING A ROW, and it is not negotiable: the runner must be
// READ-ONLY. The whole exemption is sound only because it can produce a NOOP
// and nothing else (see the SECURITY block below) — a runner that MUTATES,
// reached through a boundary that exists precisely because the machinery which
// would have judged that mutation is broken, is not an exemption, it is an
// unguarded write.
//
// Worked example, because this one WILL come up: `run-status --status failed`
// is the standard way to unwedge a stuck run, and it belongs on no allowlist.
// It rewrites the run ledger, and a wedged run is exactly the state in which
// an agent would most like to declare the run over — the gates that stop it
// doing so are the point. An operator with a genuinely wedged run runs it from
// their own terminal, where no hook fires at all; that is what the escape hatch
// IS. (Same reasoning forbids a blanket "no gate may deny anything inside the
// plugin root" rule, which would un-gate it by the back door.)
//
// `doctor --unblock <gateId>` is likewise absent, from tool-classify.ts's
// grammar and therefore from here: it is the one doctor invocation that writes,
// and an agent able to mint its own override has a bypass, not an escape hatch.
interface RecoveryRunner {
  readonly id: string;
  /** The runner's own exact argv grammar. Biased to DENY; see tool-classify.ts. */
  readonly matches: (command: string) => boolean;
}

const RECOVERY_RUNNERS: readonly RecoveryRunner[] = [
  { id: 'doctor', matches: (command) => isTrafficOneDoctorCommand('Bash', { command }) },
];

function isRecoveryCommand(command: string): boolean {
  return Boolean(command) && RECOVERY_RUNNERS.some((runner) => runner.matches(command));
}

// A fail-closed boundary — the early payload-validation check and the runtime
// catch block below — sees only raw, unparsed stdin. It runs BEFORE (or
// instead of, once the pipeline has thrown) the adapter/pipeline machinery
// that normally turns that stdin into the (toolName, toolInput) pair the
// onboarding gate's OWN isTrafficOneDoctorCommand check runs on. This helper
// closes that gap by extracting the same shell-command text directly off raw
// stdin (the pattern isManagedCursorMcpInvocation in cursor-entry.ts already
// uses for a different early, pre-dispatch decision) and running it through
// the identical bounded exact-argv grammar.
//
// SECURITY: this is the only recovery exemption anywhere in the fail-closed
// boundary, and every constraint below is deliberate, not incidental:
//  - it can only ever produce a NOOP (fall through to the normal allow path),
//    never a deny, an elevated tool, or a state mutation — a bug here can at
//    worst UNDER-exempt (doctor stays blocked), never grant a new capability;
//  - it fires only when the raw payload parses as an object AND is shaped as
//    a Bash/exec_command invocation (never Write/Edit/apply_patch/MCP — the
//    exemption cannot be reached through any other tool class);
//  - on a multi-call payload (Copilot's `tool_calls`) EVERY call must be a
//    shell call AND must satisfy a grammar. Requiring only one to match
//    exempted the whole payload off a single doctor entry, so
//    `[doctor, rm -rf /]` passed while `[rm -rf /, doctor]` did not — a batch
//    is exempt only if there is nothing in it but recovery commands;
//  - the command text itself must satisfy some row's bounded exact-argv
//    grammar (tool-classify.ts): for doctor, `node <doctorScriptPath()>` with
//    at most one recognized flag — no prefix match, no arbitrary trailing
//    argv, no other binary, no shell metacharacters (cleanShellWords rejects
//    those upstream). Widening what this exemption admits means widening one
//    of those grammars, each unit-tested adversarially on its own;
//  - it needs nothing from the subsystems a fail-closed boundary exists
//    BECAUSE they might be broken (module discovery, the pipeline, state
//    I/O) — it is pure string parsing over the same JSON the boundary has
//    already decoded, so it stays available exactly when doctor itself needs
//    to become reachable;
//  - it grants no capability a user did not already have: the pre-tool gate
//    this bypasses exists to stop an AUTOMATED agent action, not a human
//    running a binary directly, and the model can only reach this shape by
//    literally re-emitting a documented recovery command.
export function isFailClosedRecoveryExemption(
  stdin: string,
  subcommand: string | undefined,
  surface: PreToolPayloadSurface,
): boolean {
  const data = hookRecord(stdin);
  if (!data) return false;
  const commands = shellCommandBatchForSurface(data, String(subcommand || ''), surface);
  if (!commands || commands.length === 0) return false;
  return commands.every(isRecoveryCommand);
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
