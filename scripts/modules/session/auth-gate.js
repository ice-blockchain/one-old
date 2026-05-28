"use strict";
// src/modules/session/auth-gate.ts
// Deterministic auth gate + canonical HookResult builders. Ported 1:1 from
// scripts/hook-runtime/handlers/auth.cjs. Directive PROSE comes from the session
// skill (skillBlock); enforcement (deny / allow) lives here. authGateForHook
// spawns the auth CLI at scripts/traffic-one-auth.cjs (present in both the
// alongside phase and post-cutover).
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
exports.parseAuthStatusOutput = parseAuthStatusOutput;
exports.authGateForHook = authGateForHook;
exports.runInternalAuthLogin = runInternalAuthLogin;
exports.isSessionExpiryReauth = isSessionExpiryReauth;
exports.parseUnauthenticatedAuthChoice = parseUnauthenticatedAuthChoice;
exports.parseTrafficOneApiKey = parseTrafficOneApiKey;
exports.authChoiceRequiredDenyReason = authChoiceRequiredDenyReason;
exports.sessionExpiredReauthContext = sessionExpiredReauthContext;
exports.authRequiredHookResult = authRequiredHookResult;
exports.authApiKeyPromptHookResult = authApiKeyPromptHookResult;
exports.authChoiceHookResult = authChoiceHookResult;
exports.sessionExpiredReauthPromptResult = sessionExpiredReauthPromptResult;
exports.authLoginFromPromptHookResult = authLoginFromPromptHookResult;
exports.authPreToolGate = authPreToolGate;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const result_1 = require("../../core/result");
const auth_1 = require("../../shared/auth");
const authoring_root_1 = require("../../shared/authoring-root");
const paths_1 = require("../../shared/paths");
const prompt_request_1 = require("../../shared/prompt-request");
const skill_block_1 = require("../../shared/skill-block");
const auth_choice_1 = require("./auth-choice");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const block = (name, vars = {}) => skillBlock('session', name, { MCP_TOOL_WARNING: skillBlock('session', 'common-mcp-tool-warning', {}), ...vars });
function authScriptPath() {
    return path.resolve((0, paths_1.pluginRoot)(), 'scripts', 'traffic-one-auth.cjs');
}
function parseAuthStatusOutput(stdout) {
    try {
        const parsed = JSON.parse(String(stdout || '').trim());
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
}
function authGateForHook({ forceRemote = false } = {}) {
    const authScript = authScriptPath();
    const timeoutMs = Number.parseInt(process.env.TRAFFIC_ONE_AUTH_REMOTE_CHECK_TIMEOUT_MS || '5000', 10);
    const runStatus = (args) => (0, child_process_1.spawnSync)(process.execPath, [authScript, ...args], {
        cwd: process.cwd(), env: process.env, encoding: 'utf8',
        timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000, maxBuffer: 64 * 1024,
    });
    if (!(0, auth_1.isAuthenticatedLocal)()) {
        const refreshResult = runStatus(['status']);
        const refreshParsed = parseAuthStatusOutput(refreshResult.stdout);
        if (refreshResult.status === 0 && refreshParsed && refreshParsed.authenticated === true) {
            return { authenticated: true, checkedRemote: false, reauthenticated: refreshParsed.reauthenticated === true };
        }
        return {
            authenticated: false,
            reason: (refreshParsed && refreshParsed.reason) || (refreshResult.error && refreshResult.error.message) || 'local-auth-required',
            priorReason: (refreshParsed && refreshParsed.priorReason) || null,
        };
    }
    const authState = (0, auth_1.readAuthState)();
    if (!forceRemote && !(0, auth_1.authRemoteCheckDue)(authState))
        return { authenticated: true, checkedRemote: false };
    const result = runStatus(['status', '--remote']);
    const parsed = parseAuthStatusOutput(result.stdout);
    if (parsed && parsed.authenticated === false) {
        return { authenticated: false, reason: parsed.reason || 'remote-auth-required', priorReason: parsed.priorReason || null };
    }
    if (!parsed || result.status !== 0 || parsed.remoteChecked === false) {
        if (process.env.TRAFFIC_ONE_AUTH_ALLOW_REMOTE_CHECK_FAILURE === '1') {
            return { authenticated: true, checkedRemote: true, remoteCheckFailed: true };
        }
        return { authenticated: false, reason: (parsed && parsed.reason) || (result.error && result.error.message) || 'remote-auth-check-failed' };
    }
    return { authenticated: true, checkedRemote: true, remoteCheckFailed: false };
}
function runInternalAuthLogin(apiKey) {
    const authScript = authScriptPath();
    const timeoutMs = Number.parseInt(process.env.TRAFFIC_ONE_AUTH_LOGIN_TIMEOUT_MS || '10000', 10);
    const options = { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000, maxBuffer: 64 * 1024 };
    const loginResult = (0, child_process_1.spawnSync)(process.execPath, [authScript, 'login', '--stdin'], { ...options, input: apiKey });
    const loginParsed = parseAuthStatusOutput(loginResult.stdout);
    if (loginResult.status !== 0 || !loginParsed || loginParsed.ok !== true) {
        return { ok: false, reason: (loginResult.stderr || '').trim() || (loginParsed && loginParsed.reason) || 'login-failed' };
    }
    const statusResult = (0, child_process_1.spawnSync)(process.execPath, [authScript, 'status'], { ...options });
    const statusParsed = parseAuthStatusOutput(statusResult.stdout);
    if (statusResult.status === 0 && statusParsed && statusParsed.authenticated === true) {
        return { ok: true, status: statusParsed };
    }
    return { ok: false, reason: (statusResult.stderr || '').trim() || (statusParsed && statusParsed.reason) || 'status-check-failed' };
}
function isSessionExpiryReauth(authGate, env = process.env) {
    if (authGate && authGate.priorReason === auth_1.FRESHNESS_REASON.EXPIRED)
        return true;
    if (authGate && authGate.reason === 'reauthentication-required')
        return true;
    const state = (0, auth_1.readAuthState)(env);
    // Silent refresh gave up after the threshold → this is a re-auth, not first-time.
    if ((0, auth_1.refreshAttemptsExhausted)(state))
        return true;
    return (0, auth_1.authStateFreshness)(state, env).reason === auth_1.FRESHNESS_REASON.EXPIRED;
}
function parseUnauthenticatedAuthChoice(prompt, options = {}) {
    const text = String(prompt || '').trim().toLowerCase();
    if (!text)
        return null;
    const compact = text.replace(/[`"'’]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!compact)
        return null;
    const mentionsTrafficOne = /\btraffic one\b/.test(compact);
    if (options.allowNumeric === true) {
        if (/^(1|one)$/.test(compact))
            return 'authenticate';
        if (/^(2|two)$/.test(compact))
            return 'continue-without-traffic-one';
    }
    if ((mentionsTrafficOne && /\b(authenticate|auth|login|log in|sign in|signin)\b/.test(compact))
        || /^(authenticate|auth|login|log in|sign in|signin|yes)$/.test(compact)) {
        return 'authenticate';
    }
    const continueWithout = [
        /^(continue|proceed|skip|without|no)$/, /\bcontinue without\b/, /\bwithout traffic one\b/,
        /\bdont use\b/, /\bdo not use\b/, /\bnot use\b/, /\bskip\b/, /\bignore\b/, /\bdisable\b/, /\binactive\b/,
    ];
    if (continueWithout.some((p) => p.test(compact)) || (mentionsTrafficOne && /\b(continue|proceed|skip|ignore|without|disable|inactive|no)\b/.test(compact))) {
        return 'continue-without-traffic-one';
    }
    return null;
}
function parseTrafficOneApiKey(prompt) {
    let text = String(prompt || '').trim();
    if (!text)
        return null;
    text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
    if (/^(cancel|stop|never mind|nevermind)$/i.test(text))
        return null;
    const keyPhrase = text.match(/\b(?:use\s+)?(?:the\s+)?(?:api\s+)?key\s+(?:is\s+)?([A-Za-z0-9][A-Za-z0-9._:-]{7,})\b/i);
    if (keyPhrase)
        return keyPhrase[1] ?? null;
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/.test(text))
        return text;
    return null;
}
// ── Canonical HookResult builders ────────────────────────────────────────────
function persistenceDiagnostic(writeResult) {
    if (!writeResult || writeResult.ok !== false)
        return '';
    const code = writeResult.code ? ` (${writeResult.code})` : '';
    return ['', block('persistence-diagnostic', { CODE: code })].join('\n');
}
function authChoiceRequiredDenyReason() {
    return block('pre-tool-deny');
}
function sessionExpiredReauthContext() {
    return block('session-expired');
}
function authRequiredHookResult(_event, options = {}) {
    const inactiveMessage = [
        (0, auth_1.authRequiredMessage)(),
        '',
        block('session-start-gate'),
        persistenceDiagnostic(options.authChoiceWrite),
    ].join('\n');
    return (0, result_1.context)(inactiveMessage, {
        systemMessage: 'traffic-one inactive: authentication choice required',
        promptRequest: (0, prompt_request_1.authChoicePromptRequest)(inactiveMessage),
    });
}
function authApiKeyPromptHookResult(options = {}) {
    const additionalContext = [block('api-key-prompt'), persistenceDiagnostic(options.authChoiceWrite).trim()].join('\n');
    return (0, result_1.context)(additionalContext, {
        systemMessage: 'traffic-one authentication key required',
        promptRequest: (0, prompt_request_1.authApiKeyPromptRequest)(additionalContext),
    });
}
function authChoiceHookResult(choice, cwd = process.cwd()) {
    if (choice === 'authenticate') {
        return authApiKeyPromptHookResult({ authChoiceWrite: (0, auth_choice_1.tryWriteAuthChoice)('authenticate', cwd) });
    }
    const writeResult = (0, auth_choice_1.tryWriteAuthChoice)('continue-without-traffic-one', cwd);
    const rememberedLine = writeResult.ok ? block('remembered-yes') : block('remembered-no');
    const additionalContext = [block('continue-without'), rememberedLine, persistenceDiagnostic(writeResult).trim()].join('\n');
    return (0, result_1.context)(additionalContext, { systemMessage: 'traffic-one inactive: user chose to continue without Traffic One' });
}
function sessionExpiredReauthPromptResult() {
    const additionalContext = sessionExpiredReauthContext();
    return (0, result_1.context)(additionalContext, {
        systemMessage: 'traffic-one session expired — re-authentication key required',
        promptRequest: (0, prompt_request_1.sessionExpiredPromptRequest)(additionalContext),
    });
}
function authLoginFromPromptHookResult(apiKey) {
    const result = runInternalAuthLogin(apiKey);
    if (!result.ok) {
        return (0, result_1.context)(block('login-failed', { REASON: result.reason || 'unknown failure' }), { systemMessage: 'traffic-one authentication failed' });
    }
    return (0, result_1.context)(block('login-success'), { systemMessage: 'traffic-one authenticated' });
}
// PreToolUse gate: returns deny (block) or noop (allow).
function authPreToolGate(ctx) {
    if ((0, authoring_root_1.isPluginAuthoringRoot)(ctx.cwd))
        return (0, result_1.noop)();
    const gate = authGateForHook();
    if (gate.authenticated)
        return (0, result_1.noop)();
    const command = ctx.input.tool?.command ?? '';
    if (ctx.input.tool?.class === 'shell' && ((0, auth_1.isTrafficOneAuthCommand)(command) || (0, auth_1.isTrafficOneDoctorCommand)(command))) {
        return (0, result_1.noop)();
    }
    if ((0, auth_choice_1.authChoiceAllowsContinue)(ctx.cwd))
        return (0, result_1.noop)();
    if (isSessionExpiryReauth(gate)) {
        const reason = sessionExpiredReauthContext();
        return (0, result_1.deny)(reason, { promptRequest: (0, prompt_request_1.sessionExpiredPromptRequest)(reason) });
    }
    const reason = authChoiceRequiredDenyReason();
    return (0, result_1.deny)(reason, { promptRequest: (0, prompt_request_1.authChoicePromptRequest)(reason) });
}
