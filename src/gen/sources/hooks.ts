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
// the ${...} stays verbatim in the emitted command). Exported so the .mcp.json
// generator launches the bundled MCP server through the SAME chain (one shared
// .mcp.json must resolve on Claude/Codex/Cursor alike).
export const PLUGIN_ROOT_EXPR = '${TRAFFIC_ONE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}}';

export function claudeCommand(subcommand: string): string {
  return `node "${PLUGIN_ROOT_EXPR}/scripts/hook-runtime.cjs" ${subcommand}`;
}

export function cursorCommand(subcommand: string): string {
  return `node ./scripts/cursor-hook-runtime.cjs ${subcommand}`;
}

export function copilotCommand(subcommand: string): string {
  const cmd = `node "./scripts/copilot-hook-runtime.cjs" ${subcommand}`;
  return cmd;
}

export function windsurfCommand(subcommand: string): string {
  return `TRAFFIC_ONE_PLUGIN_ROOT="${PLUGIN_ROOT_EXPR}" TRAFFIC_ONE_HOST=windsurf node "${PLUGIN_ROOT_EXPR}/scripts/windsurf-hook-runtime.cjs" ${subcommand} --host=windsurf`;
}

export interface CopilotHookEntry {
  subcommand: string;
}

// Copilot CLI + VS Code: coarse pre/post hooks (matchers are CLI-only optimization;
// pipeline must be correct when every tool fires these).
export const COPILOT_EVENTS: { event: string; subcommand: string }[] = [
  { event: 'SessionStart', subcommand: 'session-start' },
  { event: 'UserPromptSubmit', subcommand: 'user-prompt-submit' },
  { event: 'PreToolUse', subcommand: 'before-tool-use' },
  { event: 'PostToolUse', subcommand: 'after-tool-use' },
  { event: 'SubagentStart', subcommand: 'subagent-start' },
];

export interface HookEntry { subcommand: string; statusMessage?: string; }
export interface HookGroup { matcher?: string; entries: HookEntry[]; }

export const SESSION_START: HookGroup = {
  entries: [{ subcommand: 'session-start', statusMessage: 'Checking Traffic One auth...' }],
};

// Codex-only SubagentStart: bind the pending Traffic One role claim to the new
// subagent's thread id (`agent_id`) so the child's later tool-call hooks resolve
// their role by exact session match. Not tool-scoped → no matcher (like SessionStart).
// Hosts that do not emit SubagentStart simply never invoke this command.
export const SUBAGENT_START: HookGroup = {
  entries: [{ subcommand: 'subagent-start' }],
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
    matcher: 'Bash|Write|Edit|MultiEdit|Read|LS|Glob|Grep|exec_command|apply_patch|Task|Agent|spawn_agent|followup_task|send_message|send_input|wait_agent|multi_tool_use',
    entries: [{ subcommand: 'check-onboarding-gate', statusMessage: 'Checking onboarding gate...' }],
  },
  {
    matcher: 'Bash|Write|Edit|MultiEdit|Read|LS|Glob|Grep|exec_command|apply_patch|Task|Agent|spawn_agent|followup_task|send_message|send_input|wait_agent|multi_tool_use',
    entries: [{ subcommand: 'check-model-choice-gate', statusMessage: 'Checking model choice gate...' }],
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
    // Record the spawned agent id per role (agents.json) so the reuse gate can
    // route the role's next task to the SAME agent instead of a fresh spawn.
    matcher: 'Task|Agent|spawn_agent',
    entries: [{ subcommand: 'post-agent-spawned' }],
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
  // Generic tool hooks (fire for ALL tool types). The cursor adapter derives the
  // tool class from the payload tool_name and excludes classes the fixed events
  // above already own, so no gate double-fires. These close the pre-WRITE deny, the
  // pre-search graphify hint, and the spawn-agent model-tier gate on Cursor.
  { event: 'preToolUse', subcommand: 'before-tool-use' },
  { event: 'postToolUse', subcommand: 'after-tool-use' },
  { event: 'subagentStart', subcommand: 'subagent-start' },
];

export const WINDSURF_EVENTS: { event: string; subcommand: string }[] = [
  { event: 'pre_user_prompt', subcommand: 'pre_user_prompt' },
  { event: 'pre_read_code', subcommand: 'pre_read_code' },
  { event: 'post_read_code', subcommand: 'post_read_code' },
  { event: 'pre_write_code', subcommand: 'pre_write_code' },
  { event: 'pre_run_command', subcommand: 'pre_run_command' },
  { event: 'pre_mcp_tool_use', subcommand: 'pre_mcp_tool_use' },
  { event: 'post_write_code', subcommand: 'post_write_code' },
  { event: 'post_run_command', subcommand: 'post_run_command' },
  { event: 'post_mcp_tool_use', subcommand: 'post_mcp_tool_use' },
];
