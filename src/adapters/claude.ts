// src/adapters/claude.ts
// Claude + Codex share the nested `hookSpecificOutput` wire shape, and the
// raw→canonical tool map already folds both tool vocabularies (Bash/Edit vs
// exec_command/apply_patch) into one set of tool classes — so one adapter serves
// both nested hosts. Cursor (flat JSON) is the separate outlier.

import { classifyTool } from '../core/events';
import type { CanonicalEvent, HostId, ToolInput } from '../core/types';
import { patchTextFromToolInput } from '../shared/apply-patch';
import { codexHookEvidenceMarker, isCodexHookEvent, markCodexHookContext } from '../shared/codex-hook-evidence';
import { parseJson } from '../shared/fsjson';
import { asRecord, asString } from './coerce';
import type { HostAdapter, RawInvocation } from './types';

/** PreToolUse userReason split: keep evidence and append the agent recipe. */
function joinContextAndReason(context: string | undefined, reason: string): string {
  return context ? `${context}\n\n${reason}` : reason;
}

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
    case 'Stop':
      return 'Stop';
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
        const filePath = asString(
          toolInput.file_path ?? toolInput.filePath ?? toolInput.path
          ?? toolInput.notebook_path ?? toolInput.notebookPath,
        );
        const content = asString(
          toolInput.content ?? toolInput.new_content ?? toolInput.newContent
          ?? toolInput.new_source ?? toolInput.newSource,
        );
        const patchText = isPatchTool
          ? patchTextFromToolInput(rawToolInput, data)
          : '';
        tool = {
          class: classifyTool(rawName, toolInput),
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
      // A deny on Stop is a turn-end block, not a tool permission: Claude Code's
      // Stop protocol is {"decision":"block","reason"} (the reason is fed to the
      // model, which must continue instead of ending the turn). Codex gets the
      // same shape plus the marked additionalContext evidence channel — if a
      // Codex build does not honor Stop blocking, the reason still reaches the
      // model as context instead of vanishing.
      if (input.event === 'Stop') {
        return JSON.stringify({
          decision: 'block',
          reason: result.reason,
          ...(id === 'codex'
            ? {
              hookSpecificOutput: {
                hookEventName: 'Stop',
                additionalContext: markCodexHookContext('Stop', result.reason),
              },
            }
            : {}),
        });
      }
      // Claude paints permissionDecisionReason as user-visible Error chrome.
      // When userReason is set, that chrome gets the calm sentence and the
      // full agent recipe moves to additionalContext (joined with any
      // existing evidence) so the model still sees how to recover. Unset
      // keeps today's permissionDecisionReason = reason so wizard URLs in
      // `reason` stay visible. Codex has no other model channel — it
      // ALWAYS keeps permissionDecisionReason = reason; userReason is
      // unused on that wire. Stop (above) is model-facing turn-continue,
      // not Error chrome, so it stays on reason regardless.
      const claudeUserFacing = id === 'claude' ? (result.userReason ?? '').trim() : '';
      const permissionDecisionReason = claudeUserFacing || result.reason;
      const claudeAdditional = claudeUserFacing
        ? joinContextAndReason(result.context, result.reason)
        : result.context;
      return JSON.stringify({
        ...(result.systemMessage !== undefined ? { systemMessage: result.systemMessage } : {}),
        ...(result.promptRequest !== undefined ? { promptRequest: result.promptRequest } : {}),
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason,
          ...(id === 'codex'
            ? { additionalContext: result.context
              ? markCodexHookContext('PreToolUse', result.context)
              : codexHookEvidenceMarker('PreToolUse') }
            : (claudeAdditional ? { additionalContext: claudeAdditional } : {})),
        },
      });
    },
  };
}

export const codexAdapter = makeClaudeAdapter('codex');
