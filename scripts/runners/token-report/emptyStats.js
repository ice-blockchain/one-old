"use strict";
// src/runners/token-report/emptyStats.ts
// Ported 1:1 from token-report/emptyStats.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyStats = emptyStats;
function emptyStats() {
    return {
        messages: 0,
        toolUses: 0,
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        firstAt: null,
        lastAt: null,
        byTool: {},
        byModel: {},
        largestMessage: null,
        modelContextWindow: null,
    };
}
