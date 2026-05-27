'use strict';

const { nowIso, stampRemoteCheck, isRemoteAuthRejection, errorMessage } = require('./_helpers.cjs');

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function readAuthState(...args) {
  return require('./readAuthState.cjs').readAuthState(...args);
}
function authStateFreshness(...args) {
  return require('./authStateFreshness.cjs').authStateFreshness(...args);
}
function refresh(...args) {
  return require('./refresh.cjs').refresh(...args);
}
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}
function endpointFromEnv(...args) {
  return require('./endpointFromEnv.cjs').endpointFromEnv(...args);
}
function mcpRequest(...args) {
  return require('./mcpRequest.cjs').mcpRequest(...args);
}
function deleteAuthState(...args) {
  return require('./deleteAuthState.cjs').deleteAuthState(...args);
}

async function status(args = process.argv.slice(3), env = process.env) {
  const state = readAuthState(env);
  const freshness = authStateFreshness(state, env);
  if (!freshness.fresh) {
    const localReason = freshness.reason;
    if (state) {
      return refresh(args, env, { priorReason: localReason });
    }
    return {
      ok: false,
      authenticated: false,
      reason: localReason,
      filePath: authStatePath(env),
      endpoint: endpointFromEnv(env),
    };
  }
  if (!args.includes('--remote')) {
    return {
      ok: true,
      authenticated: true,
      keyId: state.keyId,
      expiresAt: state.expiresAt,
      endpoint: state.endpoint,
      filePath: authStatePath(env),
    };
  }
  let result;
  try {
    result = await mcpRequest(state.endpoint, 'auth_status', state.sessionToken, {});
  } catch (error) {
    if (isRemoteAuthRejection(error)) {
      const refreshed = await refresh(args, env, { priorReason: 'remote-auth-rejected' });
      if (refreshed.ok) return { ...refreshed, remoteChecked: true };
      deleteAuthState(env);
      return refreshed;
    }
    stampRemoteCheck(state, {
      lastRemoteCheckError: error.message,
    }, env);
    return {
      ok: false,
      authenticated: true,
      localAuthenticated: true,
      remoteChecked: false,
      reason: 'remote-check-failed',
      error: errorMessage(error),
      keyId: state.keyId,
      expiresAt: state.expiresAt,
      endpoint: state.endpoint,
      filePath: authStatePath(env),
    };
  }
  if (result.authenticated !== true) {
    const refreshed = await refresh(args, env, { priorReason: result.reason || 'remote-auth-rejected' });
    if (refreshed.ok) return { ...refreshed, remoteChecked: true };
    deleteAuthState(env);
    return refreshed;
  }
  if (result.authenticated === true) {
    stampRemoteCheck(state, {
      keyId: result.keyId || state.keyId,
      expiresAt: result.expiresAt || state.expiresAt,
      lastRemoteCheckOkAt: nowIso(),
      lastRemoteCheckError: null,
    }, env);
  }
  return {
    ok: result.authenticated === true,
    authenticated: result.authenticated === true,
    keyId: result.keyId,
    expiresAt: result.expiresAt,
    endpoint: state.endpoint,
    filePath: authStatePath(env),
  };
}

module.exports = { status };
