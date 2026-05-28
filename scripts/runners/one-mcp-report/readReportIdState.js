"use strict";
// src/runners/one-mcp-report/readReportIdState.ts
// Reads the persisted report id from `.one.json` → one-uid (migrating the legacy
// .one-mcp-id file once if present). Returns null when no id exists yet. Ported
// 1:1 from one-mcp-report/readReportIdState.cjs.
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
exports.readReportIdState = readReportIdState;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const lib_1 = require("./lib");
const validReportId_1 = require("./validReportId");
function readReportIdState(cwd) {
    const state = (0, lib_1.readProjectState)(cwd);
    if (state && typeof state === 'object') {
        const raw = state[lib_1.ONE_UID_FIELD];
        const id = typeof raw === 'string' ? raw.trim() : '';
        if (id) {
            return (0, validReportId_1.validReportId)(id) ? { id, created: false } : { id, created: false, invalid: true };
        }
    }
    const idPath = path.join(cwd, lib_1.LEGACY_ID_FILE);
    const existing = (0, lib_1.readText)(idPath);
    if (existing !== null) {
        const id = existing.trim();
        if ((0, validReportId_1.validReportId)(id)) {
            state[lib_1.ONE_UID_FIELD] = id;
            (0, lib_1.writeProjectState)(cwd, state);
            try {
                fs.rmSync(idPath, { force: true });
            }
            catch {
                // best-effort legacy cleanup
            }
            return { id, created: false, migrated: true };
        }
        return { id, created: false, invalid: true };
    }
    return null;
}
