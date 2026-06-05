// src/config/onboarding.ts
// Onboarding + session-choice knobs: the canonical project-context answer keys,
// the team-mode-change approval TTL, and the auth-choice state version + "continue
// without Traffic One" TTL. The logic that reads these lives in
// shared/onboarding/** and modules/session/auth-choice.ts.

export const PROJECT_CONTEXT_ANSWER_KEYS = [
  'audience',
  'coreFlows',
  'v1Features',
  'rolesAuth',
  'businessModel',
  'payments',
  'admin',
  'dataModel',
  'contentSource',
  'integrations',
  'engagement',
  'successMetrics',
  'constraints',
  'domainSpecific',
] as const;

export const TEAM_MODE_CHANGE_APPROVAL_TTL_MS = 10 * 60 * 1000;

export const AUTH_CHOICE_STATE_VERSION = 3;
export const AUTH_CHOICE_CONTINUE_TTL_MS = 4 * 60 * 60 * 1000;
