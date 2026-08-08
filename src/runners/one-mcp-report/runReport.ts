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
import { writeJsonDurable } from '../../shared/fsjson';
import { mcpRequest, nowIso, readJson, stateForReport } from './lib';
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

export interface RunResult {
  ok: boolean;
  reportId?: string;
  skipped?: string;
  error?: unknown;
  /**
   * The POST outcome above is real, and the on-disk status file does NOT
   * describe it — the fenced writer declined `one-mcp-report.json` (a link at
   * it, a resolved path outside the state dir, an unanswered consent question).
   * Separate from `ok` on purpose: a refused bookkeeping write cannot make a
   * delivered report undelivered, but an unqualified success over a status file
   * that never recorded the attempt is the "producer certifies, consumer
   * refuses" shape tests/refusal-contract.test.ts exists to stop.
   */
  statusUnpersisted?: true;
}

export async function runReport(cwd: string, options: RunOptions = {}): Promise<RunResult> {
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
  // Fenced like every other write under `.traffic-one/` (lib.ts
  // writeProjectState carries the measurement for both files). The refusals are
  // ROUTED rather than dropped, and `statusUnpersisted` rather than `ok` is
  // where they go: the POST is the product and a declined bookkeeping write
  // cannot undo it, but a bare `{ ok: true }` over a status file that records
  // nothing is a certification with no artifact behind it. One flag covers all
  // three writes — they share one destination, and fsjson's refusals are
  // durable (only ELOOP, a check-then-open race, could differ between two of
  // them a millisecond apart).
  const recordStatus = (status: Rec): boolean => !SAVE_MCP_REPORT || writeJsonDurable(statusPath, status);
  const attemptRecorded = recordStatus({ status: 'pending', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload });

  try {
    const transport = options.transport
      || ((target: string, body: unknown) => mcpRequest(target, body, ONE_MCP_REPORT_TIMEOUT_MS));
    await transport(endpoint, payload);
    const recorded = recordStatus({ status: 'ok', reportId: idState.id, endpoint, queuedAt, reportedAt: nowIso(), attempts, trigger, mcpPayload }) && attemptRecorded;
    return { ok: true, reportId: idState.id, ...(recorded ? {} : { statusUnpersisted: true as const }) };
  } catch (error) {
    const recorded = recordStatus({
      status: 'failed', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: nowIso(), attempts, trigger, mcpPayload,
      error: error && (error as Error).message
        ? (error as Error).message
        : String(error || 'unknown error'),
    }) && attemptRecorded;
    return { ok: false, error, ...(recorded ? {} : { statusUnpersisted: true as const }) };
  }
}
