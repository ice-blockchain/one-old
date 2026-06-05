// src/runners/one-mcp-report/runReport.ts
// The detached worker: collect the anonymous metadata for the queued report id
// and POST it once, recording pending/ok/failed status. Ported 1:1 from
// one-mcp-report/runReport.cjs. The network transport is injectable (default
// mcpRequest) so it can be driven without real HTTPS in tests.

import * as path from 'path';

import { buildMcpPayload } from './buildMcpPayload';
import { collectMetadata } from './collectMetadata';
import { MCP_REPORT_ENDPOINT, REPORTING_ACTIVE, SAVE_MCP_REPORT, STATUS_FILE } from '../../config/reporting';
import { mcpRequest, nowIso, readJson, stateForReport, writeJson } from './lib';
import { readReportIdState } from './readReportIdState';

type Rec = Record<string, unknown>;
export interface RunOptions {
  endpoint?: string;
  state?: unknown;
  requireQueued?: boolean;
  transport?: (endpoint: string, payload: unknown) => Promise<unknown>;
}

export async function runReport(cwd: string, options: RunOptions = {}): Promise<{ ok: boolean; reportId?: string; skipped?: string; error?: unknown }> {
  if (!REPORTING_ACTIVE) return { ok: false, skipped: 'reporting-inactive' };
  const root = path.resolve(cwd);
  const endpoint = options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || MCP_REPORT_ENDPOINT;
  const idState = readReportIdState(root);
  if (!idState) return { ok: false, skipped: 'missing-report-id' };
  if (idState.invalid) return { ok: false, skipped: 'invalid-report-id' };

  const state = stateForReport(root, options);
  const statusPath = path.join(root, STATUS_FILE);
  // No status file when saving is disabled: skip the queued gate and treat prior
  // status as empty. The report still collects + POSTs below; it just isn't
  // tracked on disk.
  const previous = SAVE_MCP_REPORT ? (readJson(statusPath, {}) as Rec) : ({} as Rec);
  if (SAVE_MCP_REPORT && options.requireQueued !== false) {
    const queuedForThisId = previous && previous.status === 'queued' && previous.reportId === idState.id;
    if (!queuedForThisId) return { ok: false, skipped: 'not-queued' };
  }

  const payload = collectMetadata(root, state, idState.id);
  const mcpPayload = buildMcpPayload(payload);
  const attempts = previous && Number.isInteger(previous.attempts) ? (previous.attempts as number) + 1 : 1;
  const queuedAt = previous && previous.queuedAt ? previous.queuedAt : null;
  const trigger = previous && previous.trigger ? previous.trigger : null;
  if (SAVE_MCP_REPORT) writeJson(statusPath, { status: 'pending', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload });

  try {
    await (options.transport || mcpRequest)(endpoint, payload);
    if (SAVE_MCP_REPORT) writeJson(statusPath, { status: 'ok', reportId: idState.id, endpoint, queuedAt, reportedAt: nowIso(), attempts, trigger, mcpPayload });
    return { ok: true, reportId: idState.id };
  } catch (error) {
    if (SAVE_MCP_REPORT) {
      writeJson(statusPath, {
        status: 'failed', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload,
        error: error && (error as Error).message ? (error as Error).message : String(error || 'unknown error'),
      });
    }
    return { ok: false, error };
  }
}
