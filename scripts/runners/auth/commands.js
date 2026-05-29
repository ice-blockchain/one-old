"use strict";
// src/runners/auth/commands.ts
// The four auth CLI commands: login / refresh / status / logout. Ported 1:1
// from scripts/traffic-one-auth/{login,refresh,status,logout,currentSessionToken}.cjs.
// status/refresh stay silent — they are the hook/auth-client path, not a
// user-facing prompt. All network goes through mcpRequest (injectable-free here;
// tests drive the local/pure branches + a dead-port endpoint).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.currentSessionToken = currentSessionToken;
exports.login = login;
exports.refresh = refresh;
exports.status = status;
exports.logout = logout;
const fs = __importStar(require("fs"));
const auth_1 = require("../../shared/auth");
const auth_choice_1 = require("../../modules/session/auth-choice");
const text_1 = require("../../shared/text");
const credential_store_1 = require("./credential-store");
const lib_1 = require("./lib");
const mcp_client_1 = require("./mcp-client");
function currentSessionToken(env = process.env) {
    const state = (0, auth_1.readAuthState)(env);
    return (0, auth_1.isAuthStateFresh)(state, env) && state ? state.sessionToken : null;
}
async function login(args = process.argv.slice(3), env = process.env, options = {}) {
    const endpoint = (0, auth_1.endpointFromEnv)(env);
    const filePath = (0, auth_1.authStatePath)(env);
    const keyLookup = (0, lib_1.keyLookupFromArgs)(args, env, options);
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
        result = await (0, mcp_client_1.mcpRequest)(endpoint, 'authenticate', apiKey, {});
    }
    catch (error) {
        const e = error;
        return {
            ok: false,
            authenticated: false,
            reason: (0, lib_1.isRemoteAuthRejection)(error) ? 'invalid-api-key' : 'auth-endpoint-unreachable',
            endpoint,
            filePath,
            error: (0, lib_1.errorMessage)(error),
            ...(e.statusCode ? { statusCode: e.statusCode } : {}),
        };
    }
    try {
        const { state, filePath: written, credential } = (0, lib_1.writeSessionResult)(endpoint, result, env, { apiKey });
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
    }
    catch (error) {
        return { ok: false, authenticated: false, reason: 'invalid-auth-response', endpoint, filePath, error: (0, lib_1.errorMessage)(error) };
    }
}
async function refresh(args = process.argv.slice(3), env = process.env, options = {}) {
    const previousState = (0, auth_1.readAuthState)(env);
    const keyLookup = (0, lib_1.keyFromArgsOrCredential)(args, env, previousState, options);
    const apiKey = keyLookup.key;
    const endpoint = (0, auth_1.endpointFromEnv)(env);
    const filePath = (0, auth_1.authStatePath)(env);
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
        result = await (0, mcp_client_1.mcpRequest)(endpoint, 'refresh', apiKey, {});
    }
    catch (error) {
        return {
            ok: false,
            authenticated: false,
            reauthenticated: false,
            reason: 'reauthentication-failed',
            error: (0, lib_1.errorMessage)(error),
            ...(priorReason ? { priorReason } : {}),
            endpoint,
            filePath,
        };
    }
    try {
        const written = (0, lib_1.writeSessionResult)(endpoint, result, env, { apiKey, previousState });
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
    }
    catch (error) {
        return {
            ok: false,
            authenticated: false,
            reauthenticated: false,
            reason: 'reauthentication-failed',
            error: (0, lib_1.errorMessage)(error),
            ...(priorReason ? { priorReason } : {}),
            endpoint,
            filePath,
        };
    }
}
// ── Silent-refresh-with-backoff (the invisible refresh path) ──────────────────
// A stale/expired session re-mints itself from the keychain key. Transient
// failures retry invisibly with exponential backoff; only after MORE than
// REFRESH_FAILURE_THRESHOLD consecutive failures does the caller surface a
// re-auth prompt. The session token + credentialRef are preserved across
// failures, so the gate keeps working in the meantime and an exhausted state
// still reads as a re-authentication (not a first-time login).
function graceAuthenticated(state, env) {
    return {
        ok: true,
        authenticated: true,
        refreshPending: true,
        refreshFailures: (0, auth_1.refreshFailureCount)(state),
        keyId: state.keyId,
        expiresAt: state.expiresAt,
        endpoint: state.endpoint,
        filePath: (0, auth_1.authStatePath)(env),
    };
}
function reauthRequired(state, priorReason, env) {
    return {
        ok: false,
        authenticated: false,
        reason: 'reauthentication-required',
        priorReason: priorReason || 'session-refresh-exhausted',
        refreshFailures: (0, auth_1.refreshFailureCount)(state),
        endpoint: (0, auth_1.endpointFromEnv)(env),
        filePath: (0, auth_1.authStatePath)(env),
    };
}
async function silentRefreshWithBackoff(args, env, state, priorReason) {
    if ((0, auth_1.refreshAttemptsExhausted)(state))
        return reauthRequired(state, priorReason, env);
    if ((0, auth_1.refreshBackoffActive)(state))
        return graceAuthenticated(state, env);
    const refreshed = await refresh(args, env, { priorReason });
    if (refreshed.ok)
        return refreshed; // success writes a fresh state → counter reset
    const rec = (0, lib_1.recordRefreshFailure)(state, env);
    const current = (0, auth_1.readAuthState)(env) || state;
    return rec.exhausted ? reauthRequired(current, priorReason, env) : graceAuthenticated(current, env);
}
async function status(args = process.argv.slice(3), env = process.env) {
    const state = (0, auth_1.readAuthState)(env);
    const freshness = (0, auth_1.authStateFreshness)(state, env);
    if (!freshness.fresh) {
        if (!state) {
            return { ok: false, authenticated: false, reason: freshness.reason, filePath: (0, auth_1.authStatePath)(env), endpoint: (0, auth_1.endpointFromEnv)(env) };
        }
        // Stale/expired session → invisible refresh from the keychain key.
        return silentRefreshWithBackoff(args, env, state, freshness.reason);
    }
    const s = state;
    if (!args.includes('--remote')) {
        return { ok: true, authenticated: true, keyId: s.keyId, expiresAt: s.expiresAt, endpoint: s.endpoint, filePath: (0, auth_1.authStatePath)(env) };
    }
    let result;
    try {
        result = await (0, mcp_client_1.mcpRequest)(String(s.endpoint), 'auth_status', String(s.sessionToken), {});
    }
    catch (error) {
        if ((0, lib_1.isRemoteAuthRejection)(error)) {
            return { ...(await silentRefreshWithBackoff(args, env, s, 'remote-auth-rejected')), remoteChecked: true };
        }
        // Transient network error on a locally-fresh session: not a refresh failure —
        // stay locally authenticated, no counter, no prompt.
        (0, lib_1.stampRemoteCheck)(s, { lastRemoteCheckError: (0, lib_1.errorMessage)(error) }, env);
        return {
            ok: false,
            authenticated: true,
            localAuthenticated: true,
            remoteChecked: false,
            reason: 'remote-check-failed',
            error: (0, lib_1.errorMessage)(error),
            keyId: s.keyId,
            expiresAt: s.expiresAt,
            endpoint: s.endpoint,
            filePath: (0, auth_1.authStatePath)(env),
        };
    }
    if (result.authenticated !== true) {
        return { ...(await silentRefreshWithBackoff(args, env, s, result.reason || 'remote-auth-rejected')), remoteChecked: true };
    }
    (0, lib_1.stampRemoteCheck)(s, {
        keyId: result.keyId || s.keyId,
        expiresAt: result.expiresAt || s.expiresAt,
        lastRemoteCheckOkAt: (0, text_1.nowIsoNoMs)(),
        lastRemoteCheckError: null,
    }, env);
    return { ok: true, authenticated: true, keyId: result.keyId, expiresAt: result.expiresAt, endpoint: s.endpoint, filePath: (0, auth_1.authStatePath)(env) };
}
async function logout(_args = process.argv.slice(3), env = process.env) {
    const state = (0, auth_1.readAuthState)(env);
    const token = currentSessionToken(env);
    const endpoint = (0, auth_1.endpointFromEnv)(env);
    const filePath = (0, auth_1.authStatePath)(env);
    if (token) {
        try {
            await (0, mcp_client_1.mcpRequest)(endpoint, 'logout', token, {}, 5000);
        }
        catch {
            // Stateless server sessions; local deletion is the important part.
        }
    }
    const credentialRef = state && typeof state.credentialRef === 'object' ? state.credentialRef : null;
    const credentialDeleted = (0, credential_store_1.deleteCredential)(credentialRef, env);
    const deleted = (0, lib_1.deleteAuthState)(env);
    const authChoicePath = (0, auth_choice_1.authChoiceStatePath)(env);
    const choiceDeleted = (0, auth_choice_1.deleteAuthChoiceState)(env);
    if (!deleted && fs.existsSync(filePath)) {
        return { ok: false, authenticated: true, reason: 'delete-auth-state-failed', filePath };
    }
    if (!choiceDeleted && (0, auth_choice_1.authChoiceStateExists)(env)) {
        return { ok: false, authenticated: true, reason: 'delete-auth-choice-state-failed', filePath, authChoicePath };
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
