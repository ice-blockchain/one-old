// src/adapters/copilot.ts
// GitHub Copilot CLI + VS Code Copilot: coarse hook events with dual wire shapes.
// Parse is shared; serialize branches on surface (CLI flat vs VS Code hookSpecificOutput).

import * as path from 'path';

import type { CanonicalEvent, ToolClass, ToolInput } from '../core/types';
import { toolClassForRawName } from '../core/events';
import { parseJson } from '../shared/fsjson';
import { asRecord, asString, firstString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';

export type CopilotWireSurface = 'cli' | 'vscode';

const SUB_TO_EVENT: Readonly<Record<string, { event: CanonicalEvent; tool?: ToolClass }>> = {
  'session-start': { event: 'SessionStart' },
  'user-prompt-submit': { event: 'UserPromptSubmit' },
  'before-tool-use': { event: 'PreToolUse' },
  'after-tool-use': { event: 'PostToolUse' },
  'subagent-start': { event: 'SubagentStart' },
};

const GENERIC_PRE_ADMIT: ReadonlySet<ToolClass> = new Set(['shell', 'file-write', 'file-edit', 'file-read', 'search', 'spawn-agent']);
const GENERIC_POST_ADMIT: ReadonlySet<ToolClass> = new Set(['shell', 'file-write', 'file-edit', 'spawn-agent']);

function subcommandOf(argv: readonly string[]): string {
  const known = argv.filter((arg) => Object.prototype.hasOwnProperty.call(SUB_TO_EVENT, arg));
  return known.length > 0 ? (known[known.length - 1] as string) : '';
}

function normalizeEvent(value: unknown): CanonicalEvent {
  const s = asString(value);
  switch (s) {
    case 'SessionStart':
    case 'sessionStart':
      return 'SessionStart';
    case 'UserPromptSubmit':
    case 'userPromptSubmitted':
    case 'userPromptSubmit':
      return 'UserPromptSubmit';
    case 'PostToolUse':
    case 'postToolUse':
      return 'PostToolUse';
    case 'SubagentStart':
    case 'subagentStart':
      return 'SubagentStart';
    default:
      return 'PreToolUse';
  }
}

function stripFileUri(p: string): string {
  return p.startsWith('file://') ? decodeURIComponent(p.slice('file://'.length)) : p;
}

function firstWorkspaceRoot(data: Record<string, unknown>): string | undefined {
  const roots = data.workspace_roots ?? data.workspaceRoots ?? data.workspace_root ?? data.workspaceFolders;
  const list = Array.isArray(roots) ? roots : (roots != null ? [roots] : []);
  for (const r of list) {
    if (typeof r === 'string' && r) return stripFileUri(r);
    if (r && typeof r === 'object') {
      const rec = r as Record<string, unknown>;
      const p = firstString(rec.path, rec.uri, rec.fsPath);
      if (p) return stripFileUri(p);
    }
  }
  return undefined;
}

function isInsideOrEqual(candidate: string, boundary: string): boolean {
  const rel = path.relative(path.resolve(boundary), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function copilotCwd(data: Record<string, unknown>, wsRoot: string | undefined): string {
  const explicit = firstString(data.cwd);
  if (!explicit) return wsRoot || process.cwd();
  if (!wsRoot || !path.isAbsolute(wsRoot)) return explicit;
  const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(wsRoot, explicit);
  return isInsideOrEqual(resolved, wsRoot) ? explicit : wsRoot;
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return asRecord(raw);
}

interface CopilotToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function copilotToolCalls(data: Record<string, unknown>): CopilotToolCall[] {
  const rawCalls = data.tool_calls ?? data.toolCalls;
  if (!Array.isArray(rawCalls)) return [];
  const calls: CopilotToolCall[] = [];
  for (const rawCall of rawCalls) {
    const call = asRecord(rawCall);
    const name = firstString(call.name, call.toolName, call.tool_name);
    if (!name) continue;
    calls.push({
      id: firstString(call.id, call.toolCallId, call.tool_call_id) || '',
      name,
      args: parseToolArgs(call.args ?? call.arguments ?? call.toolArgs ?? call.tool_args),
    });
  }
  return calls;
}

function selectToolCall(calls: readonly CopilotToolCall[], admitted: ReadonlySet<ToolClass>): CopilotToolCall | null {
  return calls.find((call) => admitted.has(toolClassForRawName(call.name))) || calls[0] || null;
}

function hasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function rawForPipeline(data: Record<string, unknown>, toolName: string, toolArgs: Record<string, unknown>, toolCallId?: string): Record<string, unknown> {
  const explicit = asRecord(data.tool_input ?? data.toolInput);
  if (!toolName && (!hasKeys(toolArgs) || hasKeys(explicit))) return data;
  return {
    ...data,
    ...(toolName ? { tool_name: toolName, toolName } : {}),
    ...(toolCallId ? { tool_call_id: toolCallId, toolCallId } : {}),
    ...(hasKeys(toolArgs) && !hasKeys(explicit) ? { tool_input: toolArgs, toolInput: toolArgs } : {}),
  };
}

/** Detect CLI flat vs VS Code nested output from env + inbound payload. */
export function detectCopilotWireSurface(
  env: NodeJS.ProcessEnv = process.env,
  raw: unknown = {},
): CopilotWireSurface {
  if (env.TRAFFIC_ONE_COPILOT_WIRE === 'cli' || env.TRAFFIC_ONE_COPILOT_WIRE === 'vscode') {
    return env.TRAFFIC_ONE_COPILOT_WIRE;
  }
  const data = asRecord(raw);
  if (data.hookSpecificOutput != null) return 'vscode';
  if (env.VSCODE_PID || env.TERM_PROGRAM === 'vscode') return 'vscode';
  return 'cli';
}

function withFields(
  cls: ToolClass,
  rawName: string,
  command?: string,
  workdir?: string,
  filePath?: string,
  content?: string,
): ToolInput {
  return {
    class: cls,
    rawName,
    ...(command ? { command } : {}),
    ...(workdir ? { workdir } : {}),
    ...(filePath ? { filePath } : {}),
    ...(content ? { content } : {}),
  };
}

export function makeCopilotAdapter(surface?: CopilotWireSurface): HostAdapter {
  let wireSurface = surface;
  return {
    id: 'copilot',
    parse(raw: RawInvocation) {
      const sub = subcommandOf(raw.argv);
      const mapping = SUB_TO_EVENT[sub] ?? { event: 'PreToolUse' as CanonicalEvent };
      const data = asRecord(parseJson<Record<string, unknown>>(raw.stdin, {}));
      if (!wireSurface) wireSurface = detectCopilotWireSurface(process.env, data);

      const event = sub
        ? mapping.event
        : normalizeEvent(data.hook_event_name ?? data.hookEventName ?? data.event);

      const calls = copilotToolCalls(data);
      const preOrPost = sub === 'before-tool-use' || sub === 'after-tool-use' || event === 'PreToolUse' || event === 'PostToolUse';
      const admit = (sub === 'after-tool-use' || event === 'PostToolUse') ? GENERIC_POST_ADMIT : GENERIC_PRE_ADMIT;
      const selectedCall = preOrPost ? selectToolCall(calls, admit) : null;
      const rawName = firstString(data.tool_name, data.toolName, data.tool, data.name, selectedCall?.name);
      const toolArgs = parseToolArgs(data.tool_args ?? data.toolArgs ?? data.tool_input ?? data.toolInput);
      const effectiveToolArgs = hasKeys(toolArgs) ? toolArgs : (selectedCall?.args || {});
      const input = asRecord(data.input ?? toolArgs);
      const rawPipeline = rawForPipeline(data, rawName, effectiveToolArgs, selectedCall?.id);

      const command = firstString(
        data.command, data.cmd, input.command, input.cmd, effectiveToolArgs.command, effectiveToolArgs.cmd,
      );
      const workdir = firstString(
        data.workdir, data.working_dir, input.workdir, input.cwd, effectiveToolArgs.workdir, effectiveToolArgs.cwd,
      );
      const filePath = firstString(
        data.file_path, data.filePath, data.path, input.file_path, input.filePath, input.path, effectiveToolArgs.path,
      );
      const content = firstString(
        data.content, data.new_content, input.content, input.new_content, effectiveToolArgs.content, effectiveToolArgs.new_content,
      );

      let tool: ToolInput | undefined;
      if (mapping.tool) {
        tool = withFields(mapping.tool, rawName || sub, command, workdir, filePath, content);
      } else if (preOrPost) {
        const cls = rawName ? toolClassForRawName(rawName) : 'other';
        tool = withFields(admit.has(cls) ? cls : 'other', rawName || sub, command, workdir, filePath, content);
      } else if (rawName) {
        tool = withFields(toolClassForRawName(rawName), rawName, command, workdir, filePath, content);
      }

      const prompt = firstString(
        data.prompt, data.user_prompt, data.userPrompt, data.message, input.prompt, effectiveToolArgs.prompt,
      );
      const wsRoot = firstWorkspaceRoot(data);
      const wsCeiling = wsRoot && path.isAbsolute(wsRoot) ? wsRoot : undefined;

      return {
        event,
        host: 'copilot',
        cwd: copilotCwd(data, wsRoot),
        ...(wsCeiling ? { workspaceRoot: wsCeiling } : {}),
        raw: rawPipeline,
        ...(tool ? { tool } : {}),
        ...(prompt ? { prompt } : {}),
      };
    },

    serialize(result, input) {
      const surface = wireSurface ?? detectCopilotWireSurface(process.env, input?.raw);
      if (result.kind === 'noop') return surface === 'vscode' ? '{}' : '';

      if (surface === 'cli') {
        if (result.kind === 'context') {
          return JSON.stringify({
            ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
            ...(result.context && result.context.trim() ? { additionalContext: result.context } : {}),
          });
        }
        const isPre = input?.event === 'PreToolUse';
        if (result.askUser && isPre) {
          return JSON.stringify({
            permissionDecision: 'ask',
            permissionDecisionReason: result.reason,
            ...(result.context ? { additionalContext: result.context } : {}),
            ...(result.agentMessage ? { agentMessage: result.agentMessage } : {}),
          });
        }
        return JSON.stringify({
          ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
          ...(isPre ? { permissionDecision: 'deny', permissionDecisionReason: result.reason } : {}),
          ...(result.context ? { additionalContext: result.context } : {}),
        });
      }

      // VS Code: hookSpecificOutput wrapper (Claude-shaped).
      if (result.kind === 'context') {
        return JSON.stringify({
          ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
          ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
          hookSpecificOutput: { hookEventName: input.event, additionalContext: result.context },
        });
      }
      return JSON.stringify({
        ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
        ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
          ...(result.context ? { additionalContext: result.context } : {}),
        },
      });
    },
  };
}

export const copilotAdapter = makeCopilotAdapter();
