// src/shared/onboarding/prompts.ts
// New-project onboarding step ROUTER (pure logic). The wizard server consumes
// nextOnboardingStep to decide which question to show next. The per-step popup
// builders + chat-fallback prose were removed when onboarding moved into the
// local wizard (shared/onboarding-server).

import { obj } from '../obj';
import {
  hasResolvedNewProjectMobileState,
  hasResolvedOpenCodeState,
  hasValidPerformanceState,
  hasValidProjectContext,
  hasValidTeamState,
} from '../state';
import { canonicalHost } from '../model-tiers';
import { hostFlags } from '../host/capability-flags';
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
// canonical state file still needs writing (the wizard's finalize step).
export function nextOnboardingStep(state: unknown, host?: unknown): OnboardingStep | null {
  const s = obj(state);
  if (!s || s.mode !== 'new-project') return null;
  const activeHost = canonicalHost(host);
  if (!hostFlags(activeHost).opencodeSelfHosted && !hasResolvedOpenCodeState(s.openCode)) return 'open-code';
  if (!hasValidPerformanceState(s.performance)) return 'performance';
  if (needsTeamConfirmation(s, host)) return 'team-confirmation';
  if (!hasValidTeamState(s.team)) return 'team';
  if (!hasValidProjectContext(s.projectContext)) return 'project-context';
  if (!hasResolvedNewProjectMobileState(s.mobile)) return 'mobile';
  if (s.codeGraphProvider !== 'gitnexus' && s.codeGraphProvider !== 'graphify') return 'code-graph';
  return 'state';
}
