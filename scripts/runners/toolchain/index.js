"use strict";
// src/runners/toolchain/index.ts
// Single source of truth for "what version of <tool> is installed" + "what does
// the plugin recommend?". The gitnexus/graphify runners use the probe + stamp
// helpers; doctor + tokenEconomyBanner use toolStatus for drift findings. The
// curated spec lives in the sibling toolchain-versions.json (resolved via
// __dirname so it works in src under tsx and compiled at scripts/). Ported 1:1
// from scripts/toolchain.cjs.
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
exports.SPEC_PATH = void 0;
exports.loadSpec = loadSpec;
exports.getToolSpec = getToolSpec;
exports.toolchainRoot = toolchainRoot;
exports.managedToolDir = managedToolDir;
exports.managedVenvBin = managedVenvBin;
exports.managedVenvPython = managedVenvPython;
exports.managedNpmPrefix = managedNpmPrefix;
exports.managedNpmBin = managedNpmBin;
exports.compareSemver = compareSemver;
exports.probeToolVersion = probeToolVersion;
exports.toolStatus = toolStatus;
exports.probeTool = probeTool;
exports.isToolUsable = isToolUsable;
exports.mergeToolchainStamp = mergeToolchainStamp;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const text_1 = require("../../shared/text");
exports.SPEC_PATH = path.join(__dirname, 'toolchain-versions.json');
let cachedSpec = null;
function loadSpec() {
    if (cachedSpec !== null)
        return cachedSpec;
    try {
        const parsed = JSON.parse(fs.readFileSync(exports.SPEC_PATH, 'utf8'));
        cachedSpec = (parsed && parsed.tools) || {};
    }
    catch {
        cachedSpec = {};
    }
    return cachedSpec;
}
function getToolSpec(toolName) {
    const spec = loadSpec();
    return Object.prototype.hasOwnProperty.call(spec, toolName) ? spec[toolName] : null;
}
function toolchainRoot() {
    if (process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT)
        return path.resolve(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT);
    const stateHome = process.env.XDG_STATE_HOME
        ? path.join(process.env.XDG_STATE_HOME, 'traffic-one')
        : path.join(process.env.HOME || os.homedir(), '.traffic-one');
    return path.join(stateHome, 'toolchains');
}
function managedToolDir(toolName) {
    return path.join(toolchainRoot(), toolName);
}
function managedVenvBin(toolName, binName = toolName) {
    const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(managedToolDir(toolName), 'venv', binDir, `${binName}${ext}`);
}
function managedVenvPython(toolName) {
    const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(managedToolDir(toolName), 'venv', binDir, `python${ext}`);
}
function managedNpmPrefix(toolName) {
    return path.join(managedToolDir(toolName), 'npm-prefix');
}
function managedNpmBin(toolName, binName = toolName) {
    const ext = process.platform === 'win32' ? '.cmd' : '';
    return path.join(managedNpmPrefix(toolName), 'bin', `${binName}${ext}`);
}
// Compare two semver strings (no dep). -1 / 0 / 1, or null for non-semver.
function compareSemver(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string')
        return null;
    const norm = (v) => v.replace(/^v/, '').split('.').map((n) => Number(n));
    const aa = norm(a);
    const bb = norm(b);
    if (aa.length !== 3 || bb.length !== 3)
        return null;
    if (aa.some(Number.isNaN) || bb.some(Number.isNaN))
        return null;
    for (let i = 0; i < 3; i += 1) {
        const av = aa[i];
        const bv = bb[i];
        if (av !== bv)
            return av < bv ? -1 : 1;
    }
    return 0;
}
// Probe `tool --version` and extract the semver via the spec's versionRegex.
// Returns the matched semver, or null on any failure. opts.binPath forces an
// absolute binary path (PATH-order independence, e.g. nvm-v22 gitnexus).
function probeToolVersion(toolName, opts = {}) {
    const spec = getToolSpec(toolName);
    if (!spec)
        return null;
    const tokens = String(spec.versionCommand || `${toolName} --version`).split(/\s+/);
    const cmd = opts.binPath && typeof opts.binPath === 'string' ? opts.binPath : tokens[0];
    const args = tokens.slice(1);
    let result;
    try {
        result = (0, child_process_1.spawnSync)(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 1000 });
    }
    catch {
        return null;
    }
    const blob = `${(result.stdout || '').trim()}\n${(result.stderr || '').trim()}`;
    const regex = new RegExp(spec.versionRegex || 'v?(\\d+\\.\\d+\\.\\d+)');
    const match = regex.exec(blob);
    return match && match[1] ? match[1] : null;
}
// Where a tool sits vs. spec: unknown / missing / too-old / outdated / current.
function toolStatus(toolName, installedVersion) {
    const spec = getToolSpec(toolName);
    if (!spec) {
        return { installed: installedVersion || null, recommended: null, minimum: null, status: 'unknown' };
    }
    if (!installedVersion) {
        return { installed: null, recommended: spec.recommended ?? null, minimum: spec.minimum ?? null, status: 'missing' };
    }
    const vMin = compareSemver(installedVersion, spec.minimum);
    const vRec = compareSemver(installedVersion, spec.recommended);
    let status = 'current';
    if (vMin !== null && vMin < 0)
        status = 'too-old';
    else if (vRec !== null && vRec < 0)
        status = 'outdated';
    return { installed: installedVersion, recommended: spec.recommended ?? null, minimum: spec.minimum ?? null, status };
}
function probeTool(toolName, binPath) {
    const version = binPath ? probeToolVersion(toolName, { binPath }) : null;
    const status = toolStatus(toolName, version);
    return {
        binPath,
        version,
        status: status.status,
        recommended: status.recommended,
        minimum: status.minimum,
    };
}
function isToolUsable(status) {
    return status === 'current' || status === 'outdated';
}
// Merge a toolchain stamp into the in-memory state object (caller persists).
function mergeToolchainStamp(state, toolName, { version, binPath, at }) {
    const next = state && typeof state === 'object' ? state : {};
    const toolchain = next.toolchain && typeof next.toolchain === 'object' ? next.toolchain : {};
    toolchain[toolName] = {
        installedVersion: version || null,
        installedAt: at || (0, text_1.nowIsoNoMs)(),
        ...(binPath ? { binPath } : {}),
    };
    next.toolchain = toolchain;
    return next;
}
