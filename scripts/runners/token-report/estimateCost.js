"use strict";
// src/runners/token-report/estimateCost.ts
// Per-model USD estimate from accumulated stats. Ported 1:1 from
// token-report/estimateCost.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateCost = estimateCost;
const priceFor_1 = require("./priceFor");
function estimateCost(stats) {
    let total = 0;
    for (const [model, m] of Object.entries(stats.byModel || {})) {
        const p = (0, priceFor_1.priceFor)(model);
        total += (m.inputTokens / 1_000_000) * p.input;
        total += (m.cacheCreationInputTokens / 1_000_000) * p.cacheWrite;
        total += (m.cacheReadInputTokens / 1_000_000) * p.cacheRead;
        total += (m.outputTokens / 1_000_000) * p.output;
    }
    return total;
}
