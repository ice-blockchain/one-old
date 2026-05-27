'use strict';

const { REMOTE_AUTH_CHECK_INTERVAL_MS } = require('./_helpers.cjs');

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function readAuthState(...args) {
  return require('./readAuthState.cjs').readAuthState(...args);
}
function isAuthStateFresh(...args) {
  return require('./isAuthStateFresh.cjs').isAuthStateFresh(...args);
}

function authRemoteCheckDue(state = readAuthState(), env = process.env, nowMs = Date.now()) {
  if (!isAuthStateFresh(state, env, nowMs)) return false;
  const lastChecked = Date.parse(state.lastRemoteCheckedAt || '');
  return !Number.isFinite(lastChecked) || nowMs - lastChecked >= REMOTE_AUTH_CHECK_INTERVAL_MS;
}

module.exports = { authRemoteCheckDue };
