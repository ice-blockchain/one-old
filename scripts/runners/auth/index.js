"use strict";
// src/runners/auth/index.ts
// CLI entry + public surface for the Traffic One auth client (compiles to
// scripts/traffic-one-auth.cjs). Dispatches login/refresh/status/logout and
// re-exports the read side (shared/auth) + the write/network/credential side
// (this runner) so existing `require('.../traffic-one-auth.cjs')` call sites
// keep working. Ported 1:1 from scripts/traffic-one-auth.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.status = exports.refresh = exports.logout = exports.login = exports.currentSessionToken = exports.writeAuthState = exports.deleteAuthState = exports.mcpRequest = exports.buildMcpPayload = exports.storeCredential = exports.readCredential = exports.deleteCredential = exports.credentialStoreKind = exports.credentialRefFor = exports.deleteAuthChoiceState = exports.authChoiceStatePaths = exports.authChoiceStatePath = exports.readAuthState = exports.isTrafficOneDoctorCommand = exports.isTrafficOneAuthCommand = exports.isAuthStateFresh = exports.isAuthenticatedLocal = exports.endpointFromEnv = exports.authStatePath = exports.authRequiredMessage = exports.authRemoteCheckDue = exports.authStateFreshness = exports.authEndpointUrl = exports.REMOTE_AUTH_CHECK_INTERVAL_MS = exports.FRESHNESS_REASON = exports.DEFAULT_ENDPOINT = exports.AUTH_STATE_VERSION = void 0;
exports.main = main;
const commands_1 = require("./commands");
// ── Public surface ───────────────────────────────────────────────────────────
var auth_1 = require("../../shared/auth");
Object.defineProperty(exports, "AUTH_STATE_VERSION", { enumerable: true, get: function () { return auth_1.AUTH_STATE_VERSION; } });
Object.defineProperty(exports, "DEFAULT_ENDPOINT", { enumerable: true, get: function () { return auth_1.DEFAULT_ENDPOINT; } });
Object.defineProperty(exports, "FRESHNESS_REASON", { enumerable: true, get: function () { return auth_1.FRESHNESS_REASON; } });
Object.defineProperty(exports, "REMOTE_AUTH_CHECK_INTERVAL_MS", { enumerable: true, get: function () { return auth_1.REMOTE_AUTH_CHECK_INTERVAL_MS; } });
Object.defineProperty(exports, "authEndpointUrl", { enumerable: true, get: function () { return auth_1.authEndpointUrl; } });
Object.defineProperty(exports, "authStateFreshness", { enumerable: true, get: function () { return auth_1.authStateFreshness; } });
Object.defineProperty(exports, "authRemoteCheckDue", { enumerable: true, get: function () { return auth_1.authRemoteCheckDue; } });
Object.defineProperty(exports, "authRequiredMessage", { enumerable: true, get: function () { return auth_1.authRequiredMessage; } });
Object.defineProperty(exports, "authStatePath", { enumerable: true, get: function () { return auth_1.authStatePath; } });
Object.defineProperty(exports, "endpointFromEnv", { enumerable: true, get: function () { return auth_1.endpointFromEnv; } });
Object.defineProperty(exports, "isAuthenticatedLocal", { enumerable: true, get: function () { return auth_1.isAuthenticatedLocal; } });
Object.defineProperty(exports, "isAuthStateFresh", { enumerable: true, get: function () { return auth_1.isAuthStateFresh; } });
Object.defineProperty(exports, "isTrafficOneAuthCommand", { enumerable: true, get: function () { return auth_1.isTrafficOneAuthCommand; } });
Object.defineProperty(exports, "isTrafficOneDoctorCommand", { enumerable: true, get: function () { return auth_1.isTrafficOneDoctorCommand; } });
Object.defineProperty(exports, "readAuthState", { enumerable: true, get: function () { return auth_1.readAuthState; } });
var auth_choice_1 = require("../../modules/session/auth-choice");
Object.defineProperty(exports, "authChoiceStatePath", { enumerable: true, get: function () { return auth_choice_1.authChoiceStatePath; } });
Object.defineProperty(exports, "authChoiceStatePaths", { enumerable: true, get: function () { return auth_choice_1.authChoiceStatePaths; } });
Object.defineProperty(exports, "deleteAuthChoiceState", { enumerable: true, get: function () { return auth_choice_1.deleteAuthChoiceState; } });
var credential_store_1 = require("./credential-store");
Object.defineProperty(exports, "credentialRefFor", { enumerable: true, get: function () { return credential_store_1.credentialRefFor; } });
Object.defineProperty(exports, "credentialStoreKind", { enumerable: true, get: function () { return credential_store_1.credentialStoreKind; } });
Object.defineProperty(exports, "deleteCredential", { enumerable: true, get: function () { return credential_store_1.deleteCredential; } });
Object.defineProperty(exports, "readCredential", { enumerable: true, get: function () { return credential_store_1.readCredential; } });
Object.defineProperty(exports, "storeCredential", { enumerable: true, get: function () { return credential_store_1.storeCredential; } });
var mcp_client_1 = require("./mcp-client");
Object.defineProperty(exports, "buildMcpPayload", { enumerable: true, get: function () { return mcp_client_1.buildMcpPayload; } });
Object.defineProperty(exports, "mcpRequest", { enumerable: true, get: function () { return mcp_client_1.mcpRequest; } });
var lib_1 = require("./lib");
Object.defineProperty(exports, "deleteAuthState", { enumerable: true, get: function () { return lib_1.deleteAuthState; } });
Object.defineProperty(exports, "writeAuthState", { enumerable: true, get: function () { return lib_1.writeAuthState; } });
var commands_2 = require("./commands");
Object.defineProperty(exports, "currentSessionToken", { enumerable: true, get: function () { return commands_2.currentSessionToken; } });
Object.defineProperty(exports, "login", { enumerable: true, get: function () { return commands_2.login; } });
Object.defineProperty(exports, "logout", { enumerable: true, get: function () { return commands_2.logout; } });
Object.defineProperty(exports, "refresh", { enumerable: true, get: function () { return commands_2.refresh; } });
Object.defineProperty(exports, "status", { enumerable: true, get: function () { return commands_2.status; } });
async function main() {
    const command = process.argv[2] || 'status';
    let result;
    if (command === 'login') {
        result = await (0, commands_1.login)();
    }
    else if (command === 'refresh') {
        result = await (0, commands_1.refresh)();
    }
    else if (command === 'status') {
        result = await (0, commands_1.status)();
    }
    else if (command === 'logout') {
        result = await (0, commands_1.logout)();
    }
    else {
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
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
