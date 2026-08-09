// src/gen/emit/hooks.ts
// Renders every host hook config from the single hook source. Command generation
// stays centralized there so portability and matcher changes cannot drift by host.

import type { GenRun } from '../lib/run';
import {
  COPILOT_EVENTS,
  CURSOR_EVENTS,
  WINDSURF_EVENTS,
  type HookEntry,
  type HookGroup,
  POST_TOOL_USE,
  PRE_TOOL_USE,
  SESSION_START,
  STOP,
  SUBAGENT_START,
  claudeCommand,
  copilotCommand,
  cursorCommand,
  promptSubmitGroup,
  windsurfCommand,
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
      SubagentStart: [renderGroup(SUBAGENT_START)],
      // LAST key deliberately: hooks/hooks.json feeds the Codex trust ABI, and
      // appending keeps every v1 positional identity (and trusted hash) intact.
      // Do NOT register SubagentStop — subagents must never be sent to setup.
      Stop: [renderGroup(STOP)],
    },
  };
}

// Both optional keys are rendered the same way and for the same reason: Cursor
// documents each one against a subset of events, so an event that is not in that
// subset omits the key rather than restating its default. The per-event decision
// (which events are fail-closed, and why the rest are not) lives beside the data
// in sources/hooks.ts, not here.
function cursorConfig(): Rec {
  const hooks: Rec = {};
  for (const { event, subcommand, loopLimit, failClosed } of CURSOR_EVENTS) {
    hooks[event] = [{
      command: cursorCommand(subcommand),
      ...(failClosed ? { failClosed } : {}),
      ...(loopLimit !== undefined ? { loop_limit: loopLimit } : {}),
    }];
  }
  return { version: 1, hooks };
}

function copilotHookCommand(subcommand: string): Rec {
  const nodeCmd = copilotCommand(subcommand);
  return {
    type: 'command',
    bash: nodeCmd,
    powershell: nodeCmd,
    cwd: '${PLUGIN_ROOT}',
    env: { TRAFFIC_ONE_PLUGIN_ROOT: '${PLUGIN_ROOT}', TRAFFIC_ONE_HOST: 'copilot' },
  };
}

function copilotConfig(): Rec {
  const hooks: Rec = {};
  for (const { event, subcommand } of COPILOT_EVENTS) {
    hooks[event] = [copilotHookCommand(subcommand)];
  }
  return { version: 1, hooks };
}

function windsurfConfig(): Rec {
  const hooks: Rec = {};
  for (const { event, subcommand } of WINDSURF_EVENTS) {
    hooks[event] = [{ command: windsurfCommand(subcommand), show_output: true }];
  }
  return { hooks };
}

export function emitHooks(run: GenRun): void {
  // settings.json keeps the UserPromptSubmit statusMessage; hooks/hooks.json omits it.
  run.json('settings.json', claudeHooks(true));
  run.json('hooks/hooks.json', claudeHooks(false));
  run.json('hooks/hooks-cursor.json', cursorConfig());
  run.json('hooks/hooks-copilot.json', copilotConfig());
  run.json('hooks/hooks-windsurf.json', windsurfConfig());
}
