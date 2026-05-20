'use strict';

const MOBILE_PROMPT_LINES = [
  'Do you want a mobile app too?',
  '',
  '1. Web only (Recommended)',
  '2. Ionic + Capacitor',
  '3. React Native / Expo',
  '',
  'Reply with the option number or label.',
];

// Host-agnostic popup instruction. Onboarding choices must use the host's
// native popup tool; the plain-text numbered fallback is a true last resort and
// must NOT be emitted when a popup tool is working.
function hostPopupInstruction() {
  return [
    'Ask via the host popup tool when available:',
    'Codex `request_user_input`, Claude Code `AskUserQuestion`, or the Cursor task-UI prompt.',
    'Only if no popup tool is exposed, ask in plain chat with the numbered options,',
    'tell the user to reply with the option number or label, and stop.',
    'Do NOT emit the "Plan mode is required / popup prompt is unavailable" plain-text fallback when a popup tool is working.',
  ].join(' ');
}

function codexDefaultModeFallbackMobilePrompt() {
  return [
    'Plan mode is required for Traffic One new-project onboarding, but Plan mode is not active here and the popup prompt is unavailable.',
    '',
    ...MOBILE_PROMPT_LINES,
  ].join('\n');
}

function codexDefaultModeFallbackDirective() {
  return [
    'CODEX DEFAULT-MODE FALLBACK (visible response, blocking):',
    'If the current Codex thread is not in Plan mode, or `request_user_input` cannot be called, do not use tools and do not keep detecting/scaffolding.',
    'Before onboarding is resolved, mention only the project-detection/onboarding flow. Do not say you are using create-feature, create-page, frontend-design, tdd-workflow, or other implementation skills yet.',
    'Your next visible assistant message must be the plain-chat fallback prompt below, then you must stop for the user answer:',
    '',
    codexDefaultModeFallbackMobilePrompt(),
    '',
    'After the user answers, ask the Code Graph fallback prompt next, then the Performance fallback prompt for non-trivial multi-layer builds (options: "1. Balanced (Recommended)", "2. High", "3. Low"). Ask only the next unresolved question and stop each time.',
  ].join('\n');
}

module.exports = {
  hostPopupInstruction,
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
};
