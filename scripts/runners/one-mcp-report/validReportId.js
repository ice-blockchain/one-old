"use strict";
// src/runners/one-mcp-report/validReportId.ts
// Ported 1:1 from one-mcp-report/validReportId.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.validReportId = validReportId;
function validReportId(value) {
    return /^[A-Za-z0-9._:-]{1,128}$/.test(String(value || '').trim());
}
