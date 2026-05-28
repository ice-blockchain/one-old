"use strict";
// src/modules/materialize/converge-from-write.ts
// Materialize a project triggered by a tool write: from project-memory writes
// (materializeFromProjectMemoryWrite) or from tool-input path hints
// (materializeFromToolInputHints). Ported 1:1 from post.cjs. Returns a
// MaterializeOutcome (or null when nothing happened). The one-mcp reporter is
// injected (default no-op) — it is a Step-5 runner concern.
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
exports.materializeFromToolInputHints = materializeFromToolInputHints;
exports.materializeFromProjectMemoryWrite = materializeFromProjectMemoryWrite;
const config_1 = require("../../shared/config");
const detection_1 = require("../../shared/detection");
const hook_paths_1 = require("../../shared/hook-paths");
const authoring_root_1 = require("../../shared/authoring-root");
const materialize_1 = require("../../shared/materialize");
const state_1 = require("../../shared/state");
const text_1 = require("../../shared/text");
const path = __importStar(require("path"));
const post_helpers_1 = require("./post-helpers");
const noopReporter = () => { };
function materializeFromToolInputHints(cwd, toolInput, opts = {}) {
    const trigger = opts.trigger || 'generic post-tool convergence';
    const reportOneMcp = opts.reportOneMcp || noopReporter;
    for (const projectRoot of (0, post_helpers_1.projectRootsFromToolInputHints)(cwd, toolInput)) {
        const relativeRoot = path.relative(cwd, projectRoot).replace(/\\/g, '/') || '.';
        const result = (0, materialize_1.materializeProjectIfNeeded)(projectRoot, { trigger: `${trigger}: ${relativeRoot}`, reportOneMcp });
        const state = (0, state_1.readEffectiveState)(projectRoot);
        reportOneMcp(projectRoot, state, `${trigger}: ${relativeRoot}`);
        if (result)
            return result;
    }
    return null;
}
function materializeFromProjectMemoryWrite(cwd, filePath, opts = {}) {
    const reportOneMcp = opts.reportOneMcp || noopReporter;
    const projectRoot = (0, hook_paths_1.findProjectRootForHookFile)(cwd, filePath);
    if ((0, authoring_root_1.isPluginAuthoringRoot)(projectRoot))
        return null;
    const relativePath = (0, hook_paths_1.projectRelativeHookPath)(cwd, projectRoot, filePath);
    if (!(0, post_helpers_1.isProjectMemoryWritePath)(relativePath))
        return null;
    const state = (0, state_1.readEffectiveState)(projectRoot);
    if (!state || !state.stack || !config_1.STACK_IDS.has(state.stack) || state.onboardingComplete !== true) {
        return null;
    }
    try {
        if ((0, state_1.normalizeState)(state, (0, detection_1.detectMode)(projectRoot)))
            (0, state_1.writeState)(projectRoot, state);
        const materialized = (0, materialize_1.materializeProjectAssets)(projectRoot, state);
        if (!materialized.skipped) {
            state.materializedStack = (0, state_1.stackFingerprint)(state);
            state.materializedAt = (0, text_1.nowIsoNoMs)();
            state.materializedVersion = (0, state_1.stateVersion)();
            (0, state_1.writeState)(projectRoot, state);
        }
        reportOneMcp(projectRoot, state, `project-memory write: ${relativePath}`);
        if (!materialized || (materialized.written <= 0 && materialized.removed <= 0))
            return null;
        return {
            status: 'materialized',
            systemMessage: 'traffic-one — project-local rules/skills materialized',
            context: `Project-local rules/skills materialized after ${relativePath}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/manifest.json. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
            result: materialized,
        };
    }
    catch (error) {
        const detail = error && error.message ? error.message : String(error || 'unknown error');
        return {
            status: 'failed',
            systemMessage: 'traffic-one — project-local materialization failed',
            context: `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
            result: null,
        };
    }
}
