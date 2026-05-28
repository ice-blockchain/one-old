// src/runners/one-mcp-report/maybeStartOneMcpReport.ts
// The hook-facing entry point: best-effort prepare (never throws). Ported 1:1
// from one-mcp-report/maybeStartOneMcpReport.cjs.

import { type PrepareOptions, prepareReport, type PrepareResult } from './prepareReport';

export function maybeStartOneMcpReport(cwd: string, options: PrepareOptions = {}): PrepareResult | { started: false; reason: string; error: unknown } {
  try {
    return prepareReport(cwd, options);
  } catch (error) {
    return { started: false, reason: 'error', error };
  }
}
