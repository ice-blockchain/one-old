"use strict";
// src/runners/one-mcp-report/runReport.ts
// The detached worker: collect the anonymous metadata for the queued report id
// and POST it once, recording pending/ok/failed status. Ported 1:1 from
// one-mcp-report/runReport.cjs. The network transport is injectable (default
// mcpRequest) so it can be driven without real HTTPS in tests.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runReport = runReport;
const path = __importStar(require("path"));
const buildMcpPayload_1 = require("./buildMcpPayload");
const collectMetadata_1 = require("./collectMetadata");
const lib_1 = require("./lib");
const readReportIdState_1 = require("./readReportIdState");
async function runReport(cwd, options = {}) {
    const root = path.resolve(cwd);
    const endpoint = options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || lib_1.DEFAULT_ENDPOINT;
    const idState = (0, readReportIdState_1.readReportIdState)(root);
    if (!idState)
        return { ok: false, skipped: 'missing-report-id' };
    if (idState.invalid)
        return { ok: false, skipped: 'invalid-report-id' };
    const state = (0, lib_1.stateForReport)(root, options);
    const statusPath = path.join(root, lib_1.STATUS_FILE);
    const previous = (0, lib_1.readJson)(statusPath, {});
    if (options.requireQueued !== false) {
        const queuedForThisId = previous && previous.status === 'queued' && previous.reportId === idState.id;
        if (!queuedForThisId)
            return { ok: false, skipped: 'not-queued' };
    }
    const payload = (0, collectMetadata_1.collectMetadata)(root, state, idState.id);
    const mcpPayload = (0, buildMcpPayload_1.buildMcpPayload)(payload);
    const attempts = previous && Number.isInteger(previous.attempts) ? previous.attempts + 1 : 1;
    const queuedAt = previous && previous.queuedAt ? previous.queuedAt : null;
    const trigger = previous && previous.trigger ? previous.trigger : null;
    (0, lib_1.writeJson)(statusPath, { status: 'pending', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: (0, lib_1.nowIso)(), attempts, trigger, mcpPayload });
    try {
        await (options.transport || lib_1.mcpRequest)(endpoint, payload);
        (0, lib_1.writeJson)(statusPath, { status: 'ok', reportId: idState.id, endpoint, queuedAt, reportedAt: (0, lib_1.nowIso)(), attempts, trigger, mcpPayload });
        return { ok: true, reportId: idState.id };
    }
    catch (error) {
        (0, lib_1.writeJson)(statusPath, {
            status: 'failed', reportId: idState.id, endpoint, queuedAt, lastAttemptAt: (0, lib_1.nowIso)(), attempts, trigger, mcpPayload,
            error: error && error.message ? error.message : String(error || 'unknown error'),
        });
        return { ok: false, error };
    }
}
