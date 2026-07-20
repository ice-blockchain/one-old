// src/runners/one-mcp-report/buildMcpPayload.ts
// Wraps the metadata payload as an MCP tools/call request. Ported 1:1 from
// one-mcp-report/buildMcpPayload.cjs.

import { ONE_MCP_REPORT_TOOL } from '../../config/one-mcp';

export interface ReportMcpPayload extends Record<string, unknown> {
  readonly jsonrpc: '2.0';
  readonly id: 1;
  readonly method: 'tools/call';
  readonly params: {
    readonly name: typeof ONE_MCP_REPORT_TOOL;
    readonly arguments: unknown;
  };
}

export function buildMcpPayload(metadata: unknown): ReportMcpPayload {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: ONE_MCP_REPORT_TOOL, arguments: metadata },
  };
}
