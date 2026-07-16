// src/adapters/windsurf.ts
// Windsurf / Devin Desktop Cascade hook adapter. Cascade hooks speak a simple
// stdin JSON + process exit-code protocol; this adapter only normalizes stdin to
// Traffic One's canonical event/tool shape and serializes a tiny JSON envelope
// for the entry script to map to exit 0 / exit 2.

import * as path from 'path';

import type { CanonicalEvent, ToolClass, ToolInput } from '../core/types';
import { parseJson } from '../shared/fsjson';
import { asRecord, firstString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';

const SUB_TO_EVENT: Readonly<Record<string, { event: CanonicalEvent; tool?: ToolClass }>> = {
  pre_user_prompt: { event: 'UserPromptSubmit' },
  pre_read_code: { event: 'PreToolUse', tool: 'file-read' },
  post_read_code: { event: 'PostToolUse', tool: 'file-read' },
  pre_write_code: { event: 'PreToolUse' },
  post_write_code: { event: 'PostToolUse' },
  pre_run_command: { event: 'PreToolUse', tool: 'shell' },
  post_run_command: { event: 'PostToolUse', tool: 'shell' },
  pre_mcp_tool_use: { event: 'PreToolUse', tool: 'other' },
  post_mcp_tool_use: { event: 'PostToolUse', tool: 'other' },
};

// Manual runtime actions are not Cascade hook events. They need a canonical
// PreToolUse context with no tool so their dedicated handler can run.
const MANUAL_ACTIONS = new Set(['materialize-project']);

function actionName(data: Record<string, unknown>, argv: readonly string[]): string {
  const explicit = firstString(data.agent_action_name, data.action, data.event);
  if (explicit) return explicit;
  return argv.find((arg) => Object.prototype.hasOwnProperty.call(SUB_TO_EVENT, arg) || MANUAL_ACTIONS.has(arg)) || '';
}

function stripFileUri(p: string): string {
  return p.startsWith('file://') ? decodeURIComponent(p.slice('file://'.length)) : p;
}

function editsContent(...values: readonly unknown[]): string {
  const chunks: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const rec = asRecord(entry);
      const text = firstString(
        rec.new_string, rec.newString, rec.new_str,
        rec.content, rec.text,
      );
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n');
}

function writeClass(info: Record<string, unknown>): ToolClass {
  const edits = Array.isArray(info.edits) ? info.edits : [];
  if (edits.length > 0 || info.old_string || info.oldString || info.old_str) return 'file-edit';
  return 'file-write';
}

function bareToolName(name: string): string {
  const parts = name.split('.').filter(Boolean);
  return (parts[parts.length - 1] || name).trim();
}

function cwdFor(data: Record<string, unknown>, info: Record<string, unknown>, filePath: string): string {
  const cwd = firstString(info.cwd, info.working_directory, info.workingDirectory, data.cwd, data.workspace_root, data.workspaceRoot);
  if (cwd) return cwd;
  if (filePath && path.isAbsolute(filePath)) return path.dirname(filePath);
  return process.cwd();
}

function toolFor(action: string, info: Record<string, unknown>): ToolInput | undefined {
  if (MANUAL_ACTIONS.has(action)) return undefined;
  const mapping = SUB_TO_EVENT[action] ?? { event: 'PreToolUse' as CanonicalEvent };
  if (mapping.event !== 'PreToolUse' && mapping.event !== 'PostToolUse') return undefined;

  const filePathRaw = firstString(info.file_path, info.filePath, info.path, info.uri);
  const filePath = filePathRaw ? stripFileUri(filePathRaw) : '';
  const command = firstString(info.command_line, info.commandLine, info.command, info.cmd);
  const content = firstString(
    info.content, info.new_content, info.newContent, info.text,
    info.new_string, info.newString, info.new_str,
  ) || editsContent(info.edits);
  const mcpTool = firstString(info.mcp_tool_name, info.mcpToolName);
  const mcpServer = firstString(info.mcp_server_name, info.mcpServerName);
  const rawName = action === 'pre_mcp_tool_use' || action === 'post_mcp_tool_use'
    ? [mcpServer, mcpTool].filter(Boolean).join('.') || action
    : action;
  const bareName = bareToolName(rawName);
  const cls = /^run_subagent$/i.test(bareName) || /^spawn_subagent$/i.test(bareName)
    ? 'spawn-agent'
    : action === 'pre_write_code' || action === 'post_write_code'
    ? writeClass(info)
    : (mapping.tool ?? 'other');

  return {
    class: cls,
    rawName,
    ...(command ? { command } : {}),
    ...(firstString(info.cwd, info.working_directory, info.workingDirectory) ? { workdir: firstString(info.cwd, info.working_directory, info.workingDirectory) } : {}),
    ...(filePath ? { filePath } : {}),
    ...(content ? { content } : {}),
  };
}

export function makeWindsurfAdapter(): HostAdapter {
  return {
    id: 'windsurf',
    parse(raw: RawInvocation) {
      const data = asRecord(parseJson<Record<string, unknown>>(raw.stdin, {}));
      const info = asRecord(data.tool_info ?? data.toolInfo ?? data.input);
      const action = actionName(data, raw.argv);
      const mapping = SUB_TO_EVENT[action] ?? { event: 'PreToolUse' as CanonicalEvent };
      const tool = toolFor(action, info);
      const filePath = tool?.filePath || '';
      const prompt = firstString(info.user_prompt, info.userPrompt, data.prompt, data.user_prompt, data.userPrompt);
      const cwd = cwdFor(data, info, filePath);
      // Use Cascade's authoritative workspace root as the resolution ceiling WHEN it
      // sends one. Do NOT fall back to the hook cwd: a tool hook's cwd is often a
      // SUBDIRECTORY of the opened project (e.g. `apps/web/src/lib`), and pinning the
      // ceiling there stops resolveProjectRoot from climbing UP to the onboarded
      // workspace root — so every subdir is treated as a fresh un-onboarded project
      // and re-triggers the wizard mid-build. With no explicit root we leave the
      // ceiling unset and let the shared resolver climb to the nearest onboarded
      // ancestor (same as Claude/Codex). The stray-ancestor case that motivated a
      // cwd ceiling is avoided by not onboarding directories above real projects; the
      // climb also stops at $HOME.
      const workspaceRoot = firstString(data.workspace_root, data.workspaceRoot, data.root_workspace_path, info.root_workspace_path);
      const explicitToolInput = asRecord(data.tool_input);
      const camelToolInput = asRecord(data.toolInput);
      const normalizedToolInput = Object.keys(explicitToolInput).length > 0
        ? explicitToolInput
        : (Object.keys(camelToolInput).length > 0 ? camelToolInput : info);
      const normalizedRaw = {
        ...data,
        tool_name: firstString(data.tool_name, data.toolName) || tool?.rawName || action,
        tool_input: normalizedToolInput,
      };

      return {
        event: mapping.event,
        host: 'windsurf',
        cwd,
        ...(workspaceRoot && path.isAbsolute(workspaceRoot) ? { workspaceRoot } : {}),
        raw: normalizedRaw,
        ...(tool ? { tool } : {}),
        ...(prompt ? { prompt } : {}),
      };
    },

    serialize(result) {
      if (result.kind === 'noop') return JSON.stringify({ kind: 'noop' });
      if (result.kind === 'context') {
        return JSON.stringify({
          kind: 'context',
          ...(result.context && result.context.trim() ? { context: result.context } : {}),
          ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
        });
      }
      return JSON.stringify({
        kind: 'deny',
        reason: result.reason,
        ...(result.context ? { context: result.context } : {}),
        ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
      });
    },
  };
}

export const windsurfAdapter = makeWindsurfAdapter();
