"use strict";
// src/shared/state/toolchain.ts
// Toolchain stamp seeding, deduped (legacy normalize.cjs + local-prefs.cjs each
// carried an identical copy of these two functions).
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
exports.initializeLocalToolchainState = void 0;
exports.toolNamesFromSpec = toolNamesFromSpec;
exports.initializeToolchainState = initializeToolchainState;
exports.hasInitializedToolchain = hasInitializedToolchain;
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
const paths_1 = require("../paths");
const FALLBACK_TOOLS = ['gitnexus', 'graphify', 'opencode', 'gitleaks', 'trufflehog'];
function toolNamesFromSpec() {
    try {
        const specPath = path.join((0, paths_1.pluginRoot)(), 'scripts', 'toolchain-versions.json');
        const parsed = (0, fsjson_1.readJson)(specPath, {});
        const tools = parsed && typeof parsed.tools === 'object' && parsed.tools ? parsed.tools : {};
        const names = Object.keys(tools).sort();
        return names.length > 0 ? names : [...FALLBACK_TOOLS];
    }
    catch {
        return [...FALLBACK_TOOLS];
    }
}
function initializeToolchainState(existing = {}) {
    const out = {};
    const source = existing && typeof existing === 'object' ? existing : {};
    for (const name of toolNamesFromSpec()) {
        const cur = source[name] && typeof source[name] === 'object'
            ? source[name]
            : {};
        out[name] = {
            installedVersion: (typeof cur.installedVersion === 'string' && cur.installedVersion) || null,
            installedAt: (typeof cur.installedAt === 'string' && cur.installedAt) || null,
            ...(typeof cur.binPath === 'string' && cur.binPath ? { binPath: cur.binPath } : {}),
        };
    }
    return out;
}
// Legacy alias (local-prefs used a separate name for the identical function).
exports.initializeLocalToolchainState = initializeToolchainState;
// A toolchain is "initialized" once every tracked tool has installedVersion +
// installedAt keys present (the stamp may still be null, but the keys exist).
function hasInitializedToolchain(toolchain) {
    if (!toolchain || typeof toolchain !== 'object')
        return false;
    const tc = toolchain;
    const expected = initializeToolchainState({});
    return Object.keys(expected).every((toolName) => {
        const entry = tc[toolName];
        return Boolean(entry
            && typeof entry === 'object'
            && Object.prototype.hasOwnProperty.call(entry, 'installedVersion')
            && Object.prototype.hasOwnProperty.call(entry, 'installedAt'));
    });
}
