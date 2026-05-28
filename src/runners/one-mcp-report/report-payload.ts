// src/runners/one-mcp-report/report-payload.ts
// Debug-payload helpers: build the MCP payload for a report id, and backfill it
// into an existing status file that predates the field. Ported 1:1 from
// debugPayloadForReport / backfillDebugPayload (one-mcp-report/_helpers.cjs).

import * as path from 'path';

import { buildMcpPayload } from './buildMcpPayload';
import { collectMetadata } from './collectMetadata';
import { readJson, STATUS_FILE, stateForReport, writeJson } from './lib';

type Rec = Record<string, unknown>;

export function debugPayloadForReport(root: string, state: unknown, reportId: string): Record<string, unknown> {
  return buildMcpPayload(collectMetadata(root, state, reportId));
}

export function backfillDebugPayload(root: string, reportId: string, options: { state?: unknown } = {}): boolean {
  const statusPath = path.join(root, STATUS_FILE);
  const status = readJson(statusPath, null) as Rec | null;
  if (!status || status.reportId !== reportId || status.mcpPayload) return false;
  const state = stateForReport(root, options);
  writeJson(statusPath, { ...status, mcpPayload: debugPayloadForReport(root, state, reportId) });
  return true;
}
