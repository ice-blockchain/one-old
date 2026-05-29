"use strict";
// src/runners/token-report/parseCodexJsonlFile.ts
// Parse a Codex Desktop rollout JSONL into session meta + cumulative stats +
// Traffic One attribution estimate. Ported 1:1 from
// token-report/parseCodexJsonlFile.cjs.
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
exports.parseCodexJsonlFile = parseCodexJsonlFile;
const obj_1 = require("../../shared/obj");
const fs = __importStar(require("fs"));
const emptyStats_1 = require("./emptyStats");
const emptyTrafficOneEstimate_1 = require("./emptyTrafficOneEstimate");
const lib_1 = require("./lib");
function str(value) {
    return typeof value === 'string' ? value : undefined;
}
function parseCodexJsonlFile(filePath) {
    const stats = (0, emptyStats_1.emptyStats)();
    const trafficOne = (0, emptyTrafficOneEstimate_1.emptyTrafficOneEstimate)();
    let session = {
        id: (0, lib_1.codexSessionIdFromFile)(filePath), jsonl: filePath, cwd: null, startedAt: null,
        originator: 'Codex Desktop', source: null, modelProvider: null, model: 'codex',
    };
    let cumulativeUsage = null;
    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return { session, stats, trafficOne };
    }
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        let parsed;
        try {
            parsed = (0, obj_1.obj)(JSON.parse(line));
        }
        catch {
            continue;
        }
        if (!parsed)
            continue;
        const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
        if (ts) {
            if (!stats.firstAt || ts < stats.firstAt)
                stats.firstAt = ts;
            if (!stats.lastAt || ts > stats.lastAt)
                stats.lastAt = ts;
        }
        if (parsed.type === 'session_meta') {
            const payload = (0, obj_1.obj)(parsed.payload) || {};
            session = {
                ...session,
                id: str(payload.id) ?? session.id,
                startedAt: str(payload.timestamp) ?? ts ?? session.startedAt,
                cwd: str(payload.cwd) ?? session.cwd,
                originator: str(payload.originator) ?? session.originator,
                source: str(payload.source) ?? session.source,
                modelProvider: str(payload.model_provider) ?? session.modelProvider,
                model: str(payload.model) ?? session.model,
            };
            trafficOne.instructionApproxTokens += (0, lib_1.estimateTrafficOneInstructionTokens)((0, obj_1.obj)(payload.base_instructions)?.text);
            trafficOne.instructionApproxTokens += (0, lib_1.estimateTrafficOneInstructionTokens)((0, obj_1.obj)(payload.instructions)?.text);
            trafficOne.instructionApproxTokens += (0, lib_1.estimateTrafficOneInstructionTokens)((0, obj_1.obj)(payload.user_instructions)?.text);
            continue;
        }
        if (parsed.type === 'response_item') {
            const payload = (0, obj_1.obj)(parsed.payload) || {};
            if (payload.type === 'function_call') {
                const name = str(payload.name) || str(payload.tool_name) || str(payload.call_name) || 'function_call';
                stats.byTool[name] = (stats.byTool[name] || 0) + 1;
                stats.toolUses += 1;
            }
            else if (payload.type === 'function_call_output') {
                (0, lib_1.addTrafficOneOutputEstimate)(trafficOne, payload.output);
            }
            continue;
        }
        if (parsed.type === 'event_msg') {
            const payload = (0, obj_1.obj)(parsed.payload) || {};
            if (payload.type !== 'token_count')
                continue;
            const info = (0, obj_1.obj)(payload.info) || {};
            stats.messages += 1;
            if (typeof info.model_context_window === 'number' && Number.isFinite(info.model_context_window)) {
                stats.modelContextWindow = info.model_context_window;
            }
            if (info.last_token_usage)
                (0, lib_1.addCodexLargestUsage)(stats, info.last_token_usage, ts);
            if (info.total_token_usage)
                cumulativeUsage = info.total_token_usage;
        }
    }
    (0, lib_1.applyCodexCumulativeUsage)(stats, cumulativeUsage, session.model);
    return { session, stats, trafficOne };
}
