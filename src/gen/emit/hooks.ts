// src/gen/emit/hooks.ts
// Renders settings.json + hooks/hooks.json + hooks/hooks-cursor.json from the
// single hook source. Byte-identical to the hand-authored configs.

import type { GenRun } from '../lib/run';
import {
  CURSOR_EVENTS,
  type HookEntry,
  type HookGroup,
  POST_TOOL_USE,
  PRE_TOOL_USE,
  SESSION_START,
  claudeCommand,
  cursorCommand,
  promptSubmitGroup,
} from '../sources/hooks';

type Rec = Record<string, unknown>;

function renderEntry(entry: HookEntry): Rec {
  return {
    type: 'command',
    ...(entry.statusMessage ? { statusMessage: entry.statusMessage } : {}),
    command: claudeCommand(entry.subcommand),
  };
}

function renderGroup(group: HookGroup): Rec {
  return {
    ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
    hooks: group.entries.map(renderEntry),
  };
}

function claudeHooks(promptStatus: boolean): Rec {
  return {
    hooks: {
      SessionStart: [renderGroup(SESSION_START)],
      UserPromptSubmit: [renderGroup(promptSubmitGroup(promptStatus))],
      PreToolUse: PRE_TOOL_USE.map(renderGroup),
      PostToolUse: POST_TOOL_USE.map(renderGroup),
    },
  };
}

function cursorConfig(): Rec {
  const hooks: Rec = {};
  for (const { event, subcommand } of CURSOR_EVENTS) {
    hooks[event] = [{ command: cursorCommand(subcommand) }];
  }
  return { version: 1, hooks };
}

export function emitHooks(run: GenRun): void {
  // settings.json keeps the UserPromptSubmit statusMessage; hooks/hooks.json omits it.
  run.json('settings.json', claudeHooks(true));
  run.json('hooks/hooks.json', claudeHooks(false));
  run.json('hooks/hooks-cursor.json', cursorConfig());
}
