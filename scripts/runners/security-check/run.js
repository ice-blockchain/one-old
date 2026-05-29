"use strict";
// src/runners/security-check/run.ts
// Orchestrates the security check: build the report, run external scanners
// (gitleaks/trufflehog) + the in-process scanners, write the JSON+markdown
// reports, optionally stamp passing state. Ported 1:1 from
// scripts/security-check-runner/runSecurityCheck.cjs.
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
exports.runSecurityCheck = runSecurityCheck;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fingerprint_1 = require("./fingerprint");
const lib_1 = require("./lib");
function runSecurityCheck(options = {}) {
    const cwd = path.resolve(options.cwd || process.cwd());
    const reportDir = path.resolve(cwd, options.reportDir || lib_1.DEFAULT_REPORT_DIR);
    const generatedAt = (0, lib_1.nowIso)();
    const reporter = (0, lib_1.createReporter)();
    const report = {
        generatedAt,
        status: 'passed',
        strict: Boolean(options.strict),
        cwd,
        fingerprint: (0, fingerprint_1.computeProjectFingerprint)(cwd),
        tools: {},
        externalReports: {},
        issues: reporter.issues,
        addIssue: reporter.addIssue,
    };
    fs.mkdirSync(reportDir, { recursive: true });
    (0, lib_1.scanExternalTools)(cwd, reportDir, report);
    (0, lib_1.scanProject)(cwd, report);
    const highCount = report.issues.filter((issue) => issue.severity === 'high').length;
    if (options.strict && highCount > 0) {
        report.status = 'failed';
    }
    // Strip the runtime-only addIssue method before serialization.
    const serializable = {
        generatedAt: report.generatedAt,
        status: report.status,
        strict: report.strict,
        cwd: report.cwd,
        fingerprint: report.fingerprint,
        tools: report.tools,
        externalReports: report.externalReports,
        issues: report.issues,
        ...(report.installPrompt ? { installPrompt: report.installPrompt } : {}),
    };
    const paths = (0, lib_1.writeReports)(cwd, reportDir, serializable);
    if (options.stamp && serializable.status === 'passed') {
        (0, lib_1.stampState)(cwd, serializable, paths.relativeJsonPath);
    }
    return { report: serializable, paths, exitCode: serializable.status === 'passed' ? 0 : 1 };
}
