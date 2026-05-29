"use strict";
// src/runners/security-check/index.ts
// CLI entry + public surface for the Traffic One pre-deployment security check
// (compiles to scripts/security-check-runner.cjs). Ported 1:1 from
// scripts/security-check-runner.cjs.
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
exports.helpText = exports.parseArgs = exports.parseAuditJson = exports.missingToolInstallPrompt = exports.runSecurityCheck = exports.computeProjectFingerprint = void 0;
exports.main = main;
const os = __importStar(require("os"));
const lib_1 = require("./lib");
const run_1 = require("./run");
var fingerprint_1 = require("./fingerprint");
Object.defineProperty(exports, "computeProjectFingerprint", { enumerable: true, get: function () { return fingerprint_1.computeProjectFingerprint; } });
var run_2 = require("./run");
Object.defineProperty(exports, "runSecurityCheck", { enumerable: true, get: function () { return run_2.runSecurityCheck; } });
var lib_2 = require("./lib");
Object.defineProperty(exports, "missingToolInstallPrompt", { enumerable: true, get: function () { return lib_2.missingToolInstallPrompt; } });
Object.defineProperty(exports, "parseAuditJson", { enumerable: true, get: function () { return lib_2.parseAuditJson; } });
Object.defineProperty(exports, "parseArgs", { enumerable: true, get: function () { return lib_2.parseArgs; } });
Object.defineProperty(exports, "helpText", { enumerable: true, get: function () { return lib_2.helpText; } });
function main() {
    const options = (0, lib_1.parseArgs)(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${(0, lib_1.helpText)()}\n`);
        return 0;
    }
    const { report, paths, exitCode } = (0, run_1.runSecurityCheck)(options);
    const highCount = report.issues.filter((issue) => issue.severity === 'high').length;
    const warningCount = report.issues.length - highCount;
    process.stdout.write([
        `Traffic One security check: ${report.status.toUpperCase()}`,
        `Report: ${paths.relativeMarkdownPath}`,
        `Fingerprint: ${report.fingerprint.fingerprint}`,
        `High findings: ${highCount}`,
        `Warnings: ${warningCount}`,
    ].join('\n'));
    process.stdout.write(os.EOL);
    if (report.installPrompt) {
        process.stdout.write(os.EOL);
        process.stdout.write(report.installPrompt);
        process.stdout.write(os.EOL);
    }
    return exitCode;
}
if (require.main === module) {
    process.exitCode = main();
}
