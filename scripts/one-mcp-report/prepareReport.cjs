'use strict';

const path = require('path');
const { spawn } = require('child_process');
const {
  isAuthenticatedLocal,
} = require('../traffic-one-auth.cjs');
const { hasRealCodebase } = require('./hasRealCodebase.cjs');
const { readReportIdState } = require('./readReportIdState.cjs');
const { stageReportId } = require('./stageReportId.cjs');
const { shouldAttempt } = require('./shouldAttempt.cjs');
const {
  DEFAULT_ENDPOINT,
  STATUS_FILE,
  nowIso,
  readJson,
  writeJson,
  createReportId,
  stateForReport,
  debugPayloadForReport,
  backfillDebugPayload,
} = require('./_helpers.cjs');

function prepareReport(cwd, options = {}) {
  if (process.env.TRAFFIC_ONE_DISABLE_ONE_MCP === '1') {
    return { started: false, reason: 'disabled' };
  }
  if (!isAuthenticatedLocal()) {
    return { started: false, reason: 'auth-required' };
  }
  const root = path.resolve(cwd);
  if (!hasRealCodebase(root)) {
    return { started: false, reason: 'no-codebase' };
  }

  const existingIdState = readReportIdState(root);
  if (existingIdState && existingIdState.invalid) {
    return { started: false, reason: 'invalid-report-id' };
  }
  if (existingIdState) {
    const debugPayloadSaved = backfillDebugPayload(root, existingIdState.id, options);
    return {
      started: false,
      reason: 'already-registered',
      reportId: existingIdState.id,
      ...(debugPayloadSaved ? { debugPayloadSaved: true } : {}),
    };
  }

  const idState = createReportId(root);
  if (idState.invalid) {
    return { started: false, reason: 'invalid-report-id' };
  }
  if (!idState.created) {
    return { started: false, reason: 'already-registered', reportId: idState.id };
  }
  stageReportId(root);

  const statusPath = path.join(root, STATUS_FILE);
  const status = readJson(statusPath, null);
  if (status && status.reportId === idState.id && !shouldAttempt(status)) {
    return { started: false, reason: status && status.status ? status.status : 'recent' };
  }

  const state = stateForReport(root, options);
  const nextStatus = {
    status: 'queued',
    reportId: idState.id,
    endpoint: options.endpoint || DEFAULT_ENDPOINT,
    queuedAt: nowIso(),
    lastAttemptAt: status && status.lastAttemptAt ? status.lastAttemptAt : null,
    attempts: status && Number.isInteger(status.attempts) ? status.attempts : 0,
    trigger: options.trigger || 'hook',
    mcpPayload: debugPayloadForReport(root, state, idState.id),
  };
  writeJson(statusPath, nextStatus);

  if (options.spawn === false || process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN === '1') {
    return { started: true, reportId: idState.id, spawned: false };
  }

  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'one-mcp-report.cjs'), root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      TRAFFIC_ONE_ONE_MCP_ENDPOINT: options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || DEFAULT_ENDPOINT,
    },
  });
  child.unref();
  return { started: true, reportId: idState.id, spawned: true };
}

module.exports = { prepareReport };
