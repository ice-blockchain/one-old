// src/adapters/opencode.ts
// OpenCode host adapter. The global wrapper normalizes OpenCode plugin hook
// payloads to JSON; this adapter maps that boundary onto Traffic One's canonical
// events/tools and returns a wrapper-readable decision object.

import * as path from 'path';

import {
  OPENCODE_TOOL_BASH,
  OPENCODE_TOOL_EDIT,
  OPENCODE_TOOL_GLOB,
  OPENCODE_TOOL_GREP,
  OPENCODE_TOOL_PATCH,
  OPENCODE_TOOL_READ,
  OPENCODE_TOOL_TASK,
  OPENCODE_TOOL_WRITE,
} from '../config/opencode-host';
import type { CanonicalEvent, ToolClass, ToolInput } from '../core/types';
import { patchTextFromToolInput } from '../shared/apply-patch';
import { parseJson } from '../shared/fsjson';
import { asRecord, firstString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';

const SUB_TO_EVENT: Readonly<Record<string, CanonicalEvent>> = {
  'session-start': 'SessionStart',
  'system-transform': 'SessionStart',
  'before-tool-use': 'PreToolUse',
  'after-tool-use': 'PostToolUse',
  'user-prompt-submit': 'UserPromptSubmit',
};

function subcommandOf(argv: readonly string[]): string {
  const known = argv.filter((arg) => Object.prototype.hasOwnProperty.call(SUB_TO_EVENT, arg));
  return known.length > 0 ? (known[known.length - 1] as string) : '';
}

function normalizeEvent(value: unknown): CanonicalEvent {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'session-start' || raw === 'sessionstart' || raw.includes('session')) return 'SessionStart';
  if (raw.includes('system.transform')) return 'SessionStart';
  if (raw === 'chat.message' || raw.includes('chat.message')) return 'UserPromptSubmit';
  if (raw === 'user-prompt-submit' || raw === 'userpromptsubmit' || raw.includes('prompt.submit')) return 'UserPromptSubmit';
  if (raw === 'posttooluse' || raw.includes('tool.execute.after')) return 'PostToolUse';
  if (raw === 'pretooluse' || raw.includes('tool.execute.before')) return 'PreToolUse';
  return 'PreToolUse';
}

function nestedToolRecord(data: Record<string, unknown>): Record<string, unknown> {
  return asRecord(data.tool);
}

function nestedInputRecord(data: Record<string, unknown>, tool: Record<string, unknown>): Record<string, unknown> {
  const output = asRecord(data.output);
  return asRecord(
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

function rawToolName(data: Record<string, unknown>, tool: Record<string, unknown>, input: Record<string, unknown>): string {
  return firstString(
    data.tool_name, data.toolName, data.toolNameRaw, data.name, data.tool,
    tool.name, tool.id, tool.tool, tool.type,
    input.tool_name, input.toolName, input.name, input.tool,
  );
}

function editsContent(...values: readonly unknown[]): string {
  const chunks: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const rec = asRecord(entry);
      const text = firstString(rec.new_string, rec.newString, rec.new_str, rec.content, rec.text);
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n');
}

function normalizeMacAbsolutePath(value: string): string {
  // Kilo has emitted macOS absolute paths without their leading slash
  // (`Users/name/project/...`). Treat that as absolute only when it is the
  // unambiguous macOS home-path form; ordinary project-relative paths remain so.
  return /^Users\/[^/]+\//.test(value) ? `/${value}` : value;
}

function firstPath(input: Record<string, unknown>, data: Record<string, unknown>, tool: Record<string, unknown>): string {
  const direct = firstString(
    input.file_path, input.filePath, input.path, input.uri, input.file,
    data.file_path, data.filePath, data.path, data.uri,
    tool.path, tool.file_path, tool.filePath,
  );
  if (direct) {
    const decoded = direct.startsWith('file://') ? decodeURIComponent(direct.slice('file://'.length)) : direct;
    return normalizeMacAbsolutePath(decoded);
  }
  for (const source of [input.files, data.files]) {
    if (!Array.isArray(source)) continue;
    const first = source.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (first) return normalizeMacAbsolutePath(first);
  }
  return '';
}

function hasEditShape(input: Record<string, unknown>): boolean {
  return Boolean(
    input.patch || input.diff || input.old_string || input.oldString || input.old_str
      || input.new_string || input.newString || input.new_str
      || (Array.isArray(input.edits) && input.edits.length > 0),
  );
}

function toolClassForOpenCode(rawName: string, input: Record<string, unknown>): ToolClass {
  switch (rawName.toLowerCase()) {
    case OPENCODE_TOOL_BASH:
      return 'shell';
    case OPENCODE_TOOL_WRITE:
      return 'file-write';
    case OPENCODE_TOOL_EDIT:
      return hasEditShape(input) ? 'file-edit' : 'file-write';
    case OPENCODE_TOOL_PATCH:
      return hasEditShape(input) ? 'file-edit' : 'file-write';
    case OPENCODE_TOOL_READ:
      return 'file-read';
    case OPENCODE_TOOL_GREP:
    case OPENCODE_TOOL_GLOB:
      return 'search';
    case OPENCODE_TOOL_TASK:
      return 'spawn-agent';
    default:
      return 'other';
  }
}

function makeTool(data: Record<string, unknown>): ToolInput | undefined {
  const tool = nestedToolRecord(data);
  const input = nestedInputRecord(data, tool);
  const rawName = rawToolName(data, tool, input);
  if (!rawName) return undefined;

  const command = firstString(data.command, data.cmd, input.command, input.cmd, tool.command);
  const workdir = firstString(
    data.workdir, data.cwd, data.working_dir, data.workingDir,
    input.workdir, input.cwd, input.working_dir, input.workingDir,
  );
  const filePath = firstPath(input, data, tool);
  const content = firstString(
    data.content, data.text, data.patch, data.diff,
    input.content, input.new_content, input.newContent, input.text,
    input.new_string, input.newString, input.new_str, input.patch, input.diff,
    tool.content,
  ) || editsContent(data.edits, input.edits);
  const patchText = /^(?:apply_patch|patch)$/i.test(rawName.split('.').pop() || '')
    ? patchTextFromToolInput(input, data, tool)
    : '';

  return {
    class: toolClassForOpenCode(rawName, input),
    rawName,
    ...(command ? { command } : {}),
    ...(workdir ? { workdir } : {}),
    ...(filePath ? { filePath } : {}),
    ...(content ? { content } : {}),
    ...(patchText ? { patchText } : {}),
  };
}

function cwdFor(data: Record<string, unknown>): { cwd: string; workspaceRoot?: string } {
  const input = asRecord(data.input);
  const output = asRecord(data.output);
  const workspaceRoot = firstString(data.workspaceRoot, data.workspace_root, data.projectRoot, data.root, input.workspaceRoot, output.workspaceRoot);
  const cwd = firstString(data.cwd, data.workdir, data.workingDir) || workspaceRoot || process.cwd();
  const absoluteWorkspace = workspaceRoot && path.isAbsolute(workspaceRoot) ? workspaceRoot : '';
  return {
    cwd,
    ...(absoluteWorkspace ? { workspaceRoot: absoluteWorkspace } : {}),
  };
}

export function makeOpenCodeAdapter(): HostAdapter {
  return {
    id: 'opencode',
    parse(raw: RawInvocation) {
      const sub = subcommandOf(raw.argv);
      const data = asRecord(parseJson<Record<string, unknown>>(raw.stdin, {}));
      const event = SUB_TO_EVENT[sub] ?? normalizeEvent(data.event ?? data.hook_event_name ?? data.hookEventName);
      const tool = event === 'PreToolUse' || event === 'PostToolUse' ? makeTool(data) : undefined;
      const normalizedToolInput = tool
        ? nestedInputRecord(data, nestedToolRecord(data))
        : {};
      const prompt = firstString(
        data.prompt, data.message, data.text,
        asRecord(data.input).prompt, asRecord(data.input).message,
        asRecord(data.output).prompt, asRecord(data.output).message,
      );
      const cwd = cwdFor(data);
      return {
        event,
        host: 'opencode',
        ...(sub === 'before-tool-use' ? { hostHookPoint: 'tool.execute.before' } : {}),
        ...cwd,
        // Runtime gates occasionally need lossless edit evidence
        // (`old_string`, ordered `edits`, replace_all), not just the canonical
        // tool's synthesized new content. Normalize the documented
        // `output.args` wrapper into the same raw aliases every other host
        // exposes so structural Edit reconstruction sees the complete payload.
        raw: tool
          ? { ...data, tool_input: normalizedToolInput, toolInput: normalizedToolInput }
          : data,
        ...(tool ? { tool } : {}),
        ...(prompt ? { prompt } : {}),
      };
    },

    serialize(result, input) {
      if (result.kind === 'noop') return JSON.stringify({ kind: 'noop' });
      if (result.kind === 'context') {
        return JSON.stringify({
          kind: 'context',
          ...(result.context && result.context.trim() ? { context: result.context } : {}),
          ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
          ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
        });
      }
      if (input.event === 'PostToolUse') {
        const context = [result.reason, result.context].filter((v): v is string => typeof v === 'string' && v.trim().length > 0).join('\n\n');
        return JSON.stringify({
          kind: 'context',
          ...(context ? { context } : {}),
          warning: true,
          ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
        });
      }
      return JSON.stringify({
        kind: 'deny',
        reason: result.reason,
        ...(result.context ? { context: result.context } : {}),
        ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
        ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
        ...(result.askUser !== undefined ? { askUser: result.askUser } : {}),
        ...(result.agentMessage !== undefined ? { agentMessage: result.agentMessage } : {}),
      });
    },
  };
}

export const opencodeAdapter = makeOpenCodeAdapter();
