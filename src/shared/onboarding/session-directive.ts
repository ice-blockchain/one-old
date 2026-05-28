// src/shared/onboarding/session-directive.ts
// The first-run new-project SessionStart onboarding directive. Ported 1:1 from
// directives/onboardingDirectiveNewProject.cjs. The full ~460-line directive
// prose lives in the onboarding-gate skill ('onboarding-directive-new-project');
// this assembler fills the embedded composition vars (pitch labels + the 4
// onboarding popup/fallback blocks). Concise verbatim fallback — it is injected
// SessionStart context, not deny enforcement.

import { defaultBackendValue, pitchBackendLabel, pitchDeployLabel } from '../config';
import { codexDefaultModeFallbackDirective, hostPopupInstruction, openCodePopupBlock } from './directives';
import type { OnboardingBlock } from './fallbacks';
import { performancePopupBlock, teamConfirmationPopupBlock } from './perf-directives';

export function onboardingDirectiveNewProject(block: OnboardingBlock): string {
  const vars = {
    DEFAULT_BACKEND: defaultBackendValue(),
    BACKEND_LABEL: pitchBackendLabel(),
    DEPLOY_LABEL: pitchDeployLabel(),
    HOST_POPUP: hostPopupInstruction(block),
    CODEX_FALLBACK: codexDefaultModeFallbackDirective(block),
    OPENCODE_POPUP: openCodePopupBlock(block),
    PERFORMANCE_POPUP: performancePopupBlock(block),
    TEAM_CONFIRMATION_POPUP: teamConfirmationPopupBlock(block),
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
