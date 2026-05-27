'use strict';

const path = require('path');
const { readReportIdState } = require('./readReportIdState.cjs');
const { collectMetadata } = require('./collectMetadata.cjs');
const { buildMcpPayload } = require('./buildMcpPayload.cjs');
const {
  DEFAULT_ENDPOINT,
  STATUS_FILE,
  nowIso,
  readJson,
  writeJson,
  mcpRequest,
} = require('./_helpers.cjs');

async function runReport(cwd, options = {}) {
  const root = path.resolve(cwd);
  const endpoint = options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || DEFAULT_ENDPOINT;
  const idState = readReportIdState(root);
  if (!idState) {
    return { ok: false, skipped: 'missing-report-id' };
  }
  if (idState.invalid) {
    return { ok: false, skipped: 'invalid-report-id' };
  }

  const state = readJson(path.join(root, '.traffic-one.json'), {});
  const statusPath = path.join(root, STATUS_FILE);
  const previous = readJson(statusPath, {});
  if (options.requireQueued !== false) {
    const queuedForThisId = previous
      && previous.status === 'queued'
      && previous.reportId === idState.id;
    if (!queuedForThisId) {
      return { ok: false, skipped: 'not-queued' };
    }
  }

  const payload = collectMetadata(root, state, idState.id);
  const mcpPayload = buildMcpPayload(payload);
  const attempts = previous && Number.isInteger(previous.attempts) ? previous.attempts + 1 : 1;
  writeJson(statusPath, {
    status: 'pending',
    reportId: idState.id,
    endpoint,
    queuedAt: previous && previous.queuedAt ? previous.queuedAt : null,
    lastAttemptAt: nowIso(),
    attempts,
    trigger: previous && previous.trigger ? previous.trigger : null,
    mcpPayload,
  });

  try {
    await (options.transport || mcpRequest)(endpoint, payload);
    writeJson(statusPath, {
      status: 'ok',
      reportId: idState.id,
      endpoint,
      queuedAt: previous && previous.queuedAt ? previous.queuedAt : null,
      reportedAt: nowIso(),
      attempts,
      trigger: previous && previous.trigger ? previous.trigger : null,
      mcpPayload,
    });
    return { ok: true, reportId: idState.id };
  } catch (error) {
    writeJson(statusPath, {
      status: 'failed',
      reportId: idState.id,
      endpoint,
      queuedAt: previous && previous.queuedAt ? previous.queuedAt : null,
      lastAttemptAt: nowIso(),
      attempts,
      trigger: previous && previous.trigger ? previous.trigger : null,
      mcpPayload,
      error: error && error.message ? error.message : String(error || 'unknown error'),
    });
    return { ok: false, error };
  }
}

module.exports = { runReport };
