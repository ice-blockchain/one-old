"use strict";
// src/runners/toolchain/onboarding.ts
// Hook-owned toolchain preflight for onboarding/local-preference writes. The
// user's OpenCode/code-graph choices are the consent record; this module checks
// installed versions and installs/upgrades user-local managed tools when needed.
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
exports.ensureOpenCodeTool = ensureOpenCodeTool;
exports.ensureOnboardingToolchainContext = ensureOnboardingToolchainContext;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const exec_1 = require("../../shared/exec");
const state_1 = require("../../shared/state");
const text_1 = require("../../shared/text");
const gitnexus_1 = require("../gitnexus");
const graphify_1 = require("../graphify");
const index_1 = require("./index");
const which = exec_1.exec.which;
function writeStateMerge(cwd, patch) {
    try {
        (0, state_1.mergeProjectPrefs)(cwd, patch);
    }
    catch {
        // best-effort; the hook should not fail the user's write.
    }
}
function stampToolchain(cwd, toolName, binPath, version) {
    if (!version)
        return;
    const current = (0, state_1.readEffectiveState)(cwd);
    const updated = (0, index_1.mergeToolchainStamp)(current, toolName, { version, binPath, at: (0, text_1.nowIso)() });
    writeStateMerge(cwd, { toolchain: updated.toolchain });
}
function opencodePackageSpec() {
    const spec = (0, index_1.getToolSpec)('opencode');
    const pkg = typeof spec?.npmPackage === 'string' && spec.npmPackage ? spec.npmPackage : 'opencode-ai';
    return typeof spec?.recommended === 'string' && spec.recommended ? `${pkg}@${spec.recommended}` : pkg;
}
function ensureOpenCodeTool(cwd = process.cwd()) {
    const managedBin = (0, index_1.managedNpmBin)('opencode', 'opencode');
    const candidates = [
        { binPath: fs.existsSync(managedBin) ? managedBin : null, action: 'used-managed' },
        { binPath: which('opencode'), action: 'used-existing' },
    ];
    for (const candidate of candidates) {
        if (!candidate.binPath)
            continue;
        const probed = (0, index_1.probeTool)('opencode', candidate.binPath);
        if ((0, index_1.isToolUsable)(probed.status)) {
            stampToolchain(cwd, 'opencode', candidate.binPath, probed.version);
            return { tool: 'opencode', ok: true, action: candidate.action, error: null, binPath: candidate.binPath, installedVersion: probed.version };
        }
    }
    const npm = which('npm');
    if (!npm) {
        return { tool: 'opencode', ok: false, action: 'install-skipped', error: '`npm` is not on PATH, so the hook cannot install OpenCode automatically', binPath: null };
    }
    const result = (0, child_process_1.spawnSync)(npm, ['install', '-g', '--prefix', (0, index_1.managedNpmPrefix)('opencode'), opencodePackageSpec()], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180 * 1000,
    });
    if (result.status !== 0 || !fs.existsSync(managedBin)) {
        return {
            tool: 'opencode',
            ok: false,
            action: 'install-skipped',
            error: `managed npm install of OpenCode failed: ${(result.stderr || '').trim() || 'non-zero exit'}`,
            binPath: null,
        };
    }
    const installedVersion = (0, index_1.probeToolVersion)('opencode', { binPath: managedBin });
    stampToolchain(cwd, 'opencode', managedBin, installedVersion);
    return { tool: 'opencode', ok: true, action: 'installed-managed-npm', error: null, binPath: managedBin, installedVersion };
}
function normalizeGraphifyResult(result) {
    return {
        tool: 'graphify',
        ok: result.ok,
        action: result.action,
        error: result.error,
        binPath: result.binPath,
        installedVersion: result.installedVersion,
    };
}
function shouldMention(result) {
    if (!result.ok)
        return true;
    return !['used-existing', 'used-managed', 'used-nvm-v22'].includes(result.action);
}
function formatResult(result) {
    if (!shouldMention(result))
        return null;
    if (result.ok) {
        const version = result.installedVersion ? ` ${result.installedVersion}` : '';
        return `[toolchain] ${result.tool}${version} ready via hook-owned ${result.action}.`;
    }
    return `[toolchain] ${result.tool} install/upgrade failed: ${result.error || 'unknown error'}.`;
}
function ensureOnboardingToolchainContext(cwd) {
    const state = (0, state_1.readEffectiveState)(cwd);
    const results = [];
    const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
    if (provider === 'graphify') {
        results.push(normalizeGraphifyResult((0, graphify_1.ensureGraphifyTool)(cwd)));
    }
    else if (provider === 'gitnexus') {
        const result = (0, gitnexus_1.ensureGitnexusTool)(cwd);
        results.push({
            tool: 'gitnexus',
            ok: result.ok,
            action: result.action,
            error: result.error,
            binPath: result.gitnexusBin,
            installedVersion: result.installedVersion,
        });
    }
    const openCode = state.openCode && typeof state.openCode === 'object' ? state.openCode : null;
    if (openCode?.enabled === true) {
        results.push(ensureOpenCodeTool(cwd));
    }
    const lines = results.map(formatResult).filter((line) => Boolean(line));
    return lines.length > 0 ? lines.join('\n') : null;
}
