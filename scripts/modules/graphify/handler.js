"use strict";
// src/modules/graphify/handler.ts
// PreToolUse(search) hint: tell the agent to read the active codebase-graph
// artefact before grep/glob. Ported 1:1 from runPreGraphifyHint in
// scripts/hook-runtime/handlers/post.cjs. Non-blocking (context only),
// auth-gated, provider-aware, and throttled to once per process per cwd.
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
exports.resetGraphifyHintThrottle = resetGraphifyHintThrottle;
exports.preGraphifyHint = preGraphifyHint;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const result_1 = require("../../core/result");
const auth_1 = require("../../shared/auth");
const state_1 = require("../../shared/state");
let graphifyHintSentForCwd = null;
// Test helper: reset the per-process throttle marker.
function resetGraphifyHintThrottle() {
    graphifyHintSentForCwd = null;
}
function preGraphifyHint(ctx) {
    if (!(0, auth_1.isAuthenticatedLocal)())
        return (0, result_1.noop)();
    const cwd = ctx.cwd;
    if (graphifyHintSentForCwd === cwd)
        return (0, result_1.noop)();
    const state = (0, state_1.readEffectiveState)(cwd);
    const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
    let label;
    let artefactPath;
    if (provider === 'gitnexus') {
        artefactPath = path.join(cwd, '.gitnexus');
        label = '[graph: gitnexus] `.gitnexus/` knowledge graph present';
    }
    else {
        artefactPath = path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md');
        label = '[graph: graphify] `graphify-out/GRAPH_REPORT.md` present';
    }
    if (!fs.existsSync(artefactPath))
        return (0, result_1.noop)();
    graphifyHintSentForCwd = cwd;
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
    const digestHint = runId ? ` Predecessor digests (if any) live under \`.traffic-one/digests/${runId}/\`.` : '';
    return (0, result_1.context)(`${label} — read it FIRST for module / file / call-site questions before grep/glob.${digestHint}`);
}
