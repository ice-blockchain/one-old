'use strict';

const { keyLookupFromArgs, isRemoteAuthRejection, errorMessage, writeSessionResult } = require('./_helpers.cjs');

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

async function login(args = process.argv.slice(3), env = process.env, options = {}) {
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  const keyLookup = keyLookupFromArgs(args, env, options);
  const apiKey = keyLookup.key;
  if (!apiKey) {
    return {
      ok: false,
      authenticated: false,
      reason: 'missing-api-key',
      detail: 'Pass the key through secure input/stdin.',
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
    const { state, filePath: written, credential } = writeSessionResult(endpoint, result, env, { apiKey });
    return {
      ok: true,
      authenticated: true,
      filePath: written,
      keyId: state.keyId,
      expiresAt: state.expiresAt,
      endpoint,
      keySource: keyLookup.source,
      credentialStored: credential && credential.ok === true && credential.stored === true,
      ...(credential && credential.store ? { credentialStore: credential.store } : {}),
      ...(credential && credential.ok === false ? { credentialStoreReason: credential.reason || 'credential-store-failed' } : {}),
    };
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
