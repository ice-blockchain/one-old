// src/runners/one-mcp-report/validReportId.ts
// Compatibility wrapper around the centralized One MCP report-id grammar.

import { isValidOneMcpReportId } from '../../config/one-mcp';

export function validReportId(value: unknown): boolean {
  return isValidOneMcpReportId(typeof value === 'string' ? value.trim() : value);
}
