"use strict";
// src/modules/plan-guard/plan-readiness.ts
// The project-readiness half of the plan-write gate: monorepo scaffold,
// state-file presence, materialization, and plan gates. Ported 1:1 from
// runCheckPlanWrite, minus the run-team enforcement
// gate (which lands separately). `writingFeatureSource` is precomputed by the
// caller from the feature-source helpers — this keeps the readiness logic
// independently testable. Deny PROSE comes from skill/SKILL.md via skillBlock.
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
exports.planReadinessViolations = planReadinessViolations;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const config_1 = require("../../shared/config");
const authoring_root_1 = require("../../shared/authoring-root");
const detection_1 = require("../../shared/detection");
const hook_paths_1 = require("../../shared/hook-paths");
const materialize_1 = require("../../shared/materialize");
const state_1 = require("../../shared/state");
const PLAN_FILE_RE = /(^|\/)\.traffic-one\/plan\.md$/;
const ADR_OR_DOC_RE = /(^|\/)(docs|architecture|README|ADR)/i;
const ROOT_VITE_RE = /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/;
// Readiness violations for a single write/edit. Empty array == nothing to block.
function planReadinessViolations(args) {
    const { filePath, content, projectRoot, state, writingFeatureSource, block } = args;
    const violations = [];
    const requiresMonorepoScaffold = (0, hook_paths_1.stateRequiresNewProjectMonorepo)(state);
    if (requiresMonorepoScaffold && filePath === 'package.json' && !(0, hook_paths_1.packageJsonDeclaresWorkspace)(content)) {
        violations.push(block('monorepo-package-json', 'New-project monorepo gate: stack=default / React-Vite new projects must start with the Traffic One Turborepo root package.json: `private: true`, `packageManager: pnpm@...`, and workspaces for `apps/*` and `packages/*`. Read `rules/modes/new-project.md` and scaffold the monorepo before feature code.'));
    }
    if (requiresMonorepoScaffold && ROOT_VITE_RE.test(filePath)) {
        violations.push(block('monorepo-root-vite', 'New-project monorepo gate: root Vite app files are not allowed for this stack. Use `apps/web/` for the React app and create the required `packages/*` workspaces first; see `rules/modes/new-project.md`.'));
    }
    const validStateStack = Boolean(state.stack && (0, config_1.isKnownStack)(state.stack));
    const stateMissing = !fs.existsSync((0, state_1.statePath)(projectRoot)) && !fs.existsSync((0, state_1.legacyStatePath)(projectRoot));
    const memoryPresent = fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'))
        || fs.existsSync(path.join(projectRoot, '.traffic-one', 'stack.md'));
    const detectedModeForState = state.mode || (stateMissing ? (0, detection_1.detectMode)(projectRoot) : null);
    if (writingFeatureSource && !validStateStack && (detectedModeForState === 'new-project' || memoryPresent)) {
        violations.push(block('state-gate', 'State gate: root .traffic-one/.one.json is missing or incomplete. Write the Traffic One state file with mode, stack, backend, realtime, confirmed, onboardingComplete, and confirmedAt before writing feature source. The .traffic-one/ folder is project memory, not the stack-selection state file.'));
    }
    const hasMaterializedAssets = (0, materialize_1.hasMaterializedProjectAssets)(projectRoot, state);
    const featureContextMaterialized = (0, authoring_root_1.isPluginAuthoringRoot)(projectRoot)
        || !state.onboardingComplete
        || ((0, state_1.isMaterialized)(state) && hasMaterializedAssets);
    if (writingFeatureSource && !featureContextMaterialized) {
        violations.push(block('materialization-gate', `Materialization gate: stack context for ${(0, state_1.stackFingerprint)(state)} has not been materialized on disk yet. Run \`node "\${TRAFFIC_ONE_PLUGIN_ROOT:-\${CODEX_PLUGIN_ROOT:-\${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project\` from the project root and verify \`.traffic-one/rules/**\`, \`.traffic-one/skills/**\`, \`.traffic-one/manifest.json\`, root \`AGENTS.md\`, and root \`CLAUDE.md\` exist before writing feature source.`, { FINGERPRINT: (0, state_1.stackFingerprint)(state) }));
    }
    const isNewProject = state.mode === 'new-project';
    const planMissing = !fs.existsSync(path.join(projectRoot, '.traffic-one', 'plan.md'));
    const writingPlan = PLAN_FILE_RE.test(filePath);
    const writingDoc = ADR_OR_DOC_RE.test(filePath);
    if (isNewProject && planMissing && writingFeatureSource && !writingPlan && !writingDoc) {
        violations.push(block('plan-gate', 'Plan gate: .traffic-one/plan.md is missing on a new project. Run the `senior-architect` subagent (or the `senior-eng-orchestrator` skill) to produce the plan before writing feature source files. Allowed without a plan: .traffic-one/plan.md itself, .traffic-one/ project memory, root docs, legacy docs/, README.'));
    }
    return violations;
}
