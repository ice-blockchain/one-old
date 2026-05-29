"use strict";
// src/modules/session/session-start-lib.ts
// Local SessionStart helpers: digest retention sweep, graph-preview read, the
// token-economy banner, and session-time materialization convergence. Ported
// 1:1 from session-start.cjs + tokenEconomyBanner (_helpers.cjs). The toolchain
// drift probe + the one-mcp reporter are Step-5 runner concerns, injected here
// as optional dependencies (default: no-op) so this stays runner-free.
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
exports.sweepOldDigests = sweepOldDigests;
exports.readGraphPreview = readGraphPreview;
exports.tokenEconomyBanner = tokenEconomyBanner;
exports.ensureSessionMaterialization = ensureSessionMaterialization;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const authoring_root_1 = require("../../shared/authoring-root");
const config_1 = require("../../shared/config");
const detection_1 = require("../../shared/detection");
const materialize_1 = require("../../shared/materialize");
const text_1 = require("../../shared/text");
const state_1 = require("../../shared/state");
// Keep the newest `keepCount` orchestrator digest runs; remove older ones.
function sweepOldDigests(cwd, keepCount = 5) {
    const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
    if (!fs.existsSync(digestsRoot))
        return 0;
    let entries;
    try {
        entries = fs.readdirSync(digestsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort()
            .reverse();
    }
    catch {
        return 0;
    }
    let removed = 0;
    for (const name of entries.slice(keepCount)) {
        try {
            fs.rmSync(path.join(digestsRoot, name), { recursive: true, force: true });
            removed += 1;
        }
        catch {
            // best-effort; never block SessionStart on retention sweep
        }
    }
    return removed;
}
// The ~500-token graph preview written by the gitnexus/graphify runners.
function readGraphPreview(cwd) {
    const previewPath = path.join(cwd, '.traffic-one', 'graph-preview.md');
    if (!fs.existsSync(previewPath))
        return '';
    try {
        return `\n${fs.readFileSync(previewPath, 'utf8').trimEnd()}\n`;
    }
    catch {
        return '';
    }
}
// Memory / codebase-graph / digest / toolchain-drift hints injected at session
// start. The toolchain drift hints require a probe (Step-5 toolchain runner);
// when omitted, only the memory/graph/digest banners are emitted.
function tokenEconomyBanner(cwd, probe) {
    const lines = [];
    const memoryPaths = [
        '.traffic-one/product.md', '.traffic-one/stack.md', '.traffic-one/coding.md',
        '.traffic-one/security.md', '.traffic-one/known-issues.md', '.traffic-one/agent-log.md',
    ];
    if (memoryPaths.some((relPath) => fs.existsSync(path.join(cwd, relPath)))) {
        lines.push('[memory] .traffic-one/ project memory present — read product/stack/rules/known-issues before broad source reads.');
    }
    if (fs.existsSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'))) {
        lines.push('[graph: graphify] graphify-out/GRAPH_REPORT.md present — consult before grep/glob for module/structure questions.');
    }
    if (fs.existsSync(path.join(cwd, '.gitnexus'))) {
        lines.push('[graph: gitnexus] .gitnexus/ present — consult before grep/glob for module/structure questions.');
    }
    try {
        const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
        if (fs.existsSync(digestsRoot)) {
            const runs = fs.readdirSync(digestsRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
            if (runs.length > 0) {
                lines.push(`[digests] Latest orchestrator run: .traffic-one/digests/${runs[0]}/ — read predecessor digests before re-reading the diff.`);
            }
        }
    }
    catch {
        // best-effort; banner is informational
    }
    if (probe) {
        try {
            const state = (0, state_1.readEffectiveState)(cwd);
            const toolchain = (state && state.toolchain) || {};
            for (const [name, stamp] of Object.entries(toolchain)) {
                const installedVersion = stamp && typeof stamp === 'object' ? stamp.installedVersion : null;
                const status = probe.toolStatus(name, installedVersion);
                if (status.status === 'too-old') {
                    const spec = probe.getToolSpec(name) || {};
                    lines.push(`[toolchain] ${name} ${status.installed} is below the minimum supported (${status.minimum}). Upgrade: \`${spec.installCommand || `<upgrade ${name}>`}\`.`);
                }
                else if (status.status === 'outdated') {
                    lines.push(`[toolchain] ${name} ${status.installed} installed; recommended is ${status.recommended}.`);
                }
            }
        }
        catch {
            // best-effort; banner is informational
        }
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
}
// Converge session-time materialization for an onboarded project. Returns true
// when it (re)materialized. The one-mcp reporter is injected (default no-op).
function ensureSessionMaterialization(cwd, state, reportOneMcp = () => { }) {
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return false;
    if (!state || typeof state !== 'object')
        return false;
    if (state.onboardingComplete !== true)
        return false;
    if (!state.stack || !config_1.STACK_IDS.has(state.stack))
        return false;
    if ((0, state_1.isMaterialized)(state) && (0, materialize_1.hasMaterializedProjectAssets)(cwd, state)) {
        reportOneMcp(cwd, state, 'session materialization already current');
        return false;
    }
    (0, state_1.normalizeState)(state, state.mode || (0, detection_1.detectMode)(cwd));
    const materialized = (0, materialize_1.materializeProjectAssets)(cwd, state);
    if (materialized.skipped) {
        reportOneMcp(cwd, state, 'session materialization skipped');
        return false;
    }
    state.materializedStack = (0, state_1.stackFingerprint)(state);
    state.materializedAt = (0, text_1.nowIsoNoMs)();
    state.materializedVersion = (0, state_1.stateVersion)();
    (0, state_1.writeState)(cwd, state);
    reportOneMcp(cwd, state, 'session materialization');
    return true;
}
