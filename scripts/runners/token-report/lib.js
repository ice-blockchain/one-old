"use strict";
// src/runners/token-report/lib.ts
// Core token-usage stats: pricing table, message→stats accumulator, Codex
// session usage, Traffic One attribution estimate, stats merge + formatters.
// Ported 1:1 from token-report/_helpers.cjs. Session discovery + markdown
// rendering + the CLI entry land in follow-up files.
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
exports.PRICING = void 0;
exports.numberValue = numberValue;
exports.addToStats = addToStats;
exports.codexUsageFields = codexUsageFields;
exports.addCodexLargestUsage = addCodexLargestUsage;
exports.applyCodexCumulativeUsage = applyCodexCumulativeUsage;
exports.codexSessionIdFromFile = codexSessionIdFromFile;
exports.looksTrafficOneRelated = looksTrafficOneRelated;
exports.addTrafficOneOutputEstimate = addTrafficOneOutputEstimate;
exports.estimateTrafficOneInstructionTokens = estimateTrafficOneInstructionTokens;
exports.minIso = minIso;
exports.maxIso = maxIso;
exports.sumIntoStats = sumIntoStats;
exports.mergeByModel = mergeByModel;
exports.fmtNum = fmtNum;
exports.fmtCost = fmtCost;
exports.fmtDuration = fmtDuration;
const path = __importStar(require("path"));
const parseOriginalTokenCount_1 = require("./parseOriginalTokenCount");
exports.PRICING = {
    'claude-opus-4-7': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
    'claude-opus-4-6': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
    'claude-sonnet-4-6': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
    'claude-sonnet-4-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
    'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
    // Fallback when model is unrecognized — assume sonnet-class pricing.
    _default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};
function numberValue(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
// Accumulate one parsed Claude assistant JSONL record into `stats`.
function addToStats(stats, msg) {
    const m0 = msg && typeof msg === 'object' ? msg : null;
    const message = m0 && m0.message && typeof m0.message === 'object' ? m0.message : null;
    const usage = message && message.usage && typeof message.usage === 'object' ? message.usage : null;
    if (!usage)
        return;
    stats.messages += 1;
    const ts = (m0 && typeof m0.timestamp === 'string' ? m0.timestamp : null);
    if (ts) {
        if (!stats.firstAt || ts < stats.firstAt)
            stats.firstAt = ts;
        if (!stats.lastAt || ts > stats.lastAt)
            stats.lastAt = ts;
    }
    const ip = numberValue(usage.input_tokens);
    const ccr = numberValue(usage.cache_creation_input_tokens);
    const cr = numberValue(usage.cache_read_input_tokens);
    const op = numberValue(usage.output_tokens);
    stats.inputTokens += ip;
    stats.cacheCreationInputTokens += ccr;
    stats.cacheReadInputTokens += cr;
    stats.outputTokens += op;
    const totalThisMsg = ip + ccr + cr + op;
    if (!stats.largestMessage || totalThisMsg > stats.largestMessage.tokens) {
        stats.largestMessage = { tokens: totalThisMsg, timestamp: ts, role: message ? message.role : undefined };
    }
    const model = message && typeof message.model === 'string' ? message.model : '';
    if (model) {
        let entry = stats.byModel[model];
        if (!entry) {
            entry = { messages: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
            stats.byModel[model] = entry;
        }
        entry.messages += 1;
        entry.inputTokens += ip;
        entry.cacheCreationInputTokens += ccr;
        entry.cacheReadInputTokens += cr;
        entry.outputTokens += op;
    }
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
        const b = block && typeof block === 'object' ? block : null;
        if (b && b.type === 'tool_use' && typeof b.name === 'string' && b.name) {
            stats.byTool[b.name] = (stats.byTool[b.name] || 0) + 1;
            stats.toolUses += 1;
        }
    }
}
function codexUsageFields(usage) {
    const u = usage && typeof usage === 'object' ? usage : null;
    if (!u) {
        return { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, reportedTotalTokens: 0 };
    }
    const totalInput = numberValue(u.input_tokens);
    const cachedInput = Math.min(numberValue(u.cached_input_tokens), totalInput);
    const outputTokens = numberValue(u.output_tokens);
    return {
        inputTokens: Math.max(0, totalInput - cachedInput),
        cacheCreationInputTokens: numberValue(u.cache_creation_input_tokens),
        cacheReadInputTokens: cachedInput,
        outputTokens,
        reasoningOutputTokens: numberValue(u.reasoning_output_tokens),
        reportedTotalTokens: numberValue(u.total_tokens) || totalInput + outputTokens,
    };
}
function addCodexLargestUsage(stats, usage, timestamp) {
    const f = codexUsageFields(usage);
    const totalThisCall = f.inputTokens + f.cacheCreationInputTokens + f.cacheReadInputTokens + f.outputTokens;
    if (!stats.largestMessage || totalThisCall > stats.largestMessage.tokens) {
        stats.largestMessage = { tokens: totalThisCall, timestamp, role: 'codex-api-call' };
    }
}
function applyCodexCumulativeUsage(stats, usage, model) {
    const f = codexUsageFields(usage);
    stats.inputTokens = f.inputTokens;
    stats.cacheCreationInputTokens = f.cacheCreationInputTokens;
    stats.cacheReadInputTokens = f.cacheReadInputTokens;
    stats.outputTokens = f.outputTokens;
    stats.reasoningOutputTokens = f.reasoningOutputTokens;
    const modelName = model || 'codex';
    stats.byModel = {
        [modelName]: { messages: stats.messages, inputTokens: f.inputTokens, cacheCreationInputTokens: f.cacheCreationInputTokens, cacheReadInputTokens: f.cacheReadInputTokens, outputTokens: f.outputTokens },
    };
}
function codexSessionIdFromFile(filePath) {
    return path.basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}
// ── Traffic One attribution estimate ─────────────────────────────────────────
function looksTrafficOneRelated(text) {
    if (typeof text !== 'string' || text.length === 0)
        return false;
    return /\btraffic-one\b|Traffic One|\.traffic-one|AGENTS\.md|CLAUDE\.md|hook-runtime|skills-catalog|rules\/common|rules\/frontend|token-report\.cjs/.test(text);
}
function addTrafficOneOutputEstimate(estimate, output) {
    if (!looksTrafficOneRelated(output))
        return;
    const tokens = (0, parseOriginalTokenCount_1.parseOriginalTokenCount)(output);
    if (tokens <= 0)
        return;
    estimate.directToolOutputTokens += tokens;
    estimate.directToolOutputs += 1;
}
function estimateTrafficOneInstructionTokens(text) {
    if (!looksTrafficOneRelated(text))
        return 0;
    const blocks = String(text).split(/\n{2,}/);
    let chars = 0;
    for (const block of blocks) {
        if (looksTrafficOneRelated(block))
            chars += Buffer.byteLength(block, 'utf8');
    }
    return Math.ceil(chars / 4);
}
// ── Merge + format ───────────────────────────────────────────────────────────
function minIso(a, b) {
    if (!a)
        return b || null;
    if (!b)
        return a;
    return a < b ? a : b;
}
function maxIso(a, b) {
    if (!a)
        return b || null;
    if (!b)
        return a;
    return a > b ? a : b;
}
function sumIntoStats(target, source) {
    target.messages += source.messages;
    target.toolUses += source.toolUses;
    target.inputTokens += source.inputTokens;
    target.cacheCreationInputTokens += source.cacheCreationInputTokens;
    target.cacheReadInputTokens += source.cacheReadInputTokens;
    target.outputTokens += source.outputTokens;
    target.reasoningOutputTokens += source.reasoningOutputTokens || 0;
    for (const [tool, count] of Object.entries(source.byTool || {})) {
        target.byTool[tool] = (target.byTool[tool] || 0) + count;
    }
    target.byModel = mergeByModel(target.byModel, source.byModel);
    target.firstAt = minIso(target.firstAt, source.firstAt);
    target.lastAt = maxIso(target.lastAt, source.lastAt);
}
function mergeByModel(left, right) {
    const out = { ...left };
    for (const [model, m] of Object.entries(right || {})) {
        let entry = out[model];
        if (!entry) {
            entry = { messages: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
            out[model] = entry;
        }
        entry.messages += m.messages;
        entry.inputTokens += m.inputTokens;
        entry.cacheCreationInputTokens += m.cacheCreationInputTokens;
        entry.cacheReadInputTokens += m.cacheReadInputTokens;
        entry.outputTokens += m.outputTokens;
    }
    return out;
}
function fmtNum(n) {
    return Number(n).toLocaleString('en-US');
}
function fmtCost(usd) {
    return `$${usd.toFixed(4)}`;
}
function fmtDuration(firstAt, lastAt) {
    if (!firstAt || !lastAt)
        return '—';
    const ms = Date.parse(lastAt) - Date.parse(firstAt);
    if (!Number.isFinite(ms) || ms < 0)
        return '—';
    const mins = Math.round(ms / 60000);
    if (mins < 60)
        return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return `${hrs}h ${rem}m`;
}
