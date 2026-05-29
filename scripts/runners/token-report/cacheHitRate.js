"use strict";
// src/runners/token-report/cacheHitRate.ts
// Ported 1:1 from token-report/cacheHitRate.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheHitRate = cacheHitRate;
function cacheHitRate(stats) {
    const cacheReads = stats.cacheReadInputTokens;
    const totalInput = stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens;
    if (totalInput === 0)
        return 0;
    return (cacheReads / totalInput) * 100;
}
