// src/shared/onboarding/prompts.ts
// New-project onboarding step ROUTER + popup request dispatch (pure logic). The
// directive PROSE (chat fallbacks shown when no popup tool is available) lives
// in the onboarding-gate module's skill and is supplied as `fallbackText`; this
// keeps routing logic prose-free. Ported 1:1 from nextOnboardingStep /
// nextOnboardingStepPromptAndRequest (_helpers.cjs).

import { obj, type Rec } from '../obj';
import {
  codeGraphPromptRequest,
  mobilePromptRequest,
  openCodePromptRequest,
  performancePromptRequest,
  projectContextPromptRequest,
  teamConfirmationPromptRequest,
  type PromptRequest,
} from '../prompt-request';
import {
  hasResolvedNewProjectMobileState,
  hasResolvedOpenCodeState,
  hasValidPerformanceState,
  hasValidProjectContext,
  hasValidTeamState,
} from '../state';
import { needsTeamConfirmation } from './predicates';

export type OnboardingStep =
  | 'open-code'
  | 'performance'
  | 'team-confirmation'
  | 'team'
  | 'project-context'
  | 'mobile'
  | 'code-graph'
  | 'state';

// The next unresolved onboarding step for a new project, in canonical order, or
// null when mode !== "new-project". 'state' means all prompts answered but the
// canonical state file still needs writing.
export function nextOnboardingStep(state: unknown): OnboardingStep | null {
  const s = obj(state);
  if (!s || s.mode !== 'new-project') return null;
  if (!hasResolvedOpenCodeState(s.openCode)) return 'open-code';
  if (!hasValidPerformanceState(s.performance)) return 'performance';
  if (needsTeamConfirmation(s)) return 'team-confirmation';
  if (!hasValidTeamState(s.team)) return 'team';
  if (!hasValidProjectContext(s.projectContext)) return 'project-context';
  if (!hasResolvedNewProjectMobileState(s.mobile)) return 'mobile';
  if (s.codeGraphProvider !== 'gitnexus' && s.codeGraphProvider !== 'graphify') return 'code-graph';
  return 'state';
}

export function performanceLevelOf(state: unknown): string {
  const s = obj(state);
  const perf = s && obj(s.performance);
  return perf && typeof perf.level === 'string' ? perf.level : 'selected';
}

// Build the host popup request for a given onboarding step. Returns null for the
// terminal 'state' step (no popup — the model just writes the state file). The
// `fallbackText` (chat-fallback prose) is supplied by the caller from a skill.
export function onboardingPromptRequestForStep(
  step: OnboardingStep,
  opts: { level?: string; fallbackText?: string } = {},
): PromptRequest | null {
  const { level, fallbackText } = opts;
  switch (step) {
    case 'open-code': return openCodePromptRequest(fallbackText);
    case 'performance': return performancePromptRequest(fallbackText);
    case 'team-confirmation':
    case 'team': return teamConfirmationPromptRequest(level || 'selected', fallbackText);
    case 'project-context': return projectContextPromptRequest(fallbackText);
    case 'mobile': return mobilePromptRequest(fallbackText);
    case 'code-graph': return codeGraphPromptRequest(fallbackText);
    case 'state': return null;
  }
}
