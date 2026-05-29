// src/shared/onboarding/directives.ts
// Onboarding-flow directive PROSE assemblers (host-popup instruction, the
// agent-mode prompt, the Codex current-thread onboarding fallback, and the
// condensed UserPromptSubmit reminder) injected by the session SessionStart +
// UserPromptSubmit handlers. The wording lives in the onboarding-gate SKILL.md;
// these assemblers only fill the composition vars. Ported from
// onboarding-prompts.cjs.

import { OPEN_CODE_INSTALL, openCodeChatFallback, type OnboardingBlock } from './fallbacks';

export function agentModePrompt(block: OnboardingBlock): string {
  return block('agent-mode-prompt', {});
}

export function hostPopupInstruction(block: OnboardingBlock): string {
  return block('host-popup-instruction', {});
}

export function codexDefaultModeFallbackDirective(block: OnboardingBlock): string {
  const agentMode = agentModePrompt(block);
  const openCode = openCodeChatFallback(block);
  return block('codex-fallback', { OPEN_CODE_PROMPT: openCode, AGENT_MODE_PROMPT: agentMode });
}

// Condensed reminder re-injected on UserPromptSubmit while a new project hasn't
// persisted a valid stack (SessionStart's full directive can scroll out). The
// full prose + required-state schema live in the skill; this fills the embedded
// Codex fallback.
export function onboardingReminderShort(block: OnboardingBlock): string {
  const codexFallback = codexDefaultModeFallbackDirective(block);
  return block('onboarding-reminder', { CODEX_FALLBACK: codexFallback });
}

// SessionStart "popup 0": the OpenCode delegation preflight (asked first, before
// the Performance popup). Composes the host-popup instruction.
export function openCodePopupBlock(block: OnboardingBlock): string {
  const hostPopup = hostPopupInstruction(block);
  return block('opencode-popup', { INSTALL: OPEN_CODE_INSTALL, HOST_POPUP: hostPopup });
}
