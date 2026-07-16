// src/runners/one-mcp-report/runReport.ts
// The detached worker: collect the anonymous metadata for the queued report id
// and POST it once, recording pending/ok/failed status. The network transport is
// injectable (default mcpRequest) so it can be driven without real HTTPS in tests.

import * as path from 'path';

import { buildMcpPayload } from './buildMcpPayload';
import { collectMetadata } from './collectMetadata';
import { authEnforced, clearAuthentication, isLocallyAuthenticated } from '../../shared/auth';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { MCP_REPORT_ENDPOINT, REPORTING_ACTIVE, SAVE_MCP_REPORT, STATUS_FILE } from '../../config/reporting';
import { mcpRequest, nowIso, readJson, stateForReport, writeJson } from './lib';
import { readReportIdState } from './readReportIdState';

type Rec = Record<string, unknown>;
export interface RunOptions {
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  state?: unknown;
  requireQueued?: boolean;
  transport?: (endpoint: string, payload: unknown) => Promise<unknown>;
}

export async function runReport(cwd: string, options: RunOptions = {}): Promise<{ ok: boolean; reportId?: string; skipped?: string; error?: unknown }> {
  const env = options.env ?? process.env;
  if (!REPORTING_ACTIVE) return { ok: false, skipped: 'reporting-inactive' };
  const root = path.resolve(cwd);
  if (pluginUseDeclined(root, env)) return { ok: false, skipped: 'plugin-use-declined' };
  if (authEnforced(env) && !isLocallyAuthenticated(env)) return { ok: false, skipped: 'auth-required' };
  const endpoint = options.endpoint || env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || MCP_REPORT_ENDPOINT;
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
      || ((target: string, body: unknown) => mcpRequest(target, body, 15000, env));
    await transport(endpoint, payload);
    if (SAVE_MCP_REPORT) writeJson(statusPath, { status: 'ok', reportId: idState.id, endpoint, queuedAt, reportedAt: nowIso(), attempts, trigger, mcpPayload });
    return { ok: true, reportId: idState.id };
  } catch (error) {
    // A 401/403 means the entered key was rejected. Remove only one.json.auth so
    // the next session re-opens the API-key wizard while unrelated settings stay.
    const statusCode = (error as { statusCode?: number } | null)?.statusCode;
    let reportedError = error;
    if (statusCode === 401 || statusCode === 403) {
      if (!clearAuthentication(env)) {
        const invalidationError = new Error(
          `${error instanceof Error ? error.message : String(error)}; failed to invalidate canonical Traffic One auth`,
          { cause: error },
        ) as Error & { statusCode?: number };
        invalidationError.statusCode = statusCode;
        reportedError = invalidationError;
      }
    }
    if (SAVE_MCP_REPORT) {
      writeJson(statusPath, {
        status: 'failed', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload,
        error: reportedError && (reportedError as Error).message
          ? (reportedError as Error).message
          : String(reportedError || 'unknown error'),
      });
    }
    return { ok: false, error: reportedError };
  }
}
