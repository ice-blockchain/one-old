// src/adapters/claude.ts
// Claude + Codex share the nested `hookSpecificOutput` wire shape, and the
// raw→canonical tool map already folds both tool vocabularies (Bash/Edit vs
// exec_command/apply_patch) into one set of tool classes — so one adapter serves
// both nested hosts. Cursor (flat JSON) is the separate outlier.

import { toolClassForRawName } from '../core/events';
import type { CanonicalEvent, HostId, ToolInput } from '../core/types';
import { patchTextFromToolInput } from '../shared/apply-patch';
import { codexHookEvidenceMarker, isCodexHookEvent, markCodexHookContext } from '../shared/codex-hook-evidence';
import { parseJson } from '../shared/fsjson';
import { asRecord, asString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';

function normalizeEvent(value: unknown): CanonicalEvent {
  switch (asString(value)) {
    case 'SessionStart':
      return 'SessionStart';
    case 'UserPromptSubmit':
      return 'UserPromptSubmit';
    case 'PostToolUse':
      return 'PostToolUse';
    case 'SubagentStart':
      return 'SubagentStart';
    default:
      return 'PreToolUse';
  }
}

export function makeClaudeAdapter(id: Extract<HostId, 'claude' | 'codex'> = 'claude'): HostAdapter {
  return {
    id,
    parse(raw: RawInvocation) {
      const data = asRecord(parseJson<Record<string, unknown>>(raw.stdin, {}));
      const event = normalizeEvent(data.hook_event_name ?? data.hookEventName);
      const rawName = asString(data.tool_name ?? data.toolName);
      const rawToolInput = data.tool_input ?? data.toolInput;
      const toolInput = asRecord(rawToolInput);

      let tool: ToolInput | undefined;
      if (rawName) {
        const isPatchTool = /^(?:apply_patch|patch)$/i.test(rawName.split('.').pop() || '');
        // Codex sends the apply_patch payload in tool_input.command; that is
        // patch DATA, not a shell command — leaving it on `command` makes every
        // command-text scanner treat patch content as shell (observed 3co).
        const command = isPatchTool ? '' : asString(toolInput.command ?? toolInput.cmd);
        const workdir = asString(toolInput.workdir ?? toolInput.cwd);
        const filePath = asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
        const content = asString(toolInput.content ?? toolInput.new_content ?? toolInput.newContent);
        const patchText = isPatchTool
          ? patchTextFromToolInput(rawToolInput, data)
          : '';
        tool = {
          class: toolClassForRawName(rawName),
          rawName,
          ...(command ? { command } : {}),
          ...(workdir ? { workdir } : {}),
          ...(filePath ? { filePath } : {}),
          ...(content ? { content } : {}),
          ...(patchText ? { patchText } : {}),
        };
      }

      const prompt = asString(data.prompt);
      return {
        event,
        host: id,
        cwd: asString(data.cwd) || process.cwd(),
        raw: data,
        ...(tool ? { tool } : {}),
        ...(prompt ? { prompt } : {}),
      };
    },

    serialize(result, input) {
      if (result.kind === 'noop') return '';
      if (result.kind === 'context') {
        const additionalContext = id === 'codex' && isCodexHookEvent(input.event)
          ? markCodexHookContext(input.event, result.context)
          : result.context;
        // Claude-only PreToolUse input rewrite (hookSpecificOutput.updatedInput —
        // a FULL tool_input replacement). Codex has no documented equivalent, and
        // its additionalContext stays unconditional: it doubles as the hook
        // evidence channel.
        const updatedInput = id === 'claude' && input.event === 'PreToolUse'
          ? result.updatedToolInput
          : undefined;
        return JSON.stringify({
          ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
          ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
          hookSpecificOutput: {
            hookEventName: input.event,
            ...(id === 'claude' && !additionalContext ? {} : { additionalContext }),
            ...(updatedInput !== undefined ? { updatedInput } : {}),
          },
        });
      }
      return JSON.stringify({
        ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
        ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.reason,
          ...(id === 'codex'
            ? { additionalContext: result.context
              ? markCodexHookContext('PreToolUse', result.context)
              : codexHookEvidenceMarker('PreToolUse') }
            : (result.context ? { additionalContext: result.context } : {})),
        },
      });
    },
  };
}

export const claudeAdapter = makeClaudeAdapter('claude');
export const codexAdapter = makeClaudeAdapter('codex');
