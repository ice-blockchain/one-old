// src/config/opencode-host.ts
// Pinned OpenCode HOST-integration surface. Keep host paths/tool names here so
// future OpenCode CLI churn is a config update instead of scattered literals.

export const OPENCODE_HOST_PACKAGE = 'opencode-ai';
// Host plugin-hook contract target. The contract is verified identical across
// 1.15.13–1.17.11, and file plugins skip OpenCode's version-compat gate, so this
// is the documented/reported target, not a load constraint. (Distinct from the
// delegation CLI pin in toolchain-versions.json, which stays at its own version.)
export const OPENCODE_HOST_TARGET_VERSION = '1.17.11';

export const OPENCODE_HOST_GLOBAL_CONFIG_DIR_REL = '.config/opencode';
export const OPENCODE_HOST_GLOBAL_CONFIG_FILES = ['opencode.jsonc', 'opencode.json', 'config.json'] as const;
export const OPENCODE_HOST_GLOBAL_CONFIG_DEFAULT_FILE = OPENCODE_HOST_GLOBAL_CONFIG_FILES[0];
export const OPENCODE_HOST_GLOBAL_PLUGINS_REL = 'plugins';
export const OPENCODE_HOST_GLOBAL_PLUGIN_FILE = 'traffic-one.js';
export const OPENCODE_HOST_GLOBAL_PLUGIN_ID = 'traffic-one';

export const OPENCODE_HOOK_TOOL_BEFORE = 'tool.execute.before';
export const OPENCODE_HOOK_TOOL_AFTER = 'tool.execute.after';
export const OPENCODE_HOOK_CHAT_MESSAGE = 'chat.message';
export const OPENCODE_HOOK_SYSTEM_TRANSFORM = 'experimental.chat.system.transform';

const OPENCODE_HOST_PROJECT_DIR = '.opencode';
export const OPENCODE_HOST_AGENTS_DIR = 'agents';
const OPENCODE_HOST_SKILLS_DIR = 'skills';
const OPENCODE_HOST_PROJECT_MARKER_FILE = 'traffic-one.json';
export const OPENCODE_HOST_AGENTS_REL = `${OPENCODE_HOST_PROJECT_DIR}/${OPENCODE_HOST_AGENTS_DIR}`;
export const OPENCODE_HOST_SKILLS_REL = `${OPENCODE_HOST_PROJECT_DIR}/${OPENCODE_HOST_SKILLS_DIR}`;
export const OPENCODE_HOST_PROJECT_MARKER_REL = `${OPENCODE_HOST_PROJECT_DIR}/${OPENCODE_HOST_PROJECT_MARKER_FILE}`;

export const OPENCODE_TOOL_BASH = 'bash';
export const OPENCODE_TOOL_WRITE = 'write';
export const OPENCODE_TOOL_EDIT = 'edit';
export const OPENCODE_TOOL_READ = 'read';
export const OPENCODE_TOOL_GREP = 'grep';
export const OPENCODE_TOOL_GLOB = 'glob';
export const OPENCODE_TOOL_PATCH = 'apply_patch';
export const OPENCODE_TOOL_TASK = 'task';

export const OPENCODE_HOST_TOOL_NAMES = [
  OPENCODE_TOOL_BASH,
  OPENCODE_TOOL_WRITE,
  OPENCODE_TOOL_EDIT,
  OPENCODE_TOOL_READ,
  OPENCODE_TOOL_GREP,
  OPENCODE_TOOL_GLOB,
  OPENCODE_TOOL_PATCH,
  OPENCODE_TOOL_TASK,
] as const;
