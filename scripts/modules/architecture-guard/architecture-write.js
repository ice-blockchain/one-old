"use strict";
// src/modules/architecture-guard/architecture-write.ts
// PreToolUse file-write/file-edit architecture gate (priority 20). Assembles the
// decomposed checks ported from runCheckArchitectureWrite (gates.cjs:285-550):
//   1. preflight convergence (materialize the project on disk if needed)
//   2. project-readiness gates (monorepo / state / materialization / plan)
//   3. run-team ownership enforcement
//   4. static layout/style checks
// then emits one bundled deny. Auth is enforced by the priority-0 session gate
// before this runs.
//
// Ordering note: the legacy bundle interleaves the plan gate between run-team
// and the static checks; here the plan gate is emitted by the readiness pass
// (before run-team). The set of violations is identical — only the relative
// order of the (rarely co-occurring) plan + run-team lines differs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.architectureWriteGate = architectureWriteGate;
const result_1 = require("../../core/result");
const feature_source_1 = require("../../shared/feature-source");
const hook_paths_1 = require("../../shared/hook-paths");
const materialize_1 = require("../../shared/materialize");
const paths_1 = require("../../shared/paths");
const skill_block_1 = require("../../shared/skill-block");
const state_1 = require("../../shared/state");
const tool_classify_1 = require("../../shared/tool-classify");
const architecture_readiness_1 = require("./architecture-readiness");
const architecture_runteam_1 = require("./architecture-runteam");
const architecture_static_1 = require("./architecture-static");
const block = (0, architecture_static_1.makeArchitectureBlock)((0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot));
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function architectureWriteGate(ctx) {
    const raw = obj(ctx.input.raw) || {};
    const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName) || 'Bash';
    const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
    const rawFilePath = asString(toolInput.file_path).replace(/\\/g, '/');
    const rawCommand = (0, tool_classify_1.commandFromToolInput)(toolInput);
    const patchTargetPaths = (0, tool_classify_1.normalizedToolName)(toolName) === 'apply_patch'
        ? (0, feature_source_1.applyPatchTargetPaths)(rawCommand)
        : [];
    const cwd = ctx.cwd;
    const projectRoot = (0, hook_paths_1.findProjectRootForHookFile)(cwd, rawFilePath || patchTargetPaths[0] || '');
    const filePath = (0, hook_paths_1.projectRelativeHookPath)(cwd, projectRoot, rawFilePath);
    // Preflight convergence: ensure .traffic-one/** is current for this project
    // before we judge it (side-effect only; the outcome is intentionally ignored).
    (0, materialize_1.materializeProjectIfNeeded)(projectRoot, { trigger: 'architecture preflight convergence' });
    const content = asString(toolInput.content) || asString(toolInput.new_string) || '';
    const state = (0, state_1.readEffectiveState)(projectRoot);
    const isNative = (0, state_1.isNativeState)(state);
    // Resolve which targets are feature source (direct path + apply_patch targets).
    const featureTargetPaths = [];
    if (feature_source_1.FEATURE_SOURCE_RE.test(filePath))
        featureTargetPaths.push(filePath);
    for (const targetPath of patchTargetPaths) {
        const rel = (0, hook_paths_1.projectRelativeHookPath)(cwd, projectRoot, targetPath);
        if (feature_source_1.FEATURE_SOURCE_RE.test(rel) && !featureTargetPaths.includes(rel))
            featureTargetPaths.push(rel);
    }
    const writingFeatureSourceViaCommand = (0, tool_classify_1.isShellToolName)(toolName) && (0, feature_source_1.commandAppearsToWriteFeatureSource)(rawCommand);
    const writingFeatureSource = featureTargetPaths.length > 0 || writingFeatureSourceViaCommand;
    const violations = [];
    violations.push(...(0, architecture_readiness_1.architectureReadinessViolations)({ filePath, content, projectRoot, state, writingFeatureSource, block }));
    const runTeam = (0, architecture_runteam_1.runTeamEnforcementViolation)({
        projectRoot, filePath, state, rawData: raw, featureTargetPaths, writingFeatureSource, writingFeatureSourceViaCommand, block,
    });
    if (runTeam)
        violations.push(runTeam);
    violations.push(...(0, architecture_static_1.architectureStaticViolations)(filePath, content, isNative, block));
    if (violations.length === 0)
        return (0, result_1.noop)();
    return (0, result_1.deny)(`traffic-one — architecture violation(s):\n${violations.map((v) => `  - ${v}`).join('\n')}`);
}
