'use strict';

const {
  QUEUED_RETRY_MS,
  FAILED_RETRY_MS,
  parseTimestamp,
} = require('./_helpers.cjs');

function shouldAttempt(status, nowMs = Date.now()) {
  if (!status || typeof status !== 'object') return true;
  if (status.status === 'ok') return false;
  const last = parseTimestamp(status.lastAttemptAt || status.queuedAt);
  if (!last) return true;
  if (status.status === 'queued' || status.status === 'pending') {
    return nowMs - last > QUEUED_RETRY_MS;
  }
  if (status.status === 'failed') {
    return nowMs - last > FAILED_RETRY_MS;
  }
  return true;
}

module.exports = { shouldAttempt };
