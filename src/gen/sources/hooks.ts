// src/gen/sources/hooks.ts
// THE single source for every hook wiring. Today the matcher token sets live in
// settings.json AND hooks/hooks.json AND (re-encoded) hooks-cursor.json — a
// triple hand-sync. Here they live once: the Claude PreToolUse/PostToolUse
// groups + the Cursor event→subcommand fan-out. The emitter renders all three
// configs from this, byte-identical to today (golden-verified).
//
// settings.json and hooks/hooks.json are identical except UserPromptSubmit
// carries a statusMessage in settings.json only — modeled by the `promptStatus`
// parameter.

// The literal plugin-root shell expansion (NOT a JS template — single-quoted so
// the ${...} stays verbatim in the emitted command).
const PLUGIN_ROOT_EXPR = '${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}';

export function claudeCommand(subcommand: string): string {
  return `node "${PLUGIN_ROOT_EXPR}/scripts/hook-runtime.cjs" ${subcommand}`;
}

export function cursorCommand(subcommand: string): string {
  return `node ./scripts/cursor-hook-runtime.cjs ${subcommand}`;
}

export interface HookEntry { subcommand: string; statusMessage?: string; }
export interface HookGroup { matcher?: string; entries: HookEntry[]; }

export const SESSION_START: HookGroup = {
  entries: [{ subcommand: 'session-start', statusMessage: 'Checking Traffic One auth...' }],
};

export function promptSubmitGroup(withStatus: boolean): HookGroup {
  return {
    entries: [{ subcommand: 'user-prompt-submit', ...(withStatus ? { statusMessage: 'Applying traffic-one rules...' } : {}) }],
  };
}

export const PRE_TOOL_USE: HookGroup[] = [
  {
    // Includes the subagent-spawn names (Task|Agent for Claude, spawn_agent for
    // Codex) so the onboarding gate blocks subagent spawns on a new project too —
    // not just the agent-model gate. Without Task|Agent, a Claude `Task` spawn
    // skipped the onboarding gate and surfaced onboarding inside the subagent.
    matcher: 'Bash|Write|Edit|MultiEdit|Read|LS|Glob|Grep|exec_command|apply_patch|Task|Agent|spawn_agent|send_input|wait_agent|multi_tool_use',
    entries: [{ subcommand: 'check-onboarding-gate', statusMessage: 'Checking onboarding gate...' }],
  },
  {
    matcher: 'Task|Agent|spawn_agent',
    entries: [{ subcommand: 'check-agent-model', statusMessage: 'Checking agent model tier...' }],
  },
  {
    matcher: 'Bash|Write|Edit|exec_command|apply_patch',
    entries: [{ subcommand: 'check-plan-write', statusMessage: 'Validating plan gate...' }],
  },
  {
    matcher: 'Bash|exec_command',
    entries: [{ subcommand: 'check-library-allowlist', statusMessage: 'Checking library allowlist...' }],
  },
  {
    matcher: 'Glob|Grep',
    entries: [{ subcommand: 'pre-graphify-hint' }],
  },
];

export const POST_TOOL_USE: HookGroup[] = [
  {
    matcher: 'Bash|exec_command',
    entries: [
      { subcommand: 'post-build-page-speed', statusMessage: 'Checking page-speed gate...' },
      { subcommand: 'post-build-graphify' },
    ],
  },
  {
    matcher: '.*',
    entries: [{ subcommand: 'post-stack-setup', statusMessage: 'Ensuring project materialization...' }],
  },
];

// Cursor: one entry per canonical host event → subcommand.
export const CURSOR_EVENTS: { event: string; subcommand: string }[] = [
  { event: 'sessionStart', subcommand: 'session-start' },
  { event: 'beforeSubmitPrompt', subcommand: 'user-prompt-submit' },
  { event: 'beforeShellExecution', subcommand: 'before-shell-execution' },
  { event: 'afterShellExecution', subcommand: 'after-shell-execution' },
  { event: 'beforeReadFile', subcommand: 'before-read-file' },
  { event: 'afterFileEdit', subcommand: 'after-file-edit' },
];
