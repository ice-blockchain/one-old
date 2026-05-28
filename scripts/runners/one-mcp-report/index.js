"use strict";
// src/runners/one-mcp-report/index.ts
// CLI entry for the detached one-mcp report worker (compiles to
// scripts/one-mcp-report.cjs). Ported 1:1 from scripts/one-mcp-report.cjs.
// Fire-and-forget: never throws, always exits 0.
Object.defineProperty(exports, "__esModule", { value: true });
exports.validReportId = exports.uuidV7 = exports.shouldAttempt = exports.stageReportId = exports.runReport = exports.ensureReportId = exports.createReportId = exports.readReportIdState = exports.prepareReport = exports.maybeStartOneMcpReport = exports.hasRealCodebase = exports.collectTechnologies = exports.collectMetadata = exports.collectFileExtensions = exports.collectArchitectureComponents = exports.buildMcpPayload = void 0;
exports.main = main;
const runReport_1 = require("./runReport");
var buildMcpPayload_1 = require("./buildMcpPayload");
Object.defineProperty(exports, "buildMcpPayload", { enumerable: true, get: function () { return buildMcpPayload_1.buildMcpPayload; } });
var collectArchitectureComponents_1 = require("./collectArchitectureComponents");
Object.defineProperty(exports, "collectArchitectureComponents", { enumerable: true, get: function () { return collectArchitectureComponents_1.collectArchitectureComponents; } });
var collectFileExtensions_1 = require("./collectFileExtensions");
Object.defineProperty(exports, "collectFileExtensions", { enumerable: true, get: function () { return collectFileExtensions_1.collectFileExtensions; } });
var collectMetadata_1 = require("./collectMetadata");
Object.defineProperty(exports, "collectMetadata", { enumerable: true, get: function () { return collectMetadata_1.collectMetadata; } });
var collectTechnologies_1 = require("./collectTechnologies");
Object.defineProperty(exports, "collectTechnologies", { enumerable: true, get: function () { return collectTechnologies_1.collectTechnologies; } });
var hasRealCodebase_1 = require("./hasRealCodebase");
Object.defineProperty(exports, "hasRealCodebase", { enumerable: true, get: function () { return hasRealCodebase_1.hasRealCodebase; } });
var maybeStartOneMcpReport_1 = require("./maybeStartOneMcpReport");
Object.defineProperty(exports, "maybeStartOneMcpReport", { enumerable: true, get: function () { return maybeStartOneMcpReport_1.maybeStartOneMcpReport; } });
var prepareReport_1 = require("./prepareReport");
Object.defineProperty(exports, "prepareReport", { enumerable: true, get: function () { return prepareReport_1.prepareReport; } });
var readReportIdState_1 = require("./readReportIdState");
Object.defineProperty(exports, "readReportIdState", { enumerable: true, get: function () { return readReportIdState_1.readReportIdState; } });
var report_id_mint_1 = require("./report-id-mint");
Object.defineProperty(exports, "createReportId", { enumerable: true, get: function () { return report_id_mint_1.createReportId; } });
Object.defineProperty(exports, "ensureReportId", { enumerable: true, get: function () { return report_id_mint_1.ensureReportId; } });
var runReport_2 = require("./runReport");
Object.defineProperty(exports, "runReport", { enumerable: true, get: function () { return runReport_2.runReport; } });
var stageReportId_1 = require("./stageReportId");
Object.defineProperty(exports, "stageReportId", { enumerable: true, get: function () { return stageReportId_1.stageReportId; } });
var shouldAttempt_1 = require("./shouldAttempt");
Object.defineProperty(exports, "shouldAttempt", { enumerable: true, get: function () { return shouldAttempt_1.shouldAttempt; } });
var uuidV7_1 = require("./uuidV7");
Object.defineProperty(exports, "uuidV7", { enumerable: true, get: function () { return uuidV7_1.uuidV7; } });
var validReportId_1 = require("./validReportId");
Object.defineProperty(exports, "validReportId", { enumerable: true, get: function () { return validReportId_1.validReportId; } });
async function main() {
    const cwd = process.argv[2] || process.cwd();
    await (0, runReport_1.runReport)(cwd);
}
if (require.main === module) {
    main().catch(() => { process.exitCode = 0; });
}
