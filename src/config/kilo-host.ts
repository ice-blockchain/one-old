// src/config/kilo-host.ts
// Pinned Kilo host-integration surface. Kilo's server plugin hooks intentionally
// track OpenCode's plugin contract, but paths and install ownership stay separate.

export const KILO_HOST_PACKAGE = 'kilo';
export const KILO_HOST_TARGET_VERSION = 'current';

export const KILO_HOST_GLOBAL_CONFIG_DIR_REL = '.config/kilo';
export const KILO_HOST_GLOBAL_CONFIG_FILES = ['kilo.jsonc', 'kilo.json'] as const;
export const KILO_HOST_GLOBAL_CONFIG_DEFAULT_FILE = KILO_HOST_GLOBAL_CONFIG_FILES[0];
export const KILO_HOST_GLOBAL_PLUGINS_REL = 'plugin';
export const KILO_HOST_GLOBAL_PLUGIN_FILE = 'traffic-one.js';
export const KILO_HOST_GLOBAL_PLUGIN_ID = 'traffic-one';

export const KILO_HOOK_TOOL_BEFORE = 'tool.execute.before';
export const KILO_HOOK_TOOL_AFTER = 'tool.execute.after';
export const KILO_HOOK_CHAT_MESSAGE = 'chat.message';
export const KILO_HOOK_SYSTEM_TRANSFORM = 'experimental.chat.system.transform';
export const KILO_HOOK_SHELL_ENV = 'shell.env';
export const KILO_HOOK_PERMISSION_ASK = 'permission.ask';
export const KILO_HOOK_EVENT = 'event';

export const KILO_HOST_PROJECT_DIR = '.kilo';
export const KILO_HOST_AGENTS_DIR = 'agents';
export const KILO_HOST_PROJECT_MARKER_FILE = 'traffic-one.json';
export const KILO_HOST_AGENTS_REL = `${KILO_HOST_PROJECT_DIR}/${KILO_HOST_AGENTS_DIR}`;
export const KILO_HOST_PROJECT_MARKER_REL = `${KILO_HOST_PROJECT_DIR}/${KILO_HOST_PROJECT_MARKER_FILE}`;

export const KILO_TOOL_BASH = 'bash';
export const KILO_TOOL_WRITE = 'write';
export const KILO_TOOL_EDIT = 'edit';
export const KILO_TOOL_READ = 'read';
export const KILO_TOOL_GREP = 'grep';
export const KILO_TOOL_GLOB = 'glob';
export const KILO_TOOL_PATCH = 'apply_patch';
export const KILO_TOOL_TASK = 'task';

export const KILO_HOST_TOOL_NAMES = [
  KILO_TOOL_BASH,
  KILO_TOOL_WRITE,
  KILO_TOOL_EDIT,
  KILO_TOOL_READ,
  KILO_TOOL_GREP,
  KILO_TOOL_GLOB,
  KILO_TOOL_PATCH,
  KILO_TOOL_TASK,
] as const;
