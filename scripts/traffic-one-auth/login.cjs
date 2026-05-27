'use strict';

const { keyFromArgs, isRemoteAuthRejection, errorMessage, writeSessionResult } = require('./_helpers.cjs');

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function endpointFromEnv(...args) {
  return require('./endpointFromEnv.cjs').endpointFromEnv(...args);
}
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}
function mcpRequest(...args) {
  return require('./mcpRequest.cjs').mcpRequest(...args);
}

async function login(args = process.argv.slice(3), env = process.env) {
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  const apiKey = keyFromArgs(args, env);
  if (!apiKey) {
    return {
      ok: false,
      authenticated: false,
      reason: 'missing-api-key',
      detail: 'Set TRAFFIC_ONE_AUTH_KEY or pass --stdin.',
      endpoint,
      filePath,
    };
  }
  let result;
  try {
    result = await mcpRequest(endpoint, 'authenticate', apiKey, {});
  } catch (error) {
    // Never fail silently: report which endpoint we tried and why it failed so
    // a wrong/unreachable endpoint (e.g. a stale plugin version) is obvious.
    return {
      ok: false,
      authenticated: false,
      reason: isRemoteAuthRejection(error) ? 'invalid-api-key' : 'auth-endpoint-unreachable',
      endpoint,
      filePath,
      error: errorMessage(error),
      ...(error.statusCode ? { statusCode: error.statusCode } : {}),
    };
  }
  try {
    const { state, filePath: written } = writeSessionResult(endpoint, result, env);
    return { ok: true, authenticated: true, filePath: written, keyId: state.keyId, expiresAt: state.expiresAt, endpoint };
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      reason: 'invalid-auth-response',
      endpoint,
      filePath,
      error: errorMessage(error),
    };
  }
}

module.exports = { login };
