"use strict";
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
exports.writeReports = writeReports;
exports.renderMarkdownReport = renderMarkdownReport;
exports.stampState = stampState;
// src/runners/security-check/report.ts
// Report IO: write the JSON + Markdown reports and stamp a passing run into state.
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const helpers_1 = require("./helpers");
const state_1 = require("../../shared/state");
const version_1 = require("../../shared/version");
function writeReports(cwd, reportDir, report) {
    fs.mkdirSync(reportDir, { recursive: true });
    const slug = (0, helpers_1.timestampSlug)(report.generatedAt);
    const jsonPath = path.join(reportDir, `security-check-${slug}.json`);
    const markdownPath = path.join(reportDir, `security-check-${slug}.md`);
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(markdownPath, renderMarkdownReport(report), 'utf8');
    return {
        jsonPath,
        markdownPath,
        relativeJsonPath: (0, helpers_1.relativePath)(cwd, jsonPath),
        relativeMarkdownPath: (0, helpers_1.relativePath)(cwd, markdownPath),
    };
}
function renderMarkdownReport(report) {
    const blockers = report.issues.filter((issue) => issue.severity === 'high');
    const warnings = report.issues.filter((issue) => issue.severity !== 'high');
    const lines = [
        '# Traffic One Pre-Deployment Security Check',
        '',
        `Status: ${report.status.toUpperCase()}`,
        `Generated: ${report.generatedAt}`,
        `Fingerprint: ${report.fingerprint.fingerprint}`,
        '',
        `High findings: ${blockers.length}`,
        `Warnings: ${warnings.length}`,
        '',
    ];
    for (const issue of report.issues) {
        const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : 'project';
        lines.push(`- [${issue.severity}] ${issue.category} — ${location} — ${issue.message}`);
        if (issue.remediation) {
            lines.push(`  Fix: ${issue.remediation}`);
        }
    }
    if (report.issues.length === 0) {
        lines.push('No findings.');
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
}
function stampState(cwd, report, relativeReportPath) {
    const nextStatePath = (0, state_1.statePath)(cwd);
    const oldStatePath = (0, state_1.legacyStatePath)(cwd);
    let state = {};
    try {
        const readableStatePath = fs.existsSync(nextStatePath) ? nextStatePath : oldStatePath;
        state = JSON.parse(fs.readFileSync(readableStatePath, 'utf8'));
    }
    catch {
        state = {};
    }
    state.lastSecurityCheckAt = report.generatedAt;
    state.lastSecurityCheckStatus = 'passed';
    state.lastSecurityCheckFingerprint = report.fingerprint.fingerprint;
    state.lastSecurityCheckReport = relativeReportPath;
    delete state.pluginVersion;
    const version = (0, version_1.pluginVersion)();
    if (version) {
        state.version = version;
    }
    fs.mkdirSync(path.dirname(nextStatePath), { recursive: true });
    fs.writeFileSync(nextStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
