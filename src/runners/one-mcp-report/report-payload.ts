// src/runners/one-mcp-report/report-payload.ts
// Debug-payload helpers: build the MCP payload for a report id, and backfill it
// into an existing status file that predates the field. Ported 1:1 from
// debugPayloadForReport / backfillDebugPayload (one-mcp-report/_helpers.cjs).

import * as path from 'path';

import { buildMcpPayload } from './buildMcpPayload';
import { collectMetadata } from './collectMetadata';
import { SAVE_MCP_REPORT, STATUS_FILE } from '../../config/reporting';
import { writeJsonDurable } from '../../shared/fsjson';
import { readJson, stateForReport } from './lib';

type Rec = Record<string, unknown>;

export function debugPayloadForReport(root: string, state: unknown, reportId: string): Record<string, unknown> {
  return buildMcpPayload(collectMetadata(root, state, reportId));
}

/**
 * The status file goes through the fenced chokepoint like every other write
 * under `.traffic-one/` (see lib.ts writeProjectState). The boolean is RETURNED
 * rather than discarded because this function's contract is "did I backfill",
 * and prepareReport turns it into `debugPayloadSaved: true` — a fenced refusal
 * that still answered `true` would be a claim about a file that was not written.
 */
export function backfillDebugPayload(root: string, reportId: string, options: { state?: unknown } = {}): boolean {
  if (!SAVE_MCP_REPORT) return false;
  const statusPath = path.join(root, STATUS_FILE);
  const status = readJson(statusPath, null) as Rec | null;
  if (!status || status.reportId !== reportId || status.mcpPayload) return false;
  const state = stateForReport(root, options);
  return writeJsonDurable(statusPath, { ...status, mcpPayload: debugPayloadForReport(root, state, reportId) });
}
