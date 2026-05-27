'use strict';

const { AUTH_STATE_VERSION, FRESHNESS_REASON, EXPIRY_SKEW_MS } = require('./_helpers.cjs');

// Hoisted forwarder: resolve the sibling export lazily so a load-time cycle
// never captures a partial module, while the function body stays verbatim.
function endpointFromEnv(...args) {
  return require('./endpointFromEnv.cjs').endpointFromEnv(...args);
}

// Returns the precise reason a stored session is (not) usable. Endpoint mismatch
// is reported ahead of expiry because it signals a configuration problem (the
// token belongs to a different server) rather than the ordinary, recoverable
// "session timed out" case that a refresh with the same key can fix.
function authStateFreshness(state, env = process.env, nowMs = Date.now()) {
  if (!state || typeof state !== 'object') {
    return { fresh: false, reason: FRESHNESS_REASON.MISSING };
  }
  if (state.version !== AUTH_STATE_VERSION) {
    return { fresh: false, reason: FRESHNESS_REASON.VERSION_MISMATCH };
  }
  if (typeof state.sessionToken !== 'string' || !state.sessionToken.startsWith('tok_')) {
    return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_TOKEN };
  }
  if (typeof state.expiresAt !== 'string') {
    return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_EXPIRY };
  }
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires)) {
    return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_EXPIRY };
  }
  if (state.endpoint !== endpointFromEnv(env)) {
    return { fresh: false, reason: FRESHNESS_REASON.ENDPOINT_MISMATCH };
  }
  if (expires - EXPIRY_SKEW_MS <= nowMs) {
    return { fresh: false, reason: FRESHNESS_REASON.EXPIRED };
  }
  return { fresh: true, reason: FRESHNESS_REASON.OK };
}

module.exports = { authStateFreshness };
