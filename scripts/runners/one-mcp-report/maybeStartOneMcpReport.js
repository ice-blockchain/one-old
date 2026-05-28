"use strict";
// src/runners/one-mcp-report/maybeStartOneMcpReport.ts
// The hook-facing entry point: best-effort prepare (never throws). Ported 1:1
// from one-mcp-report/maybeStartOneMcpReport.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeStartOneMcpReport = maybeStartOneMcpReport;
const prepareReport_1 = require("./prepareReport");
function maybeStartOneMcpReport(cwd, options = {}) {
    try {
        return (0, prepareReport_1.prepareReport)(cwd, options);
    }
    catch (error) {
        return { started: false, reason: 'error', error };
    }
}
