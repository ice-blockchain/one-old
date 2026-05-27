'use strict';

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function authStateFreshness(...args) {
  return require('./authStateFreshness.cjs').authStateFreshness(...args);
}

function isAuthStateFresh(state, env = process.env, nowMs = Date.now()) {
  return authStateFreshness(state, env, nowMs).fresh;
}

module.exports = { isAuthStateFresh };
