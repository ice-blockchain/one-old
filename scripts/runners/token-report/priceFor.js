"use strict";
// src/runners/token-report/priceFor.ts
// Longest-prefix model → pricing lookup. Ported 1:1 from token-report/priceFor.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceFor = priceFor;
const lib_1 = require("./lib");
function priceFor(model) {
    if (!model || typeof model !== 'string')
        return lib_1.PRICING._default;
    const matches = Object.keys(lib_1.PRICING).filter((k) => k !== '_default' && model.startsWith(k));
    if (matches.length === 0)
        return lib_1.PRICING._default;
    matches.sort((a, b) => b.length - a.length);
    return lib_1.PRICING[matches[0]];
}
