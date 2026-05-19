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
    'After the user answers, ask the Code Graph fallback prompt next, then the Team fallback prompt for non-trivial multi-layer builds. Ask only the next unresolved question and stop each time.',
  ].join('\n');
}

module.exports = {
  codexDefaultModeFallbackDirective,
  codexDefaultModeFallbackMobilePrompt,
};
