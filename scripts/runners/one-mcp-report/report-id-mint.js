"use strict";
// src/runners/one-mcp-report/report-id-mint.ts
// Mints (or reads) the persisted report id. Ported 1:1 from createReportId /
// ensureReportId (one-mcp-report/_helpers.cjs). Kept separate from lib.ts to
// keep the import tree acyclic (readReportIdState imports lib).
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReportId = createReportId;
exports.ensureReportId = ensureReportId;
const lib_1 = require("./lib");
const readReportIdState_1 = require("./readReportIdState");
const uuidV7_1 = require("./uuidV7");
function createReportId(cwd) {
    const existing = (0, readReportIdState_1.readReportIdState)(cwd);
    if (existing)
        return existing;
    const id = (0, uuidV7_1.uuidV7)();
    const state = (0, lib_1.readProjectState)(cwd);
    state[lib_1.ONE_UID_FIELD] = id;
    (0, lib_1.writeProjectState)(cwd, state);
    return { id, created: true };
}
function ensureReportId(cwd) {
    return (0, readReportIdState_1.readReportIdState)(cwd) || createReportId(cwd);
}
