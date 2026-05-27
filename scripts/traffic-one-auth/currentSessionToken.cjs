'use strict';

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function readAuthState(...args) {
  return require('./readAuthState.cjs').readAuthState(...args);
}
function isAuthStateFresh(...args) {
  return require('./isAuthStateFresh.cjs').isAuthStateFresh(...args);
}

function currentSessionToken(env = process.env) {
  const state = readAuthState(env);
  return isAuthStateFresh(state, env) ? state.sessionToken : null;
}

module.exports = { currentSessionToken };
