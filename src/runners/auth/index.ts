// src/runners/auth/index.ts
// CLI entry + public surface for the Traffic One auth client (compiles to
// scripts/traffic-one-auth.cjs). Dispatches login/refresh/status/logout and
// re-exports the read side (shared/auth) + the write/network/credential side
// (this runner) so existing `require('.../traffic-one-auth.cjs')` call sites
// keep working. Ported 1:1 from scripts/traffic-one-auth.cjs.

import { login, logout, refresh, status } from './commands';

// ── Public surface ───────────────────────────────────────────────────────────
export {
  AUTH_STATE_VERSION,
  DEFAULT_ENDPOINT,
  FRESHNESS_REASON,
  REMOTE_AUTH_CHECK_INTERVAL_MS,
} from '../../config/auth';
export {
  authEndpointUrl,
  authStateFreshness,
  authRemoteCheckDue,
  authRequiredMessage,
  authStatePath,
  endpointFromEnv,
  isAuthenticatedLocal,
  isAuthStateFresh,
  isTrafficOneAuthCommand,
  isTrafficOneDoctorCommand,
  readAuthState,
} from '../../shared/auth';
export { authChoiceStatePath, authChoiceStatePaths, deleteAuthChoiceState } from '../../modules/session/auth-choice';
export { credentialRefFor, credentialStoreKind, deleteCredential, readCredential, storeCredential } from './credential-store';
export type { CredentialRef, CredentialResult } from './credential-store';
export { buildMcpPayload, mcpRequest } from './mcp-client';
export { deleteAuthState, writeAuthState } from './lib';
export { currentSessionToken, login, logout, refresh, status } from './commands';

export async function main(): Promise<void> {
  const command = process.argv[2] || 'status';
  let result: Record<string, unknown>;
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
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
