// src/shared/prompt-request.ts
// Host modal/popup-input request specs. Shared by the auth + agent-model gates.
// The new-project onboarding popups were removed when onboarding moved into the
// local wizard server — the wizard owns those questions now.

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
