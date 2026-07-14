// Last-resort host-wire fallbacks. runPipeline protects failures thrown by a
// handler, while these helpers protect the wider boundary: module discovery,
// adapter parsing, context construction, and serialization. A pre-tool hook must
// never become an empty success merely because the plugin runtime is damaged.

// Shared remediation sentence — interpolated into every fail-closed deny,
// including generated host wrappers (kilo-host), so the prose can't drift.
export const PRE_TOOL_REMEDIATION = 'Run Traffic One doctor or reinstall/update the plugin, then retry.';

export function preToolFailureReason(host: string): string {
  return `Traffic One ${host} pre-tool gate failed before it could make a decision, so this tool call is blocked fail-closed. ${PRE_TOOL_REMEDIATION}`;
}

export function isGatePreToolSubcommand(subcommand: string | undefined): boolean {
  const value = String(subcommand || '');
  return value.startsWith('check-') || value === 'pre-graphify-hint';
}

export function isCursorPreToolSubcommand(subcommand: string | undefined): boolean {
  return new Set(['before-shell-execution', 'before-read-file', 'before-tool-use']).has(String(subcommand || ''));
}

export function isWindsurfPreToolAction(action: string | undefined): boolean {
  return new Set(['pre_read_code', 'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use']).has(String(action || ''));
}

export function nestedPreToolDeny(host: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: preToolFailureReason(host),
    },
  });
}

export function cursorPreToolDeny(): string {
  const reason = preToolFailureReason('Cursor');
  return JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason });
}

export function copilotPreToolDeny(surface: 'cli' | 'vscode'): string {
  const reason = preToolFailureReason('Copilot');
  return surface === 'cli'
    ? JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })
    : nestedPreToolDeny('Copilot');
}

export function wrapperPreToolDeny(host: string): string {
  return JSON.stringify({ kind: 'deny', reason: preToolFailureReason(host) });
}

export function devinPreToolDeny(): string {
  return JSON.stringify({ decision: 'block', reason: preToolFailureReason('Windsurf/Devin') });
}
