"use strict";
// src/runners/one-mcp-report/buildMcpPayload.ts
// Wraps the metadata payload as an MCP tools/call request. Ported 1:1 from
// one-mcp-report/buildMcpPayload.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMcpPayload = buildMcpPayload;
function buildMcpPayload(metadata) {
    return {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'report_codebase_metadata', arguments: metadata },
    };
}
