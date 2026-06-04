"use strict";
// src/modules/onboarding-gate/handler.ts
// PreToolUse onboarding gate (priority 10): until onboarding is complete, ensure
// the local wizard server is running and DENY mutating tools with its URL. The
// questions + per-answer state writes now live in the wizard server
// (shared/onboarding-server), not in agent prose — so this gate no longer emits
// per-step popups or chat fallbacks. Auth is enforced by the priority-0 session
// gate before this runs. Read-only orientation and writing the canonical state
// file stay allowed; once onboarding is complete we converge materialization
// exactly as before. Completeness is computed by the SAME predicates the wizard
// uses (computeOnboarding), covering both new-project onboarding and an existing
// project missing this user's local preferences.
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardingGate = onboardingGate;
const coerce_1 = require("../../adapters/coerce");
const obj_1 = require("../../shared/obj");
const result_1 = require("../../core/result");
const authoring_root_1 = require("../../shared/authoring-root");
const detection_1 = require("../../shared/detection");
const materialize_1 = require("../../shared/materialize");
const ensure_1 = require("../../shared/onboarding-server/ensure");
const flow_1 = require("../../shared/onboarding-server/flow");
const team_mode_approval_1 = require("../../shared/onboarding/team-mode-approval");
const paths_1 = require("../../shared/paths");
const skill_block_1 = require("../../shared/skill-block");
const state_1 = require("../../shared/state");
const tool_classify_1 = require("../../shared/tool-classify");
const auth_choice_1 = require("../session/auth-choice");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const block = (name, vars = {}) => skillBlock('onboarding-gate', name, vars);
function onboardingGate(ctx) {
    const raw = (0, obj_1.obj)(ctx.input.raw) || {};
    const toolName = ctx.input.tool?.rawName || (0, coerce_1.asString)(raw.tool_name ?? raw.toolName);
    const toolInput = (0, obj_1.obj)(raw.tool_input) || (0, obj_1.obj)(raw.toolInput) || {};
    const cwd = ctx.cwd;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return (0, result_1.noop)();
    if ((0, auth_choice_1.authChoiceAllowsContinue)(cwd))
        return (0, result_1.noop)();
    // Auth is enforced by the priority-0 session gate before this gate runs.
    const filePath = ctx.input.tool?.filePath || (0, coerce_1.asString)(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
    const state = (0, state_1.readEffectiveState)(cwd);
    const mode = state.mode || (0, detection_1.detectMode)(cwd);
    const effectiveState = { ...state, mode };
    (0, state_1.normalizeState)(effectiveState, mode);
    // Team-mode write guards stay active — these are post-onboarding runtime
    // guardrails, not onboarding questions.
    if ((0, team_mode_approval_1.teamModeMarkerWriteViolation)(cwd, toolName, toolInput)) {
        return (0, result_1.deny)(block('team-mode-marker-guard'));
    }
    if ((0, team_mode_approval_1.teamModeDowngradeViolation)(cwd, toolName, toolInput, effectiveState)) {
        return (0, result_1.deny)(block('team-mode-downgrade-guard'));
    }
    // The model is allowed to write the canonical state file itself.
    if ((0, tool_classify_1.isStateFilePath)(filePath) || (0, tool_classify_1.isStateFileOnlyPatch)(toolName, toolInput))
        return (0, result_1.noop)();
    if (!(0, flow_1.computeOnboarding)(cwd).done) {
        // Read-only orientation (pwd, ls, Read, Glob, Grep) is allowed so the agent
        // can find its bearings while the user completes the wizard.
        if ((0, tool_classify_1.isReadOnlyOrientationToolUse)(toolName, toolInput))
            return (0, result_1.noop)();
        const server = (0, ensure_1.ensureOnboardingServer)(cwd);
        return (0, result_1.deny)(block('server-deny-reason', { URL: server.url }));
    }
    const materialized = (0, materialize_1.materializeProjectIfNeeded)(cwd, { trigger: 'generic pre-tool convergence' });
    if (materialized) {
        if ((0, tool_classify_1.isMutatingPreToolUse)(toolName, toolInput))
            return (0, result_1.deny)(block('repaired-materialization'));
        return (0, result_1.context)(materialized.context, { systemMessage: materialized.systemMessage });
    }
    return (0, result_1.noop)();
}
