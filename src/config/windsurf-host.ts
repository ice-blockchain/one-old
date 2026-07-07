// src/config/windsurf-host.ts
// Pinned Windsurf / Devin Desktop Cascade integration paths and hook names.

export const WINDSURF_HOST_CONFIG_DIR_REL = '.codeium/windsurf';
export const WINDSURF_HOST_NEXT_CONFIG_DIR_REL = '.codeium/windsurf-next';
export const WINDSURF_HOST_INSIDERS_CONFIG_DIR_REL = '.codeium/windsurf-insiders';
export const WINDSURF_HOST_HOOKS_FILE = 'hooks.json';
export const WINDSURF_HOST_MCP_FILE = 'mcp_config.json';
export const WINDSURF_HOST_GLOBAL_RULES_REL = 'memories/global_rules.md';

export const WINDSURF_HOOK_EVENTS = [
  'pre_user_prompt',
  'pre_read_code',
  'post_read_code',
  'pre_write_code',
  'pre_run_command',
  'pre_mcp_tool_use',
  'post_write_code',
  'post_run_command',
  'post_mcp_tool_use',
] as const;

export type WindsurfHookEvent = (typeof WINDSURF_HOOK_EVENTS)[number];
