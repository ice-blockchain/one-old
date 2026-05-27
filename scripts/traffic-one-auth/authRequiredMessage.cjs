'use strict';

const path = require('path');

// DEPTH RULE: in the original entry, `__filename` resolved to the CLI script
// `scripts/traffic-one-auth.cjs`. Moving this body one directory deeper would
// otherwise point `__filename` at this file. Consumers and tests assert the
// entry's absolute path, so the two `${__filename}` path interpolations below
// are adjusted to this constant, preserving the original resolved value while
// the rest of the body stays verbatim.
const ENTRY_FILENAME = path.resolve(__dirname, '..', 'traffic-one-auth.cjs');

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function endpointFromEnv(...args) {
  return require('./endpointFromEnv.cjs').endpointFromEnv(...args);
}
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}

function authRequiredMessage(env = process.env) {
  const endpoint = endpointFromEnv(env);
  return [
    'Traffic One authentication is required before this plugin can be used.',
    '',
    'Ask the user with a modal selector before continuing:',
    '  - Authenticate Traffic One (Recommended)',
    '  - Continue without Traffic One',
    '',
    'If the user chooses Authenticate Traffic One, ask for the API key using a secure host input/modal and stop. When the user submits the key, the hook runs login + status internally and stores the API key in the OS credential manager when available.',
    'Do NOT call the exposed mcp-auth MCP tools (`mcp__mcp_auth__auth_status`, `mcp__mcp_auth__refresh`, `mcp__mcp_auth__authenticate`, or `mcp__mcp_auth__logout`) for routine auth gate checks. The hook/auth client performs status and refresh silently behind the scenes.',
    `Hook-internal script: ${ENTRY_FILENAME}. Do not run it yourself, do not use a cwd-relative path, and do not search the filesystem for a copy; a found copy may be stale or point at an outdated endpoint.`,
    'If a stored session expires, the auth client will try `refresh` with the OS credential manager key.',
    'Do not ask the user to run bash or shell commands for Traffic One authentication.',
    'If the user chooses Continue without Traffic One, remember that choice for the current project while it remains active and continue without Traffic One features.',
    `Endpoint: ${endpoint}`,
    `Script: ${ENTRY_FILENAME}`,
    `Auth state: ${authStatePath(env)}`,
  ].join('\n');
}

module.exports = { authRequiredMessage };
