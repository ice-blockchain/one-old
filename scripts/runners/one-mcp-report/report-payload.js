"use strict";
// src/runners/one-mcp-report/report-payload.ts
// Debug-payload helpers: build the MCP payload for a report id, and backfill it
// into an existing status file that predates the field. Ported 1:1 from
// debugPayloadForReport / backfillDebugPayload (one-mcp-report/_helpers.cjs).
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
exports.debugPayloadForReport = debugPayloadForReport;
exports.backfillDebugPayload = backfillDebugPayload;
const path = __importStar(require("path"));
const buildMcpPayload_1 = require("./buildMcpPayload");
const collectMetadata_1 = require("./collectMetadata");
const lib_1 = require("./lib");
function debugPayloadForReport(root, state, reportId) {
    return (0, buildMcpPayload_1.buildMcpPayload)((0, collectMetadata_1.collectMetadata)(root, state, reportId));
}
function backfillDebugPayload(root, reportId, options = {}) {
    const statusPath = path.join(root, lib_1.STATUS_FILE);
    const status = (0, lib_1.readJson)(statusPath, null);
    if (!status || status.reportId !== reportId || status.mcpPayload)
        return false;
    const state = (0, lib_1.stateForReport)(root, options);
    (0, lib_1.writeJson)(statusPath, { ...status, mcpPayload: debugPayloadForReport(root, state, reportId) });
    return true;
}
