'use strict';

const { keyFromArgs, errorMessage, writeSessionResult } = require('./_helpers.cjs');

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

async function refresh(args = process.argv.slice(3), env = process.env, options = {}) {
  const apiKey = keyFromArgs(args, env);
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  const priorReason = options.priorReason || null;
  if (!apiKey) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-not-possible',
      detail: 'missing-api-key',
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
    const written = writeSessionResult(endpoint, result, env);
    return {
      ok: true,
      authenticated: true,
      reauthenticated: true,
      ...(priorReason ? { priorReason } : {}),
      filePath: written.filePath,
      keyId: written.state.keyId,
      expiresAt: written.state.expiresAt,
      endpoint,
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
