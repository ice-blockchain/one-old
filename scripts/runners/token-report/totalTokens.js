"use strict";
// src/runners/token-report/totalTokens.ts
// Ported 1:1 from token-report/totalTokens.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.totalTokens = totalTokens;
function totalTokens(stats) {
    return stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens + stats.outputTokens;
}
