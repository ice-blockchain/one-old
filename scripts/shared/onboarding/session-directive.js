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
        CURRENT_THREAD_FALLBACK: (0, directives_1.currentThreadFallbackDirective)(block),
        OPENCODE_POPUP: (0, directives_1.openCodePopupBlock)(block),
        PERFORMANCE_POPUP: (0, perf_directives_1.performancePopupBlock)(block),
        TEAM_CONFIRMATION_POPUP: (0, perf_directives_1.teamConfirmationPopupBlock)(block),
    };
    return block('onboarding-directive-new-project', vars);
}
