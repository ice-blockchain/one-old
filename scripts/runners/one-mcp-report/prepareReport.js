"use strict";
// src/runners/one-mcp-report/prepareReport.ts
// Decide whether to queue + spawn the fire-and-forget one-mcp report, and do so.
// Ported 1:1 from one-mcp-report/prepareReport.cjs. Skips unless authed locally
// (except for explicit architect PLAN_READY reports), the cwd is a real
// codebase, and no report id is registered yet. The detached child runs the
// compiled scripts/one-mcp-report.cjs.
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
exports.prepareReport = prepareReport;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const auth_1 = require("../../shared/auth");
const paths_1 = require("../../shared/paths");
const hasRealCodebase_1 = require("./hasRealCodebase");
const lib_1 = require("./lib");
const readReportIdState_1 = require("./readReportIdState");
const report_id_mint_1 = require("./report-id-mint");
const report_payload_1 = require("./report-payload");
const shouldAttempt_1 = require("./shouldAttempt");
const stageReportId_1 = require("./stageReportId");
function prepareReport(cwd, options = {}) {
    if (process.env.TRAFFIC_ONE_DISABLE_ONE_MCP === '1')
        return { started: false, reason: 'disabled' };
    if (!options.allowUnauthenticated && !(0, auth_1.isAuthenticatedLocal)())
        return { started: false, reason: 'auth-required' };
    const root = path.resolve(cwd);
    if (!(0, hasRealCodebase_1.hasRealCodebase)(root))
        return { started: false, reason: 'no-codebase' };
    const existingIdState = (0, readReportIdState_1.readReportIdState)(root);
    if (existingIdState && existingIdState.invalid)
        return { started: false, reason: 'invalid-report-id' };
    if (existingIdState) {
        const debugPayloadSaved = (0, report_payload_1.backfillDebugPayload)(root, existingIdState.id, options);
        return { started: false, reason: 'already-registered', reportId: existingIdState.id, ...(debugPayloadSaved ? { debugPayloadSaved: true } : {}) };
    }
    const idState = (0, report_id_mint_1.createReportId)(root);
    if (idState.invalid)
        return { started: false, reason: 'invalid-report-id' };
    if (!idState.created)
        return { started: false, reason: 'already-registered', reportId: idState.id };
    (0, stageReportId_1.stageReportId)(root);
    const statusPath = path.join(root, lib_1.STATUS_FILE);
    const status = (0, lib_1.readJson)(statusPath, null);
    if (status && status.reportId === idState.id && !(0, shouldAttempt_1.shouldAttempt)(status)) {
        return { started: false, reason: (status && status.status) || 'recent' };
    }
    const state = (0, lib_1.stateForReport)(root, options);
    const nextStatus = {
        status: 'queued',
        reportId: idState.id,
        endpoint: options.endpoint || lib_1.DEFAULT_ENDPOINT,
        queuedAt: (0, lib_1.nowIso)(),
        lastAttemptAt: status && status.lastAttemptAt ? status.lastAttemptAt : null,
        attempts: status && Number.isInteger(status.attempts) ? status.attempts : 0,
        trigger: options.trigger || 'hook',
        mcpPayload: (0, report_payload_1.debugPayloadForReport)(root, state, idState.id),
    };
    (0, lib_1.writeJson)(statusPath, nextStatus);
    if (options.spawn === false || process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN === '1') {
        return { started: true, reportId: idState.id, spawned: false };
    }
    const child = (0, child_process_1.spawn)(process.execPath, [path.join((0, paths_1.pluginRoot)(), 'scripts', 'one-mcp-report.cjs'), root], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            TRAFFIC_ONE_ONE_MCP_ENDPOINT: options.endpoint || process.env.TRAFFIC_ONE_ONE_MCP_ENDPOINT || lib_1.DEFAULT_ENDPOINT,
        },
    });
    child.unref();
    return { started: true, reportId: idState.id, spawned: true };
}
