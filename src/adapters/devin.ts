// Devin Local (the ACP backend embedded in current Windsurf) uses Claude-style
// hook inputs but a native `decision: block` output for tool denials. Keep this
// adapter separate from the legacy Cascade exit-code adapter in windsurf.ts.

import { toolClassForRawName } from '../core/events';
import type { CanonicalEvent, ToolInput } from '../core/types';
import { parseJson } from '../shared/fsjson';
import { asRecord, asString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';

function normalizeEvent(value: unknown): CanonicalEvent {
  switch (asString(value)) {
    case 'SessionStart': return 'SessionStart';
    case 'UserPromptSubmit': return 'UserPromptSubmit';
    case 'PostToolUse': return 'PostToolUse';
    case 'SubagentStart': return 'SubagentStart';
    default: return 'PreToolUse';
  }
}

export function makeDevinAdapter(): HostAdapter {
  return {
    id: 'windsurf',
    parse(raw: RawInvocation) {
      const data = asRecord(parseJson<Record<string, unknown>>(raw.stdin, {}));
      const event = normalizeEvent(data.hook_event_name ?? data.hookEventName);
      const rawName = asString(data.tool_name ?? data.toolName);
      const toolInput = asRecord(data.tool_input ?? data.toolInput);
      let tool: ToolInput | undefined;
      if (rawName) {
        const command = asString(toolInput.command ?? toolInput.cmd);
        const workdir = asString(toolInput.workdir ?? toolInput.cwd);
        const filePath = asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
        const content = asString(toolInput.content ?? toolInput.new_content ?? toolInput.newContent);
        tool = {
          class: toolClassForRawName(rawName),
          rawName,
          ...(command ? { command } : {}),
          ...(workdir ? { workdir } : {}),
          ...(filePath ? { filePath } : {}),
          ...(content ? { content } : {}),
        };
      }
      const prompt = asString(data.prompt);
      const workspaceRoot = asString(data.workspace_root ?? data.workspaceRoot);
      return {
        event,
        host: 'windsurf',
        cwd: asString(data.cwd) || process.cwd(),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        raw: data,
        ...(tool ? { tool } : {}),
        ...(prompt ? { prompt } : {}),
      };
    },

    serialize(result, input) {
      if (result.kind === 'noop') return '';
      if (result.kind === 'deny') {
        const reason = [result.reason, result.context, result.systemMessage]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .join('\n\n');
        return JSON.stringify({ decision: 'block', reason });
      }
      const additionalContext = [result.systemMessage, result.context]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n\n');
      if (!additionalContext) return '';
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: input.event,
          additionalContext,
        },
      });
    },
  };
}

export const devinAdapter = makeDevinAdapter();
