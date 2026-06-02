// src/shared/prompt-request.ts
// Host modal/popup-input request specs. Ported 1:1 from the prompt-request
// builders in scripts/hook-runtime/handlers/_helpers.cjs. Shared by the auth,
// onboarding, and agent-model gates.

export interface PromptOption {
  id: string;
  label: string;
}

export interface PromptRequest {
  id: string;
  kind: string;
  title: string;
  question: string;
  blocking: boolean;
  options?: PromptOption[];
  sensitive?: boolean;
  fallbackText?: string;
}

export function singleSelectPromptRequest(args: {
  id: string;
  title: string;
  question: string;
  options: PromptOption[];
  fallbackText?: string;
}): PromptRequest {
  return {
    id: args.id,
    kind: 'single_select',
    title: args.title,
    question: args.question,
    options: args.options,
    blocking: true,
    ...(args.fallbackText ? { fallbackText: args.fallbackText } : {}),
  };
}

export function secureTextPromptRequest(args: {
  id: string;
  title: string;
  question: string;
  fallbackText?: string;
}): PromptRequest {
  return {
    id: args.id,
    kind: 'secure_text',
    title: args.title,
    question: args.question,
    blocking: true,
    sensitive: true,
    ...(args.fallbackText ? { fallbackText: args.fallbackText } : {}),
  };
}

export function authChoicePromptRequest(fallbackText?: string): PromptRequest {
  return singleSelectPromptRequest({
    id: 'traffic-one.auth.choice',
    title: 'Traffic One',
    question: 'Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?',
    options: [
      { id: 'authenticate', label: 'Authenticate Traffic One (Recommended)' },
      { id: 'continue_without', label: 'Continue without Traffic One' },
    ],
    ...(fallbackText ? { fallbackText } : {}),
  });
}

export function authApiKeyPromptRequest(fallbackText?: string): PromptRequest {
  return secureTextPromptRequest({
    id: 'traffic-one.auth.api-key',
    title: 'Traffic One API Key',
    question: 'Enter your Traffic One API key.',
    ...(fallbackText ? { fallbackText } : {}),
  });
}

export function sessionExpiredPromptRequest(fallbackText?: string): PromptRequest {
  return secureTextPromptRequest({
    id: 'traffic-one.auth.session-expired',
    title: 'Traffic One Session Expired',
    question: 'Your Traffic One session expired. Enter your Traffic One API key to re-authenticate.',
    ...(fallbackText ? { fallbackText } : {}),
  });
}

// ── New-project onboarding popup requests (ported 1:1 from _helpers.cjs) ──────

export function openCodePromptRequest(fallbackText?: string): PromptRequest {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.open-code',
    title: 'OpenCode',
    question: 'Save tokens with OpenCode and approve hook-owned CLI install/upgrade if needed?',
    options: [
      { id: 'enable', label: 'Enable OpenCode delegation' },
      { id: 'not_now', label: 'Not now' },
    ],
    ...(fallbackText ? { fallbackText } : {}),
  });
}

export function performancePromptRequest(fallbackText?: string): PromptRequest {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.performance',
    title: 'Performance',
    question: 'How do you want to run agents for this build?',
    options: [
      { id: 'high', label: 'High (Recommended)' },
      { id: 'balanced', label: 'Balanced' },
      { id: 'low', label: 'Low' },
    ],
    ...(fallbackText ? { fallbackText } : {}),
  });
}

export function mobilePromptRequest(fallbackText?: string): PromptRequest {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.mobile',
    title: 'Mobile App',
    question: 'Do you want a mobile app too?',
    options: [
      { id: 'web_only', label: 'Web only (Recommended)' },
      { id: 'ionic_capacitor', label: 'Ionic + Capacitor' },
      { id: 'react_native_expo', label: 'React Native / Expo' },
    ],
    ...(fallbackText ? { fallbackText } : {}),
  });
}

export function codeGraphPromptRequest(fallbackText?: string): PromptRequest {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.code-graph',
    title: 'Code Graph',
    question: 'Which provider should Traffic One use and install/upgrade for the codebase graph?',
    options: [
      { id: 'gitnexus', label: 'GitNexus' },
      { id: 'graphify', label: 'graphify' },
    ],
    ...(fallbackText ? { fallbackText } : {}),
  });
}

export function teamConfirmationPromptRequest(level: string, fallbackText?: string): PromptRequest {
  return singleSelectPromptRequest({
    id: 'traffic-one.onboarding.team-confirmation',
    title: 'Team',
    question: `Approve the ${level || 'selected'} team line-up above?`,
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'repick_performance', label: 'Re-pick performance' },
      { id: 'customise', label: 'Customise' },
    ],
    ...(fallbackText ? { fallbackText } : {}),
  });
}

export function projectContextPromptRequest(fallbackText?: string): PromptRequest {
  return {
    id: 'traffic-one.onboarding.project-context',
    kind: 'text',
    title: 'Project Context',
    question: 'Answer the MVP-context questions in one reply so the build plan is complete.',
    blocking: true,
    ...(fallbackText ? { fallbackText } : {}),
  };
}
