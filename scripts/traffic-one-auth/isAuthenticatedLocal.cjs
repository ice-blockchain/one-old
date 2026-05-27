'use strict';

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function isAuthStateFresh(...args) {
  return require('./isAuthStateFresh.cjs').isAuthStateFresh(...args);
}
function readAuthState(...args) {
  return require('./readAuthState.cjs').readAuthState(...args);
}

function isAuthenticatedLocal(env = process.env, nowMs = Date.now()) {
  return isAuthStateFresh(readAuthState(env), env, nowMs);
}

module.exports = { isAuthenticatedLocal };
