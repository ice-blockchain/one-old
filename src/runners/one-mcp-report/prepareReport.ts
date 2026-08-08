// src/runners/one-mcp-report/prepareReport.ts
// Decide whether to queue + spawn the fire-and-forget one-mcp report, and do so.
// Skips unless the project explicitly opted in, the cwd is a real codebase, and
// no report id is registered yet. The detached child runs the compiled
// scripts/one-mcp-report.cjs.

import { spawn } from 'child_process';
import * as path from 'path';

import { isNonProjectRoot } from '../../shared/authoring-root';
import { pluginRoot } from '../../shared/paths';
import { pluginUseEnabled } from '../../shared/state/plugin-use';
import { hasRealCodebase } from './hasRealCodebase';
import { ONE_MCP_REPORT, SAVE_MCP_REPORT, STATUS_FILE } from '../../config/reporting';
import { DEFAULT_PUBLIC_ENDPOINT } from '../../config/one-mcp';
import { writeJsonDurable } from '../../shared/fsjson';
import { nowIso, readJson, stateForReport } from './lib';
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
  /** Internal test seam; production callers use the compiled ONE_MCP_REPORT. */
  featureEnabled?: boolean;
}
export interface PrepareResult {
  started: boolean;
  reason?: string;
  reportId?: string;
  spawned?: boolean;
  debugPayloadSaved?: boolean;
}

export function prepareReport(cwd: string, options: PrepareOptions = {}): PrepareResult {
  if (!(options.featureEnabled ?? ONE_MCP_REPORT)) {
    return { started: false, reason: 'reporting-inactive' };
  }
  const root = path.resolve(cwd);
  // The plugin's own repo/install is never reported on. Check this before any
  // project preference lookup so authoring roots remain entirely inert.
  if (isNonProjectRoot(root)) return { started: false, reason: 'plugin-authoring-root' };
  if (!pluginUseEnabled(root)) return { started: false, reason: 'plugin-use-not-enabled' };
  if (!hasRealCodebase(root)) return { started: false, reason: 'no-codebase' };

  // The lock-backed mint is also the one-winner spawn decision. Only the
  // process that durably creates the id receives `created: true`; contenders
  // observe that id and return without spawning.
  const idState = createReportId(root);
  if (idState.invalid) return { started: false, reason: 'invalid-report-id' };
  // Ahead of the `!created` branch: an unpersisted mint is not "somebody else
  // already registered one", it is "nothing is registered and we declined to
  // publish". Backfilling a debug payload for an id that is nowhere on disk
  // would be the wrong next move. The reason string names the ORIGINAL cause (a
  // state file we could not read) and is kept: the fenced writer's refusals —
  // a link at `.one.json`, a resolved path outside the state dir — report
  // through the same flag and mean the same thing to a caller, exactly as
  // EISDIR already reports through the same channel as EACCES.
  if (idState.unpersisted) return { started: false, reason: 'unreadable-project-state' };
  if (!idState.created) {
    const debugPayloadSaved = backfillDebugPayload(root, idState.id, options);
    return { started: false, reason: 'already-registered', reportId: idState.id, ...(debugPayloadSaved ? { debugPayloadSaved: true } : {}) };
  }
  stageReportId(root);

  const statusPath = path.join(root, STATUS_FILE);
  const status = SAVE_MCP_REPORT ? (readJson(statusPath, null) as Rec | null) : null;
  if (status && status.reportId === idState.id && !shouldAttempt(status)) {
    return { started: false, reason: (status && (status.status as string)) || 'recent' };
  }

  // Persist the queued status file unless saving is disabled — the report still
  // gets spawned + POSTed below either way.
  //
  // `one-mcp-report.json` is gitignored and derived, but it lives under
  // `.traffic-one/` and it carries the whole collected mcpPayload, so it goes
  // through the same fenced writer the canonical state file does (see the note
  // on lib.ts writeProjectState for what a planted state-dir link did to both).
  // The refusal gets a channel here rather than being dropped: with saving on,
  // runReport requires a `queued` status for THIS id, so a spawn whose queue
  // write was refused is a detached process that can only skip — and reporting
  // `started: true` would claim a report that provably cannot happen. Same
  // reasoning report-id-mint.ts applies to a refused mint.
  if (SAVE_MCP_REPORT) {
    const state = stateForReport(root, options);
    const nextStatus = {
      status: 'queued',
      reportId: idState.id,
      endpoint: options.endpoint ?? DEFAULT_PUBLIC_ENDPOINT,
      queuedAt: nowIso(),
      lastAttemptAt: status && status.lastAttemptAt ? status.lastAttemptAt : null,
      attempts: status && Number.isInteger(status.attempts) ? status.attempts : 0,
      trigger: options.trigger || 'hook',
      mcpPayload: debugPayloadForReport(root, state, idState.id),
    };
    if (!writeJsonDurable(statusPath, nextStatus)) {
      return { started: false, reason: 'status-write-refused', reportId: idState.id };
    }
  }

  if (options.spawn === false) {
    return { started: true, reportId: idState.id, spawned: false };
  }

  const child = spawn(process.execPath, [path.join(pluginRoot(), 'scripts', 'one-mcp-report.cjs'), root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { started: true, reportId: idState.id, spawned: true };
}
