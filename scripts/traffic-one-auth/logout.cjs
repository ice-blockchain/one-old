'use strict';

const fs = require('fs');

const { authChoiceStateExists } = require('./_helpers.cjs');
const { deleteCredential } = require('./credentialStore.cjs');

// Hoisted forwarders: resolve sibling exports lazily so a load-time cycle never
// captures a partial module, while the function body stays verbatim.
function currentSessionToken(...args) {
  return require('./currentSessionToken.cjs').currentSessionToken(...args);
}
function endpointFromEnv(...args) {
  return require('./endpointFromEnv.cjs').endpointFromEnv(...args);
}
function authStatePath(...args) {
  return require('./authStatePath.cjs').authStatePath(...args);
}
function mcpRequest(...args) {
  return require('./mcpRequest.cjs').mcpRequest(...args);
}
function deleteAuthState(...args) {
  return require('./deleteAuthState.cjs').deleteAuthState(...args);
}
function authChoiceStatePath(...args) {
  return require('./authChoiceStatePath.cjs').authChoiceStatePath(...args);
}
function deleteAuthChoiceState(...args) {
  return require('./deleteAuthChoiceState.cjs').deleteAuthChoiceState(...args);
}
function readAuthState(...args) {
  return require('./readAuthState.cjs').readAuthState(...args);
}

async function logout(_args = process.argv.slice(3), env = process.env) {
  const state = readAuthState(env);
  const token = currentSessionToken(env);
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  if (token) {
    try {
      await mcpRequest(endpoint, 'logout', token, {}, 5000);
    } catch {
      // Stateless server sessions; local deletion is the important part.
    }
  }
  const credentialDeleted = deleteCredential(state && state.credentialRef, env);
  const deleted = deleteAuthState(env);
  const authChoicePath = authChoiceStatePath(env);
  const choiceDeleted = deleteAuthChoiceState(env);
  if (!deleted && fs.existsSync(filePath)) {
    return {
      ok: false,
      authenticated: true,
      reason: 'delete-auth-state-failed',
      filePath,
    };
  }
  if (!choiceDeleted && authChoiceStateExists(env)) {
    return {
      ok: false,
      authenticated: true,
      reason: 'delete-auth-choice-state-failed',
      filePath,
      authChoicePath,
    };
  }
  return {
    ok: true,
    authenticated: false,
    filePath,
    authChoicePath,
    credentialDeleted: credentialDeleted.deleted === true,
    ...(credentialDeleted.store ? { credentialStore: credentialDeleted.store } : {}),
  };
}

module.exports = { logout };
