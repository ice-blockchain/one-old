"use strict";
// src/runners/auth/lib.ts
// Auth state write side + key resolution + session-result persistence for the
// Traffic One auth CLI. The read side (paths, freshness, endpoint) is reused
// from shared/auth; the auth-choice state ops come from the session module
// (its canonical owner). Ported 1:1 from scripts/traffic-one-auth/{_helpers,
// writeAuthState,deleteAuthState}.cjs.
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
exports.writeAuthState = writeAuthState;
exports.deleteAuthState = deleteAuthState;
exports.isRemoteAuthRejection = isRemoteAuthRejection;
exports.errorMessage = errorMessage;
exports.stampRemoteCheck = stampRemoteCheck;
exports.recordRefreshFailure = recordRefreshFailure;
exports.keyLookupFromArgs = keyLookupFromArgs;
exports.keyFromArgs = keyFromArgs;
exports.keyFromArgsOrCredential = keyFromArgsOrCredential;
exports.authStateFromResult = authStateFromResult;
exports.writeSessionResult = writeSessionResult;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const auth_choice_1 = require("../../modules/session/auth-choice");
const auth_1 = require("../../shared/auth");
const text_1 = require("../../shared/text");
const credential_store_1 = require("./credential-store");
function writeAuthState(state, env = process.env) {
    const filePath = (0, auth_1.authStatePath)(env);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
        fs.chmodSync(filePath, 0o600);
    }
    catch {
        // best-effort; some filesystems ignore chmod.
    }
    return filePath;
}
function deleteAuthState(env = process.env) {
    try {
        fs.rmSync((0, auth_1.authStatePath)(env), { force: true });
        return true;
    }
    catch {
        return false;
    }
}
function isRemoteAuthRejection(error) {
    const e = error;
    return Boolean(e && (e.statusCode === 401 || e.statusCode === 403));
}
// Node throws an AggregateError with an empty `.message` when a dual-stack
// `localhost` connection is refused on both ::1 and 127.0.0.1. Surface a useful
// string in that case so a failure is never opaque.
function errorMessage(error) {
    if (!error)
        return '';
    const e = error;
    if (e.message)
        return e.message;
    if (Array.isArray(e.errors) && e.errors.length) {
        return e.errors.map((sub) => (sub && sub.message) || String(sub)).join('; ');
    }
    if (e.code)
        return String(e.code);
    return String(error);
}
function stampRemoteCheck(state, patch, env = process.env) {
    const next = { ...state, ...patch, lastRemoteCheckedAt: (0, text_1.nowIsoNoMs)() };
    return writeAuthState(next, env);
}
// Record a failed SILENT refresh: bump the consecutive-failure count and arm the
// exponential backoff, WITHOUT discarding the session token or credentialRef.
// Keeping them means the next attempt can retry from the keychain, and an
// exhausted state still reads as EXPIRED (→ the "re-authenticate" prompt, not the
// first-time auth gate). A successful (re)auth writes a fresh state via
// writeSessionResult, which omits these fields and so resets the counter to zero.
function recordRefreshFailure(state, env = process.env) {
    const failures = (0, auth_1.refreshFailureCount)(state) + 1;
    if (state && typeof state === 'object') {
        const next = {
            ...state,
            refreshFailures: failures,
            nextRefreshAt: new Date(Date.now() + (0, auth_1.refreshBackoffMs)(failures)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            lastRefreshFailureAt: (0, text_1.nowIsoNoMs)(),
        };
        writeAuthState(next, env);
    }
    return { failures, exhausted: failures > auth_1.REFRESH_FAILURE_THRESHOLD };
}
function keyLookupFromArgs(args, _env = process.env, options = {}) {
    if (options.apiKey)
        return { key: options.apiKey, source: 'internal' };
    if (args.includes('--stdin')) {
        return { key: fs.readFileSync(0, 'utf8').trim(), source: 'stdin' };
    }
    return { key: '', source: 'none' };
}
function keyFromArgs(args, env = process.env, options = {}) {
    return keyLookupFromArgs(args, env, options).key || '';
}
function keyFromArgsOrCredential(args, env = process.env, state = null, options = {}) {
    const direct = keyLookupFromArgs(args, env, options);
    if (direct.key)
        return direct;
    const ref = state && state.credentialRef && typeof state.credentialRef === 'object'
        ? state.credentialRef
        : null;
    if (!ref)
        return { key: '', source: 'none', reason: 'missing-api-key' };
    const credential = (0, credential_store_1.readCredential)(ref, env);
    if (!credential.ok || !credential.secret) {
        return {
            key: '',
            source: 'credential-store',
            reason: credential.reason || 'credential-not-found',
            credentialRef: ref,
        };
    }
    return { key: credential.secret, source: 'credential-store', credentialRef: ref };
}
function authStateFromResult(endpoint, result) {
    return {
        version: auth_1.AUTH_STATE_VERSION,
        endpoint,
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt,
        keyId: result.keyId,
        authenticatedAt: (0, text_1.nowIsoNoMs)(),
        lastRemoteCheckedAt: (0, text_1.nowIsoNoMs)(),
        lastRemoteCheckOkAt: (0, text_1.nowIsoNoMs)(),
    };
}
function writeSessionResult(endpoint, result, env = process.env, options = {}) {
    if (!result || result.authenticated !== true || typeof result.sessionToken !== 'string') {
        throw new Error('Authentication response did not include a session token');
    }
    const state = authStateFromResult(endpoint, result);
    let credential = { ok: false, stored: false, reason: 'missing-api-key' };
    const previousRef = options.previousState && options.previousState.credentialRef
        && typeof options.previousState.credentialRef === 'object'
        ? options.previousState.credentialRef
        : null;
    if (options.apiKey) {
        const ref = (0, credential_store_1.credentialRefFor)(endpoint, state.keyId, env);
        if (ref) {
            credential = (0, credential_store_1.storeCredential)(ref, options.apiKey, env);
            if (credential.ok) {
                state.credentialRef = ref;
            }
            else if (previousRef) {
                state.credentialRef = previousRef;
            }
        }
        else {
            credential = { ok: false, stored: false, reason: 'credential-store-unavailable' };
            if (previousRef)
                state.credentialRef = previousRef;
        }
    }
    else if (previousRef) {
        state.credentialRef = previousRef;
        credential = { ok: true, stored: false, reused: true, store: previousRef.store };
    }
    const filePath = writeAuthState(state, env);
    (0, auth_choice_1.deleteAuthChoiceState)(env);
    return { state, filePath, credential };
}
