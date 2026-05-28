"use strict";
// src/shared/onboarding/session-directive.ts
// The first-run new-project SessionStart onboarding directive. Ported 1:1 from
// directives/onboardingDirectiveNewProject.cjs. The full ~460-line directive
// prose lives in the onboarding-gate skill ('onboarding-directive-new-project');
// this assembler fills the embedded composition vars (pitch labels + the 4
// onboarding popup/fallback blocks). Concise verbatim fallback — it is injected
// SessionStart context, not deny enforcement.
Object.defineProperty(exports, "__esModule", { value: true });
exports.onboardingDirectiveNewProject = onboardingDirectiveNewProject;
const config_1 = require("../config");
const directives_1 = require("./directives");
const perf_directives_1 = require("./perf-directives");
function onboardingDirectiveNewProject(block) {
    const vars = {
        DEFAULT_BACKEND: (0, config_1.defaultBackendValue)(),
        BACKEND_LABEL: (0, config_1.pitchBackendLabel)(),
        DEPLOY_LABEL: (0, config_1.pitchDeployLabel)(),
        HOST_POPUP: (0, directives_1.hostPopupInstruction)(block),
        CODEX_FALLBACK: (0, directives_1.codexDefaultModeFallbackDirective)(block),
        OPENCODE_POPUP: (0, directives_1.openCodePopupBlock)(block),
        PERFORMANCE_POPUP: (0, perf_directives_1.performancePopupBlock)(block),
        TEAM_CONFIRMATION_POPUP: (0, perf_directives_1.teamConfirmationPopupBlock)(block),
    };
    const fallback = [
        '═══ traffic-one — FIRST-RUN ONBOARDING (new project) ═══',
        '',
        `New project. Recommend the default stack (react-vite + ${vars.DEFAULT_BACKEND}) and complete Traffic One onboarding in the current thread before scaffolding/installs/file writes.`,
        'Required popup order (host popup tool when available; else plain-chat fallback and stop): OpenCode opt-in → Performance (High/Balanced/Low) → Team Confirmation (mandatory for Balanced/High) → success message → project context → Mobile App → Code Graph provider. Never auto-answer a popup.',
        '',
        vars.OPENCODE_POPUP,
        '',
        vars.PERFORMANCE_POPUP,
        '',
        vars.TEAM_CONFIRMATION_POPUP,
        '',
        'After the rule bundle loads, scaffold the Turborepo workspace per rules/modes/new-project.md before any feature code. Write the full onboarding schema to .traffic-one/.one.json (relative path).',
    ].join('\n');
    return block('onboarding-directive-new-project', vars, fallback);
}
