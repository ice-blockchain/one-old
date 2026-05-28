"use strict";
// src/runners/one-mcp-report/shouldAttempt.ts
// Retry policy for the fire-and-forget report given the persisted status.
// Ported 1:1 from one-mcp-report/shouldAttempt.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldAttempt = shouldAttempt;
const lib_1 = require("./lib");
function shouldAttempt(status, nowMs = Date.now()) {
    if (!status || typeof status !== 'object')
        return true;
    const s = status;
    if (s.status === 'ok')
        return false;
    const last = (0, lib_1.parseTimestamp)(s.lastAttemptAt || s.queuedAt);
    if (!last)
        return true;
    if (s.status === 'queued' || s.status === 'pending')
        return nowMs - last > lib_1.QUEUED_RETRY_MS;
    if (s.status === 'failed')
        return nowMs - last > lib_1.FAILED_RETRY_MS;
    return true;
}
