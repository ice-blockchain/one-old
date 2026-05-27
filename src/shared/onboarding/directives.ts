// src/shared/onboarding/directives.ts
// Onboarding-flow directive PROSE assemblers (host-popup instruction, the
// agent-mode prompt, and the Codex current-thread onboarding fallback) injected
// by the session SessionStart + UserPromptSubmit handlers. Prose lives in the
// onboarding-gate skill; these assemblers fill the composition vars. Ported 1:1
// from onboarding-prompts.cjs.

import type { OnboardingBlock } from './fallbacks';

const AGENT_MODE_PROMPT_VERBATIM = [
  'Traffic One needs to know how you want to run agents for this build.',
  'How do you want to run agents for this build?',
  '',
  '1. High (Recommended) — Subagent team with max-power models',
  '2. Balanced — Subagent team with efficient mid-tier models',
  '3. Low — Main agent only with role roadmap checklist',
  '',
  'Reply with the option number or label.',
].join('\n');

export function agentModePrompt(block: OnboardingBlock): string {
  return block('agent-mode-prompt', {}, AGENT_MODE_PROMPT_VERBATIM);
}

// Alias: the legacy mobile fallback reused the agent-mode prompt verbatim.
export const codexDefaultModeFallbackAgentModePrompt = agentModePrompt;

export function hostPopupInstruction(block: OnboardingBlock): string {
  return block('host-popup-instruction', {}, [
    'Ask via the host popup tool when available:',
    'Codex `request_user_input`, Claude Code `AskUserQuestion`, or the Cursor task-UI prompt.',
    'Only if no popup tool is exposed, ask in plain chat with the numbered options,',
    'tell the user to reply with the option number or label, and stop.',
    'Do NOT emit the plain-text fallback when a popup tool is working.',
  ].join(' '));
}

export function codexDefaultModeFallbackDirective(block: OnboardingBlock): string {
  const agentMode = agentModePrompt(block);
  const verbatim = [
    'CURRENT-THREAD ONBOARDING FALLBACK (visible response, blocking):',
    'If `request_user_input` cannot be called, do not use tools and do not keep detecting/scaffolding.',
    'Before onboarding is resolved, mention only the project-detection/onboarding flow. Do not read, invoke, announce, or activate create-feature, create-page, frontend-design, tdd-workflow, or other implementation skills yet.',
    'Your next visible assistant message must be the plain-chat fallback prompt below, then you must stop for the user answer:',
    '',
    agentMode,
    '',
    "After the user answers, ask Team Confirmation for High/Balanced, then show \"Traffic One was successfully set up. Let's collect the project details next.\", collect a rich dynamic MVP project context, ask Mobile App, then ask Code Graph. Ask only the next unresolved question and stop each time.",
  ].join('\n');
  return block('codex-fallback', { AGENT_MODE_PROMPT: agentMode }, verbatim);
}
