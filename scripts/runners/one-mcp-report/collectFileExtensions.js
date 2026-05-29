"use strict";
// src/runners/one-mcp-report/collectFileExtensions.ts
// Per-extension line counts across the (skip-filtered) tree, top 50. Ported 1:1
// from one-mcp-report/collectFileExtensions.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectFileExtensions = collectFileExtensions;
const lib_1 = require("./lib");
const NUL = String.fromCharCode(0);
function collectFileExtensions(cwd) {
    const totals = {};
    (0, lib_1.walkFiles)(cwd, (absPath, relPath) => {
        const ext = (0, lib_1.extensionFor)(relPath);
        if (!ext)
            return;
        const text = (0, lib_1.readText)(absPath);
        if (text === null || text.includes(NUL))
            return; // skip binary files (NUL byte)
        totals[ext] = (totals[ext] || 0) + (0, lib_1.countLines)(text);
    });
    return Object.fromEntries(Object.entries(totals).sort((left, right) => right[1] - left[1]).slice(0, 50));
}
