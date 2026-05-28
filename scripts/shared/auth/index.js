"use strict";
// src/shared/auth/index.ts
// Offline auth-state READ service (the foundation every gate checks). Ported 1:1
// from scripts/traffic-one-auth/* (the read/freshness half). The write/login/
// credential-store/MCP client lives with the auth CLI runner (Step 5).
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
exports.FRESHNESS_REASON = exports.REMOTE_AUTH_CHECK_INTERVAL_MS = exports.EXPIRY_SKEW_MS = exports.AUTH_STATE_VERSION = exports.DEFAULT_ENDPOINT = void 0;
exports.isLoopbackHostname = isLoopbackHostname;
exports.authEndpointUrl = authEndpointUrl;
exports.endpointFromEnv = endpointFromEnv;
exports.authStatePath = authStatePath;
exports.readAuthState = readAuthState;
exports.authStateFreshness = authStateFreshness;
exports.isAuthStateFresh = isAuthStateFresh;
exports.isAuthenticatedLocal = isAuthenticatedLocal;
exports.authRemoteCheckDue = authRemoteCheckDue;
exports.isTrafficOneAuthCommand = isTrafficOneAuthCommand;
exports.isTrafficOneDoctorCommand = isTrafficOneDoctorCommand;
exports.authRequiredMessage = authRequiredMessage;
const net = __importStar(require("net"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
const paths_1 = require("../paths");
exports.DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/mcp';
exports.AUTH_STATE_VERSION = 1;
exports.EXPIRY_SKEW_MS = 30 * 1000;
exports.REMOTE_AUTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
exports.FRESHNESS_REASON = {
    OK: 'ok',
    MISSING: 'missing-auth-state',
    VERSION_MISMATCH: 'version-mismatch',
    MALFORMED_TOKEN: 'malformed-token',
    MALFORMED_EXPIRY: 'malformed-expiry',
    ENDPOINT_MISMATCH: 'endpoint-mismatch',
    EXPIRED: 'expired',
};
// Absolute path to the compiled auth CLI (legacy path preserved at cutover).
function entryFilename() {
    return path.join((0, paths_1.pluginRoot)(), 'scripts', 'traffic-one-auth.cjs');
}
function isLoopbackHostname(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const ipVersion = net.isIP(host);
    if (ipVersion === 4)
        return host === '0.0.0.0' || host.startsWith('127.');
    if (ipVersion === 6)
        return host === '::1' || host === '0:0:0:0:0:0:0:1';
    return host === 'localhost' || host === 'localhost.';
}
function authEndpointUrl(endpoint) {
    let url;
    try {
        url = new URL(endpoint);
    }
    catch {
        throw new Error(`Invalid Traffic One MCP auth endpoint: ${endpoint}`);
    }
    if (url.username || url.password) {
        throw new Error('Traffic One MCP auth endpoint must not include URL credentials.');
    }
    if (url.protocol === 'https:')
        return url;
    if (url.protocol === 'http:' && isLoopbackHostname(url.hostname))
        return url;
    throw new Error('Refusing to send Traffic One credentials to a non-HTTPS MCP auth endpoint. Use HTTPS for remote endpoints; HTTP is allowed only for loopback local development.');
}
function endpointFromEnv(env = process.env) {
    return env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || exports.DEFAULT_ENDPOINT;
}
function authStatePath(env = process.env) {
    if (env.TRAFFIC_ONE_AUTH_STATE_PATH)
        return path.resolve(env.TRAFFIC_ONE_AUTH_STATE_PATH);
    const base = env.XDG_STATE_HOME
        ? path.join(env.XDG_STATE_HOME, 'traffic-one')
        : path.join(env.HOME || os.homedir(), '.traffic-one');
    return path.join(base, 'auth.json');
}
function readAuthState(env = process.env) {
    return (0, fsjson_1.readJson)(authStatePath(env), null);
}
// Precise reason a stored session is (not) usable. Endpoint mismatch is reported
// ahead of expiry because it signals a config problem rather than the ordinary
// recoverable "timed out" case.
function authStateFreshness(state, env = process.env, nowMs = Date.now()) {
    if (!state || typeof state !== 'object')
        return { fresh: false, reason: exports.FRESHNESS_REASON.MISSING };
    const s = state;
    if (s.version !== exports.AUTH_STATE_VERSION)
        return { fresh: false, reason: exports.FRESHNESS_REASON.VERSION_MISMATCH };
    if (typeof s.sessionToken !== 'string' || !s.sessionToken.startsWith('tok_')) {
        return { fresh: false, reason: exports.FRESHNESS_REASON.MALFORMED_TOKEN };
    }
    if (typeof s.expiresAt !== 'string')
        return { fresh: false, reason: exports.FRESHNESS_REASON.MALFORMED_EXPIRY };
    const expires = Date.parse(s.expiresAt);
    if (!Number.isFinite(expires))
        return { fresh: false, reason: exports.FRESHNESS_REASON.MALFORMED_EXPIRY };
    if (s.endpoint !== endpointFromEnv(env))
        return { fresh: false, reason: exports.FRESHNESS_REASON.ENDPOINT_MISMATCH };
    if (expires - exports.EXPIRY_SKEW_MS <= nowMs)
        return { fresh: false, reason: exports.FRESHNESS_REASON.EXPIRED };
    return { fresh: true, reason: exports.FRESHNESS_REASON.OK };
}
function isAuthStateFresh(state, env = process.env, nowMs = Date.now()) {
    return authStateFreshness(state, env, nowMs).fresh;
}
function isAuthenticatedLocal(env = process.env, nowMs = Date.now()) {
    return isAuthStateFresh(readAuthState(env), env, nowMs);
}
function authRemoteCheckDue(state = readAuthState(), env = process.env, nowMs = Date.now()) {
    if (!isAuthStateFresh(state, env, nowMs))
        return false;
    const lastChecked = Date.parse((state && typeof state.lastRemoteCheckedAt === 'string' ? state.lastRemoteCheckedAt : '') || '');
    return !Number.isFinite(lastChecked) || nowMs - lastChecked >= exports.REMOTE_AUTH_CHECK_INTERVAL_MS;
}
function isTrafficOneAuthCommand(command) {
    const c = String(command || '');
    return /\bscripts\/traffic-one-auth\.cjs\b/.test(c) && /\b(login|refresh|status|logout)\b/.test(c);
}
function isTrafficOneDoctorCommand(command) {
    return /\bscripts\/doctor\.cjs\b/.test(String(command || ''));
}
function authRequiredMessage(env = process.env) {
    const endpoint = endpointFromEnv(env);
    const entry = entryFilename();
    return [
        'Traffic One authentication is required before this plugin can be used.',
        '',
        'Ask the user with a modal selector before continuing:',
        '  - Authenticate Traffic One (Recommended)',
        '  - Continue without Traffic One',
        '',
        'If the user chooses Authenticate Traffic One, ask for the API key using a secure host input/modal and stop. When the user submits the key, the hook runs login + status internally and stores the API key in the OS credential manager when available.',
        'Do NOT call the exposed mcp-auth MCP tools (`mcp__mcp_auth__auth_status`, `mcp__mcp_auth__refresh`, `mcp__mcp_auth__authenticate`, or `mcp__mcp_auth__logout`) for routine auth gate checks. The hook/auth client performs status and refresh silently behind the scenes.',
        `Hook-internal script: ${entry}. Do not run it yourself, do not use a cwd-relative path, and do not search the filesystem for a copy; a found copy may be stale or point at an outdated endpoint.`,
        'If a stored session expires, the auth client will try `refresh` with the OS credential manager key.',
        'Do not ask the user to run bash or shell commands for Traffic One authentication.',
        'If the user chooses Continue without Traffic One, remember that choice for the current project while it remains active and continue without Traffic One features.',
        `Endpoint: ${endpoint}`,
        `Script: ${entry}`,
        `Auth state: ${authStatePath(env)}`,
    ].join('\n');
}
