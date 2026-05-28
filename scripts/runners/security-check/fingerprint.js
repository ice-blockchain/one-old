"use strict";
// src/runners/security-check/fingerprint.ts
// Deterministic project fingerprint (git HEAD + a stable hash of tracked file
// contents, with the traffic-one state stamp fields normalized out). Used by
// the security report + the deploy gate to detect "has anything changed since
// the last passing security check?". Ported 1:1 from
// scripts/security-check-runner/computeProjectFingerprint.cjs.
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
exports.computeProjectFingerprint = computeProjectFingerprint;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const lib_1 = require("./lib");
function computeProjectFingerprint(cwd = process.cwd()) {
    const root = path.resolve(cwd);
    const hash = crypto.createHash('sha256');
    const gitHead = (0, lib_1.isInsideGitWorkTree)(root)
        ? (0, lib_1.gitOutput)(root, ['rev-parse', 'HEAD']).trim() || 'no-head'
        : 'no-git';
    const files = (0, lib_1.listFingerprintFiles)(root);
    hash.update(`head\0${gitHead}\0`);
    for (const relPath of files) {
        hash.update(`path\0${relPath}\0`);
        hash.update((0, lib_1.hashFileForFingerprint)(root, relPath));
        hash.update('\0');
    }
    return {
        fingerprint: hash.digest('hex'),
        head: gitHead,
        fileCount: files.length,
    };
}
