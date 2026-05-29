"use strict";
// src/modules/onboarding-gate/handler.ts
// PreToolUse onboarding gate (priority 10): on a new project, block mutating
// tools until onboarding is complete, surfacing the next unresolved prompt;
// repair-and-converge when onboarding is actually done. Ported 1:1 from
// runCheckOnboardingGate (gates.cjs:80). Auth is enforced by the priority-0
// session gate before this runs. Deny PROSE comes from the onboarding-gate
// skill via the shared/onboarding assemblers.
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardingGate = onboardingGate;
const result_1 = require("../../core/result");
const authoring_root_1 = require("../../shared/authoring-root");
const detection_1 = require("../../shared/detection");
const materialize_1 = require("../../shared/materialize");
const fallbacks_1 = require("../../shared/onboarding/fallbacks");
const predicates_1 = require("../../shared/onboarding/predicates");
const prompts_1 = require("../../shared/onboarding/prompts");
const repair_1 = require("../../shared/onboarding/repair");
const team_mode_approval_1 = require("../../shared/onboarding/team-mode-approval");
const local_prefs_1 = require("../../shared/onboarding/local-prefs");
const paths_1 = require("../../shared/paths");
const skill_block_1 = require("../../shared/skill-block");
const state_1 = require("../../shared/state");
const tool_classify_1 = require("../../shared/tool-classify");
const auth_choice_1 = require("../session/auth-choice");
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const block = (name, vars) => skillBlock('onboarding-gate', name, vars);
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function onboardingGate(ctx) {
    const raw = obj(ctx.input.raw) || {};
    const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
    const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
    const cwd = ctx.cwd;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return (0, result_1.noop)();
    if ((0, auth_choice_1.authChoiceAllowsContinue)(cwd))
        return (0, result_1.noop)();
    // Auth is enforced by the priority-0 session gate before this gate runs.
    const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
    const state = (0, state_1.readEffectiveState)(cwd);
    const mode = state.mode || (0, detection_1.detectMode)(cwd);
    const effectiveState = { ...state, mode };
    (0, state_1.normalizeState)(effectiveState, mode);
    if ((0, team_mode_approval_1.teamModeMarkerWriteViolation)(cwd, toolName, toolInput)) {
        return (0, result_1.deny)(block('team-mode-marker-guard', {}));
    }
    if ((0, team_mode_approval_1.teamModeDowngradeViolation)(cwd, toolName, toolInput, effectiveState)) {
        return (0, result_1.deny)(block('team-mode-downgrade-guard', {}));
    }
    // The model is allowed to write the canonical state file itself.
    if ((0, tool_classify_1.isStateFilePath)(filePath) || (0, tool_classify_1.isStateFileOnlyPatch)(toolName, toolInput))
        return (0, result_1.noop)();
    const localPrefs = (0, local_prefs_1.localPreferenceContext)(effectiveState, String(effectiveState.stack || mode), 'gate', block);
    if (localPrefs) {
        if ((0, tool_classify_1.isReadOnlyOrientationToolUse)(toolName, toolInput))
            return (0, result_1.noop)();
        return (0, result_1.deny)(localPrefs.context, {
            ...(localPrefs.promptRequest ? { promptRequest: localPrefs.promptRequest } : {}),
        });
    }
    if (mode === 'new-project' && (0, predicates_1.isNewProjectOnboardingIncomplete)(effectiveState)) {
        const repaired = (0, repair_1.repairNewProjectOnboardingState)(cwd, effectiveState, 'generic pre-tool onboarding repair');
        if (repaired) {
            if ((0, tool_classify_1.isMutatingPreToolUse)(toolName, toolInput))
                return (0, result_1.deny)((0, fallbacks_1.repairedMaterializationDenyReason)(block));
            return (0, result_1.context)(repaired.context, { systemMessage: repaired.systemMessage });
        }
        // Read-only orientation (pwd, ls, Read, Glob, Grep) is allowed so the agent
        // can locate cwd and write the state file to the right place.
        if ((0, tool_classify_1.isReadOnlyOrientationToolUse)(toolName, toolInput))
            return (0, result_1.noop)();
        if ((0, predicates_1.needsTeamConfirmation)(effectiveState)) {
            const reason = (0, fallbacks_1.teamConfirmationGateFallbackReason)(effectiveState, block);
            const promptRequest = (0, prompts_1.onboardingPromptRequestForStep)('team-confirmation', {
                level: (0, prompts_1.performanceLevelOf)(effectiveState), fallbackText: reason,
            });
            return (0, result_1.deny)(reason, { promptRequest });
        }
        const reason = (0, fallbacks_1.onboardingGateFallbackReason)(effectiveState, block);
        const promptRequest = (0, fallbacks_1.nextOnboardingPromptRequest)(effectiveState, 'gate', block);
        return (0, result_1.deny)(reason, { promptRequest });
    }
    const materialized = (0, materialize_1.materializeProjectIfNeeded)(cwd, { trigger: 'generic pre-tool convergence' });
    if (materialized) {
        if ((0, tool_classify_1.isMutatingPreToolUse)(toolName, toolInput))
            return (0, result_1.deny)((0, fallbacks_1.repairedMaterializationDenyReason)(block));
        return (0, result_1.context)(materialized.context, { systemMessage: materialized.systemMessage });
    }
    return (0, result_1.noop)();
}
