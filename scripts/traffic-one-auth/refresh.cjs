'use strict';

const { keyFromArgsOrCredential, errorMessage, writeSessionResult } = require('./_helpers.cjs');

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function endpointFromEnv(...args) {
  return require('./endpointFromEnv.cjs').endpointFromEnv(...args);
}
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}
function readAuthState(...args) {
  return require('./readAuthState.cjs').readAuthState(...args);
}
function mcpRequest(...args) {
  return require('./mcpRequest.cjs').mcpRequest(...args);
}

async function refresh(args = process.argv.slice(3), env = process.env, options = {}) {
  const previousState = readAuthState(env);
  const keyLookup = keyFromArgsOrCredential(args, env, previousState, options);
  const apiKey = keyLookup.key;
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  const priorReason = options.priorReason || null;
  if (!apiKey) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-not-possible',
      detail: keyLookup.reason || 'missing-api-key',
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }

  let result;
  try {
    result = await mcpRequest(endpoint, 'refresh', apiKey, {});
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-failed',
      error: errorMessage(error),
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }

  try {
    const written = writeSessionResult(endpoint, result, env, { apiKey, previousState });
    return {
      ok: true,
      authenticated: true,
      reauthenticated: true,
      ...(priorReason ? { priorReason } : {}),
      filePath: written.filePath,
      keyId: written.state.keyId,
      expiresAt: written.state.expiresAt,
      endpoint,
      keySource: keyLookup.source,
      credentialStored: written.credential && written.credential.ok === true && written.credential.stored === true,
      ...(written.credential && written.credential.store ? { credentialStore: written.credential.store } : {}),
      ...(written.credential && written.credential.ok === false ? { credentialStoreReason: written.credential.reason || 'credential-store-failed' } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-failed',
      error: errorMessage(error),
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }
}

module.exports = { refresh };
