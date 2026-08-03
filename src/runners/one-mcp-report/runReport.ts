// src/runners/one-mcp-report/runReport.ts
// The detached worker: collect the anonymous metadata for the queued report id
// and POST it once, recording pending/ok/failed status. The network transport is
// injectable (default mcpRequest) so it can be driven without real HTTPS in tests.

import * as path from 'path';

import { buildMcpPayload } from './buildMcpPayload';
import { collectMetadata } from './collectMetadata';
import { pluginUseEnabled } from '../../shared/state/plugin-use';
import {
  ONE_MCP_REPORT,
  ONE_MCP_REPORT_TIMEOUT_MS,
  SAVE_MCP_REPORT,
  STATUS_FILE,
} from '../../config/reporting';
import { DEFAULT_PUBLIC_ENDPOINT } from '../../config/one-mcp';
import { mcpRequest, nowIso, readJson, stateForReport, writeJson } from './lib';
import { readReportIdState } from './readReportIdState';

type Rec = Record<string, unknown>;
export interface RunOptions {
  endpoint?: string;
  state?: unknown;
  requireQueued?: boolean;
  transport?: (endpoint: string, payload: unknown) => Promise<unknown>;
  /** Internal test seam; production callers use the compiled ONE_MCP_REPORT. */
  featureEnabled?: boolean;
}

export async function runReport(cwd: string, options: RunOptions = {}): Promise<{ ok: boolean; reportId?: string; skipped?: string; error?: unknown }> {
  if (!(options.featureEnabled ?? ONE_MCP_REPORT)) {
    return { ok: false, skipped: 'reporting-inactive' };
  }
  const root = path.resolve(cwd);
  if (!pluginUseEnabled(root)) return { ok: false, skipped: 'plugin-use-not-enabled' };
  const endpoint = options.endpoint ?? DEFAULT_PUBLIC_ENDPOINT;
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
    const transport = options.transport
      || ((target: string, body: unknown) => mcpRequest(target, body, ONE_MCP_REPORT_TIMEOUT_MS));
    await transport(endpoint, payload);
    if (SAVE_MCP_REPORT) writeJson(statusPath, { status: 'ok', reportId: idState.id, endpoint, queuedAt, reportedAt: nowIso(), attempts, trigger, mcpPayload });
    return { ok: true, reportId: idState.id };
  } catch (error) {
    if (SAVE_MCP_REPORT) {
      writeJson(statusPath, {
        status: 'failed', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload,
        error: error && (error as Error).message
          ? (error as Error).message
          : String(error || 'unknown error'),
      });
    }
    return { ok: false, error };
  }
}
