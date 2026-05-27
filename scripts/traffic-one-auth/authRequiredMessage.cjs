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
    'If the user chooses Authenticate Traffic One, ask for the API key and run authentication internally with TRAFFIC_ONE_AUTH_KEY, then verify status internally.',
    `Internally means: invoke THIS script at its absolute path via your own shell tool with TRAFFIC_ONE_AUTH_KEY=<key> in env — \`node "${ENTRY_FILENAME}" login\` then \`node "${ENTRY_FILENAME}" status\`. The pre-tool gate explicitly allows these scripts/traffic-one-auth.cjs (login|refresh|status|logout) shell invocations even while unauthenticated, so they will not be denied. Do NOT use a cwd-relative path and do NOT search the filesystem for the script — a found copy may be a stale cached plugin version pointing at an outdated endpoint. Do not try to Write or Edit auth.json directly; only the script can produce a valid session token.`,
    'If a stored session expires and TRAFFIC_ONE_AUTH_KEY is still available, the auth client will try `refresh` before requiring a new key.',
    'Do not ask the user to run bash or shell commands for Traffic One authentication.',
    'If the user chooses Continue without Traffic One, remember that choice for the current project while it remains active and continue without Traffic One features.',
    `Endpoint: ${endpoint}`,
    `Script: ${ENTRY_FILENAME}`,
    `Auth state: ${authStatePath(env)}`,
  ].join('\n');
}

module.exports = { authRequiredMessage };
