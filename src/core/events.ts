// src/core/events.ts
// Canonical event/tool-class helpers. The raw→canonical tool mapping is the
// single source that lets one gate match Claude's `Bash`, Codex's `exec_command`,
// and Cursor's shell event without any host branching in feature code.

import type { Handler, HookInput, ToolClass } from './types';

const RAW_TOOL_CLASS: Readonly<Record<string, ToolClass>> = {
  // shell
  Bash: 'shell',
  exec_command: 'shell',
  exec: 'shell',
  bash: 'shell',
  // write (create / bulk)
  Write: 'file-write',
  MultiEdit: 'file-write',
  NotebookEdit: 'file-write',
  apply_patch: 'file-write',
  write: 'file-write',
  create: 'file-write',
  str_replace_editor: 'file-write',
  // edit (modify existing)
  Edit: 'file-edit',
  edit: 'file-edit',
  patch: 'file-edit',
  // read
  Read: 'file-read',
  read: 'file-read',
  view: 'file-read',
  // subagents
  Task: 'spawn-agent',
  Agent: 'spawn-agent',
  agent: 'spawn-agent',
  spawn_agent: 'spawn-agent',
  run_subagent: 'spawn-agent',
  spawn_subagent: 'spawn-agent',
  send_input: 'spawn-agent',
  followup_task: 'spawn-agent',
  send_message: 'spawn-agent',
  wait_agent: 'spawn-agent',
  task: 'spawn-agent',
  // search
  Glob: 'search',
  Grep: 'search',
  glob: 'search',
  grep: 'search',
  list: 'search',
};

// Strip a host tool namespace: Codex may present a tool as `multi_agent_v1.spawn_agent`
// (namespace.tool) where Claude uses the bare `spawn_agent`. The canonical class is
// keyed on the bare tool name, so every match site must normalize through this.
export function stripToolNamespace(rawName: string): string {
  return rawName.includes('.') ? (rawName.split('.').pop() as string) : rawName;
}

export function toolClassForRawName(rawName: string): ToolClass {
  return RAW_TOOL_CLASS[stripToolNamespace(rawName)] ?? 'other';
}

function asArgsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function argsPath(args: Record<string, unknown>): string {
  return nonEmptyString(args.path) || nonEmptyString(args.file_path) || nonEmptyString(args.filePath);
}

function argsHaveWritePayload(args: Record<string, unknown>): boolean {
  return typeof args.content === 'string'
    || typeof args.new_string === 'string'
    || typeof args.newString === 'string'
    || args.edits != null;
}

function argsShellCommand(args: Record<string, unknown>): string {
  return nonEmptyString(args.command) || nonEmptyString(args.shell) || nonEmptyString(args.cmd);
}

// Name-first, then argument shape. Built-ins (Bash/Write/…) keep their
// name-derived class so a Write that also carries `command` cannot become
// shell. Unknown names — including `mcp__filesystem__write_file` — become
// file-write or shell only when the args actually look like one.
export function classifyTool(rawName: string, args?: unknown): ToolClass {
  const named = toolClassForRawName(rawName);
  if (named !== 'other') return named;
  const rec = asArgsRecord(args);
  if (argsPath(rec) && argsHaveWritePayload(rec)) return 'file-write';
  if (argsShellCommand(rec)) return 'shell';
  return 'other';
}

// Does a handler apply to this input? Same event, and (for tool-scoped handlers)
// the input's tool class is in the handler's list. No `tools` ⇒ all tools.
export function handlerMatches(handler: Handler, input: HookInput): boolean {
  if (handler.event !== input.event) return false;
  if (!handler.tools || handler.tools.length === 0) return true;
  const cls = input.tool?.class;
  return cls != null && handler.tools.includes(cls);
}
