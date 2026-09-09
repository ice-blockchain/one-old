// src/adapters/copilot.ts
// GitHub Copilot CLI + VS Code Copilot: coarse hook events with dual wire shapes.
// Parse is shared; serialize branches on surface (CLI flat vs VS Code hookSpecificOutput).

import * as path from 'path';

import type { CanonicalEvent, ToolClass, ToolInput } from '../core/types';
import { toolClassForRawName } from '../core/events';
import { parseJson } from '../shared/fsjson';
import { patchTextFromToolInput } from '../shared/apply-patch';
import { asRecord, asString, firstString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';
import { activeWorkspaceRoot, workspaceScopedCwd } from './workspace-root';

export type CopilotWireSurface = 'cli' | 'vscode';

/** PreToolUse userReason split: keep evidence and append the agent recipe. */
function joinContextAndReason(context: string | undefined, reason: string): string {
  return context ? `${context}\n\n${reason}` : reason;
}

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

function subcommandForEvent(event: CanonicalEvent): string {
  for (const [sub, mapping] of Object.entries(SUB_TO_EVENT)) {
    if (mapping.event === event) return sub;
  }
  return 'before-tool-use';
}

/**
 * Known `SUB_TO_EVENT` argv key wins (do not override CLI). Otherwise map
 * `hook_event_name` / `hookEventName` through `normalizeEvent` so an argv-less
 * VS Code payload still dispatches. Unknown events share normalizeEvent's
 * default (PreToolUse → `before-tool-use`). Missing event + no argv → undefined.
 */
export function resolveCopilotSubcommand(
  argv: readonly string[] = [],
  raw: unknown = {},
): string | undefined {
  const known = subcommandOf(argv);
  if (known) return known;
  const data = asRecord(raw);
  if (data.hook_event_name == null && data.hookEventName == null) return undefined;
  return subcommandForEvent(normalizeEvent(data.hook_event_name ?? data.hookEventName));
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

function admitSetFor(sub: string, event: CanonicalEvent): ReadonlySet<ToolClass> {
  return (sub === 'after-tool-use' || event === 'PostToolUse') ? GENERIC_POST_ADMIT : GENERIC_PRE_ADMIT;
}

function eventFromRaw(sub: string, data: Record<string, unknown>): CanonicalEvent {
  return sub
    ? (SUB_TO_EVENT[sub]?.event ?? 'PreToolUse')
    : normalizeEvent(data.hook_event_name ?? data.hookEventName ?? data.event);
}

function isPreOrPost(sub: string, event: CanonicalEvent): boolean {
  return sub === 'before-tool-use' || sub === 'after-tool-use' || event === 'PreToolUse' || event === 'PostToolUse';
}

function stdinPresentingSingleCall(data: Record<string, unknown>, call: CopilotToolCall): string {
  return JSON.stringify({
    ...data,
    tool_calls: [{ id: call.id, name: call.name, args: call.args }],
    toolCalls: [{ id: call.id, name: call.name, args: call.args }],
    tool_name: call.name,
    toolName: call.name,
    tool_args: call.args,
    toolArgs: call.args,
    tool_input: call.args,
    toolInput: call.args,
  });
}

/**
 * Split a Copilot multi-call payload into one invocation per admitted tool.
 * Returns null when the payload is not a pre/post batch (0–1 admitted calls),
 * so the existing single-call parse path stays byte-identical.
 */
export function splitCopilotAdmittedInvocations(raw: RawInvocation): RawInvocation[] | null {
  const data = asRecord(parseJson<Record<string, unknown>>(raw.stdin, {}));
  const sub = subcommandOf(raw.argv);
  const event = eventFromRaw(sub, data);
  if (!isPreOrPost(sub, event)) return null;
  const admit = admitSetFor(sub, event);
  const admitted = copilotToolCalls(data).filter((call) => admit.has(toolClassForRawName(call.name)));
  if (admitted.length <= 1) return null;
  return admitted.map((call) => ({ argv: raw.argv, stdin: stdinPresentingSingleCall(data, call) }));
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

/**
 * CLI flat vs VS Code nested output.
 *
 * Fixture evidence (`fixtures/copilot/`, SPIKE.md, `src/gen` hooks-copilot.json):
 * - Input is shared: CLI fixture `pre-tool-use-input.json` carries `hook_event_name`
 *   AND is invoked as `copilot-hook-runtime.cjs <subcommand>` (`SUB_TO_EVENT` keys).
 * - Gen emits the same argv subcommand for both surfaces (`copilotCommand`).
 * - VS Code output fixtures wrap `hookSpecificOutput`; CLI fixtures are flat.
 *
 * So `hook_event_name` alone cannot mean VS Code (CLI payloads have it), and
 * `TERM_PROGRAM=vscode` / `VSCODE_PID` cannot mean VS Code (CLI inherits both
 * inside a VS Code terminal). Those env signals are ignored.
 *
 * Order after the documented `TRAFFIC_ONE_COPILOT_WIRE=cli|vscode` override:
 *  1. inbound `hookSpecificOutput` → vscode
 *  2. argv known CLI subcommand → cli (CLI in a VS Code terminal)
 *  3. `hook_event_name` / `hookEventName` without a known argv subcommand → vscode
 *  4. default → cli (CLI ignores nested JSON; VS Code still has the env override)
 */
export function detectCopilotWireSurface(
  env: NodeJS.ProcessEnv = process.env,
  raw: unknown = {},
  argv: readonly string[] = [],
): CopilotWireSurface {
  if (env.TRAFFIC_ONE_COPILOT_WIRE === 'cli' || env.TRAFFIC_ONE_COPILOT_WIRE === 'vscode') {
    return env.TRAFFIC_ONE_COPILOT_WIRE;
  }
  const data = asRecord(raw);
  if (data.hookSpecificOutput != null) return 'vscode';
  if (subcommandOf(argv)) return 'cli';
  if (data.hook_event_name != null || data.hookEventName != null) return 'vscode';
  return 'cli';
}

function withFields(
  cls: ToolClass,
  rawName: string,
  command?: string,
  workdir?: string,
  filePath?: string,
  content?: string,
  patchText?: string,
): ToolInput {
  return {
    class: cls,
    rawName,
    ...(command ? { command } : {}),
    ...(workdir ? { workdir } : {}),
    ...(filePath ? { filePath } : {}),
    ...(content ? { content } : {}),
    ...(patchText ? { patchText } : {}),
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
      if (!wireSurface) wireSurface = detectCopilotWireSurface(process.env, data, raw.argv);

      const event = eventFromRaw(sub, data);

      const calls = copilotToolCalls(data);
      const preOrPost = isPreOrPost(sub, event);
      const admit = admitSetFor(sub, event);
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
      const patchText = /^(?:apply_patch|patch)$/i.test((rawName.split('.').pop() || ''))
        ? patchTextFromToolInput(effectiveToolArgs, input, data, selectedCall?.args)
        : '';

      let tool: ToolInput | undefined;
      if (mapping.tool) {
        tool = withFields(mapping.tool, rawName || sub, command, workdir, filePath, content, patchText);
      } else if (preOrPost) {
        const cls = rawName ? toolClassForRawName(rawName) : 'other';
        tool = withFields(admit.has(cls) ? cls : 'other', rawName || sub, command, workdir, filePath, content, patchText);
      } else if (rawName) {
        tool = withFields(toolClassForRawName(rawName), rawName, command, workdir, filePath, content, patchText);
      }

      const prompt = firstString(
        data.prompt, data.user_prompt, data.userPrompt, data.message, input.prompt, effectiveToolArgs.prompt,
      );
      const wsRoot = activeWorkspaceRoot(data);
      const wsCeiling = wsRoot && path.isAbsolute(wsRoot) ? wsRoot : undefined;

      return {
        event,
        host: 'copilot',
        cwd: workspaceScopedCwd(data, wsRoot),
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
        // Copilot paints permissionDecisionReason like Claude (user-visible).
        // userReason → that chrome; the agent recipe joins additionalContext
        // so the model still sees it. Unset keeps today's reason (wizard
        // URLs in `reason` stay visible). POST has no permission chrome —
        // leave its context channel alone.
        const userFacing = (result.userReason ?? '').trim();
        const permissionDecisionReason = userFacing || result.reason;
        const additionalContext = isPre && userFacing
          ? joinContextAndReason(result.context, result.reason)
          : result.context;
        return JSON.stringify({
          ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
          ...(isPre ? { permissionDecision: 'deny', permissionDecisionReason } : {}),
          ...(additionalContext ? { additionalContext } : {}),
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
      // VS Code deny envelope is PreToolUse-shaped only (hardcoded
      // hookEventName + permissionDecision). Do not change that wire —
      // fixtures pin it. Still apply the isPre guard so a POST deny
      // with userReason does not remix the recipe into additionalContext.
      const isPre = input?.event === 'PreToolUse';
      const userFacing = (result.userReason ?? '').trim();
      const permissionDecisionReason = userFacing || result.reason;
      const additionalContext = isPre && userFacing
        ? joinContextAndReason(result.context, result.reason)
        : result.context;
      return JSON.stringify({
        ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
        ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason,
          ...(additionalContext ? { additionalContext } : {}),
        },
      });
    },
  };
}

