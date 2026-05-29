// src/shared/onboarding/session-directive.ts
// The first-run new-project SessionStart onboarding directive. Ported 1:1 from
// directives/onboardingDirectiveNewProject.cjs. The full ~460-line directive
// prose lives in the onboarding-gate skill ('onboarding-directive-new-project');
// this assembler fills the embedded composition vars (pitch labels + the 4
// onboarding popup/fallback blocks). Concise verbatim fallback — it is injected
// SessionStart context, not deny enforcement.

import { defaultBackendValue, pitchBackendLabel, pitchDeployLabel } from '../config';
import { currentThreadFallbackDirective, hostPopupInstruction, openCodePopupBlock } from './directives';
import type { OnboardingBlock } from './fallbacks';
import { performancePopupBlock, teamConfirmationPopupBlock } from './perf-directives';

export function onboardingDirectiveNewProject(block: OnboardingBlock): string {
  const vars = {
    DEFAULT_BACKEND: defaultBackendValue(),
    BACKEND_LABEL: pitchBackendLabel(),
    DEPLOY_LABEL: pitchDeployLabel(),
    HOST_POPUP: hostPopupInstruction(block),
    CURRENT_THREAD_FALLBACK: currentThreadFallbackDirective(block),
    OPENCODE_POPUP: openCodePopupBlock(block),
    PERFORMANCE_POPUP: performancePopupBlock(block),
    TEAM_CONFIRMATION_POPUP: teamConfirmationPopupBlock(block),
  };
  return block('onboarding-directive-new-project', vars);
}
