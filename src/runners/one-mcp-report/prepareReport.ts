// src/runners/one-mcp-report/prepareReport.ts
// Decide whether to queue + spawn the fire-and-forget one-mcp report, and do so.
// Ported 1:1 from one-mcp-report/prepareReport.cjs. Skips unless authed locally
// (except for explicit architect PLAN_READY reports), the cwd is a real
// codebase, and no report id is registered yet. The detached child runs the
// compiled scripts/one-mcp-report.cjs.

import { spawn } from 'child_process';
import * as path from 'path';

import { isAuthenticatedLocal } from '../../shared/auth';
import { pluginRoot } from '../../shared/paths';
import { hasRealCodebase } from './hasRealCodebase';
import { MCP_REPORT_ENDPOINT, REPORTING_ACTIVE, SAVE_MCP_REPORT, STATUS_FILE } from '../../config/reporting';
import { nowIso, readJson, stateForReport, writeJson } from './lib';
import { readReportIdState } from './readReportIdState';
import { createReportId } from './report-id-mint';
import { backfillDebugPayload, debugPayloadForReport } from './report-payload';
import { shouldAttempt } from './shouldAttempt';
import { stageReportId } from './stageReportId';

type Rec = Record<string, unknown>;
export interface PrepareOptions {
  endpoint?: string;
  trigger?: string;
  state?: unknown;
  spawn?: boolean;
  allowUnauthenticated?: boolean;
}
export interface PrepareResult {
  started: boolean;
  reason?: string;
  reportId?: string;
  spawned?: boolean;
  debugPayloadSaved?: boolean;
}

export function prepareReport(cwd: string, options: PrepareOptions = {}): PrepareResult {
  if (!REPORTING_ACTIVE) return { started: false, reason: 'reporting-inactive' };
  if (process.env.TRAFFIC_ONE_DISABLE_ONE_MCP === '1') return { started: false, reason: 'disabled' };
  if (!options.allowUnauthenticated && !isAuthenticatedLocal()) return { started: false, reason: 'auth-required' };
  const root = path.resolve(cwd);
  if (!hasRealCodebase(root)) return { started: false, reason: 'no-codebase' };

  const existingIdState = readReportIdState(root);
  if (existingIdState && existingIdState.invalid) return { started: false, reason: 'invalid-report-id' };
  if (existingIdState) {
    const debugPayloadSaved = backfillDebugPayload(root, existingIdState.id, options);
    return { started: false, reason: 'already-registered', reportId: existingIdState.id, ...(debugPayloadSaved ? { debugPayloadSaved: true } : {}) };
  }

  const idState = createReportId(root);
  if (idState.invalid) return { started: false, reason: 'invalid-report-id' };
  if (!idState.created) return { started: false, reason: 'already-registered', reportId: idState.id };
  stageReportId(root);

  const statusPath = path.join(root, STATUS_FILE);
  const status = SAVE_MCP_REPORT ? (readJson(statusPath, null) as Rec | null) : null;
  if (status && status.reportId === idState.id && !shouldAttempt(status)) {
    return { started: false, reason: (status && (status.status as string)) || 'recent' };
  }

  // Persist the queued status file unless saving is disabled — the report still
  // gets spawned + POSTed below either way.
  if (SAVE_MCP_REPORT) {
    const state = stateForReport(root, options);
    const nextStatus = {
      status: 'queued',
      reportId: idState.id,
      endpoint: options.endpoint || MCP_REPORT_ENDPOINT,
      queuedAt: nowIso(),
      lastAttemptAt: status && status.lastAttemptAt ? status.lastAttemptAt : null,
      attempts: status && Number.isInteger(status.attempts) ? status.attempts : 0,
      trigger: options.trigger || 'hook',
      mcpPayload: debugPayloadForReport(root, state, idState.id),
    };
    writeJson(statusPath, nextStatus);
  }

  if (options.spawn === false || process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN === '1') {
    return { started: true, reportId: idState.id, spawned: false };
  }

  const child = spawn(process.execPath, [path.join(pluginRoot(), 'scripts', 'one-mcp-report.cjs'), root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TRAFFIC_ONE_ONE_MCP_ENDPOINT: options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || MCP_REPORT_ENDPOINT,
    },
  });
  child.unref();
  return { started: true, reportId: idState.id, spawned: true };
}
