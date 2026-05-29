"use strict";
// src/runners/token-report/parseOriginalTokenCount.ts
// Ported 1:1 from token-report/parseOriginalTokenCount.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseOriginalTokenCount = parseOriginalTokenCount;
function parseOriginalTokenCount(output) {
    if (typeof output !== 'string')
        return 0;
    const match = /Original token count:\s*([0-9][0-9,]*)/.exec(output);
    if (!match)
        return 0;
    return Number(match[1].replace(/,/g, '')) || 0;
}
