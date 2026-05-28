// src/runners/one-mcp-report/runReport.ts
// The detached worker: collect the anonymous metadata for the queued report id
// and POST it once, recording pending/ok/failed status. Ported 1:1 from
// one-mcp-report/runReport.cjs. The network transport is injectable (default
// mcpRequest) so it can be driven without real HTTPS in tests.

import * as path from 'path';

import { buildMcpPayload } from './buildMcpPayload';
import { collectMetadata } from './collectMetadata';
import { DEFAULT_ENDPOINT, mcpRequest, nowIso, readJson, STATUS_FILE, stateForReport, writeJson } from './lib';
import { readReportIdState } from './readReportIdState';

type Rec = Record<string, unknown>;
export interface RunOptions {
  endpoint?: string;
  state?: unknown;
  requireQueued?: boolean;
  transport?: (endpoint: string, payload: unknown) => Promise<unknown>;
}

export async function runReport(cwd: string, options: RunOptions = {}): Promise<{ ok: boolean; reportId?: string; skipped?: string; error?: unknown }> {
  const root = path.resolve(cwd);
  const endpoint = options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || DEFAULT_ENDPOINT;
  const idState = readReportIdState(root);
  if (!idState) return { ok: false, skipped: 'missing-report-id' };
  if (idState.invalid) return { ok: false, skipped: 'invalid-report-id' };

  const state = stateForReport(root, options);
  const statusPath = path.join(root, STATUS_FILE);
  const previous = readJson(statusPath, {}) as Rec;
  if (options.requireQueued !== false) {
    const queuedForThisId = previous && previous.status === 'queued' && previous.reportId === idState.id;
    if (!queuedForThisId) return { ok: false, skipped: 'not-queued' };
  }

  const payload = collectMetadata(root, state, idState.id);
  const mcpPayload = buildMcpPayload(payload);
  const attempts = previous && Number.isInteger(previous.attempts) ? (previous.attempts as number) + 1 : 1;
  const queuedAt = previous && previous.queuedAt ? previous.queuedAt : null;
  const trigger = previous && previous.trigger ? previous.trigger : null;
  writeJson(statusPath, { status: 'pending', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload });

  try {
    await (options.transport || mcpRequest)(endpoint, payload);
    writeJson(statusPath, { status: 'ok', reportId: idState.id, endpoint, queuedAt, reportedAt: nowIso(), attempts, trigger, mcpPayload });
    return { ok: true, reportId: idState.id };
  } catch (error) {
    writeJson(statusPath, {
      status: 'failed', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload,
      error: error && (error as Error).message ? (error as Error).message : String(error || 'unknown error'),
    });
    return { ok: false, error };
  }
}
