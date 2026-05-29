// src/runners/one-mcp-report/validReportId.ts
// Ported 1:1 from one-mcp-report/validReportId.cjs.

export function validReportId(value: unknown): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(String(value || '').trim());
}
