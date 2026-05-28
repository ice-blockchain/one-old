"use strict";
// src/shared/token-logger.ts
// In-flight per-tool token-usage logger. OFF by default; opt in with
// TRAFFIC_ONE_TOKEN_LOG=1. When enabled, PostToolUse handlers append one JSONL
// line per tool call to .traffic-one/token-log.jsonl with byte + phase context.
// Complements the token-report runner (which parses billed-token transcripts);
// this adds per-tool byte counts + role attribution. No-op when the flag is
// unset — zero overhead for users who never opt in. Ported 1:1 from
// scripts/hook-runtime/token-logger.cjs.
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
exports.LOG_REL_PATH = exports.ENV_FLAG = void 0;
exports.isEnabled = isEnabled;
exports.estimateTokens = estimateTokens;
exports.readSizeFromValue = readSizeFromValue;
exports.readPhase = readPhase;
exports.logToolUse = logToolUse;
exports.logHookContext = logHookContext;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const state_1 = require("./state");
exports.ENV_FLAG = 'TRAFFIC_ONE_TOKEN_LOG';
exports.LOG_REL_PATH = path.join('.traffic-one', 'token-log.jsonl');
function isEnabled() {
    const v = process.env[exports.ENV_FLAG];
    return v === '1' || v === 'true' || v === 'yes';
}
function estimateTokens(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return 0;
    return Math.ceil(bytes / 4);
}
function readSizeFromValue(value) {
    if (value == null)
        return 0;
    if (typeof value === 'string')
        return Buffer.byteLength(value, 'utf8');
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    catch {
        return 0;
    }
}
// Best-effort phase lookup from .traffic-one/.one.json in cwd.
function readPhase(cwd, payload = null) {
    if (!fs.existsSync((0, state_1.statePath)(cwd)) && !fs.existsSync((0, state_1.legacyStatePath)(cwd))) {
        return { runId: null, role: null };
    }
    try {
        const state = (0, state_1.readState)(cwd);
        const agentContext = (0, state_1.resolveRunAgentContext)(cwd, state, payload || {}, { claimPending: false })
            || (!(0, state_1.hasRunAgentState)(cwd, state) ? (0, state_1.legacyRunAgentContext)(state) : null);
        const ctxRunId = agentContext && typeof agentContext.runId === 'string' ? agentContext.runId : null;
        const ctxRole = agentContext && typeof agentContext.role === 'string' ? agentContext.role : null;
        return {
            runId: ctxRunId ?? (typeof state.currentRunId === 'string' ? state.currentRunId : null),
            role: ctxRole ?? (typeof state.activeAgentRole === 'string' ? state.activeAgentRole : null),
        };
    }
    catch {
        return { runId: null, role: null };
    }
}
// Append one entry. Safe to call from any hook; silently no-ops when disabled or
// on write failure. Never throws.
function logToolUse(cwd, payloadInput) {
    if (!isEnabled())
        return;
    if (!payloadInput || typeof payloadInput !== 'object')
        return;
    const payload = payloadInput;
    const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const toolResp = payload.tool_response || payload.tool_result;
    const inputBytes = readSizeFromValue(toolInput);
    const outputBytes = readSizeFromValue(toolResp);
    const phase = readPhase(cwd, payload);
    const entry = {
        ts: new Date().toISOString(),
        runId: phase.runId,
        role: phase.role,
        hookEvent: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : null,
        toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
        inputBytes,
        outputBytes,
        estTokens: estimateTokens(inputBytes + outputBytes),
    };
    const dst = path.join(cwd, exports.LOG_REL_PATH);
    try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.appendFileSync(dst, `${JSON.stringify(entry)}\n`, 'utf8');
    }
    catch {
        // best-effort; never block a hook on logging
    }
}
// Log a hook-injected context block (our own injected bytes).
function logHookContext(cwd, hookEvent, additionalContext) {
    if (!isEnabled())
        return;
    const bytes = readSizeFromValue(additionalContext);
    if (bytes === 0)
        return;
    const phase = readPhase(cwd, { hook_event_name: hookEvent });
    const entry = {
        ts: new Date().toISOString(),
        runId: phase.runId,
        role: phase.role,
        hookEvent: hookEvent || null,
        toolName: null,
        inputBytes: 0,
        outputBytes: bytes,
        estTokens: estimateTokens(bytes),
        action: 'hook-context-injection',
    };
    const dst = path.join(cwd, exports.LOG_REL_PATH);
    try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.appendFileSync(dst, `${JSON.stringify(entry)}\n`, 'utf8');
    }
    catch {
        // best-effort
    }
}
