#!/usr/bin/env node
'use strict';

const {
  AUTH_STATE_VERSION,
  DEFAULT_ENDPOINT,
  FRESHNESS_REASON,
  REMOTE_AUTH_CHECK_INTERVAL_MS,
} = require('./traffic-one-auth/_helpers.cjs');
const { authEndpointUrl } = require('./traffic-one-auth/authEndpointUrl.cjs');
const { authStateFreshness } = require('./traffic-one-auth/authStateFreshness.cjs');
const { authChoiceStatePath } = require('./traffic-one-auth/authChoiceStatePath.cjs');
const { authChoiceStatePaths } = require('./traffic-one-auth/authChoiceStatePaths.cjs');
const { authRemoteCheckDue } = require('./traffic-one-auth/authRemoteCheckDue.cjs');
const { authRequiredMessage } = require('./traffic-one-auth/authRequiredMessage.cjs');
const { authStatePath } = require('./traffic-one-auth/authStatePath.cjs');
const { buildMcpPayload } = require('./traffic-one-auth/buildMcpPayload.cjs');
const {
  credentialRefFor,
  credentialStoreKind,
  deleteCredential,
  readCredential,
  storeCredential,
} = require('./traffic-one-auth/credentialStore.cjs');
const { currentSessionToken } = require('./traffic-one-auth/currentSessionToken.cjs');
const { deleteAuthChoiceState } = require('./traffic-one-auth/deleteAuthChoiceState.cjs');
const { deleteAuthState } = require('./traffic-one-auth/deleteAuthState.cjs');
const { endpointFromEnv } = require('./traffic-one-auth/endpointFromEnv.cjs');
const { isAuthenticatedLocal } = require('./traffic-one-auth/isAuthenticatedLocal.cjs');
const { isAuthStateFresh } = require('./traffic-one-auth/isAuthStateFresh.cjs');
const { isTrafficOneAuthCommand } = require('./traffic-one-auth/isTrafficOneAuthCommand.cjs');
const { isTrafficOneDoctorCommand } = require('./traffic-one-auth/isTrafficOneDoctorCommand.cjs');
const { login } = require('./traffic-one-auth/login.cjs');
const { refresh } = require('./traffic-one-auth/refresh.cjs');
const { logout } = require('./traffic-one-auth/logout.cjs');
const { mcpRequest } = require('./traffic-one-auth/mcpRequest.cjs');
const { readAuthState } = require('./traffic-one-auth/readAuthState.cjs');
const { status } = require('./traffic-one-auth/status.cjs');
const { writeAuthState } = require('./traffic-one-auth/writeAuthState.cjs');

async function main() {
  const command = process.argv[2] || 'status';
  let result;
  if (command === 'login') {
    result = await login();
  } else if (command === 'refresh') {
    result = await refresh();
  } else if (command === 'status') {
    result = await status();
  } else if (command === 'logout') {
    result = await logout();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result && result.authenticated === false && command === 'status') {
    process.exitCode = 1;
  }
  if (result && result.ok === false) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  AUTH_STATE_VERSION,
  DEFAULT_ENDPOINT,
  FRESHNESS_REASON,
  REMOTE_AUTH_CHECK_INTERVAL_MS,
  authEndpointUrl,
  authStateFreshness,
  authChoiceStatePath,
  authChoiceStatePaths,
  authRemoteCheckDue,
  authRequiredMessage,
  authStatePath,
  buildMcpPayload,
  credentialRefFor,
  credentialStoreKind,
  deleteCredential,
  readCredential,
  storeCredential,
  currentSessionToken,
  deleteAuthChoiceState,
  deleteAuthState,
  endpointFromEnv,
  isAuthenticatedLocal,
  isAuthStateFresh,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
  login,
  refresh,
  logout,
  mcpRequest,
  readAuthState,
  status,
  writeAuthState,
};
