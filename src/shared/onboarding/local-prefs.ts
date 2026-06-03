// src/shared/onboarding/local-prefs.ts
// Per-user Traffic One preference STEP router for both existing projects and
// already-configured new projects. Shared state may be present in the repo, but
// each user still needs local choices for OpenCode, performance/team, and the
// code graph provider before mutating work proceeds. The wizard server consumes
// nextLocalPreferenceStep; the prose/popup assemblers were removed when onboarding
// moved into the local wizard (shared/onboarding-server).

import { obj } from '../obj';
import { teamModeForLevel } from '../performance';
import {
  hasResolvedOpenCodeState,
  hasValidPerformanceState,
  hasValidTeamState,
  isTeamApproved,
} from '../state';
import type { OnboardingStep } from './prompts';

export type LocalPreferenceStep = Extract<OnboardingStep, 'open-code' | 'performance' | 'team-confirmation' | 'code-graph'>;

export function nextLocalPreferenceStep(state: unknown): LocalPreferenceStep | null {
  const s = obj(state);
  if (!s || !s.stack) return null;
  if (!hasResolvedOpenCodeState(s.openCode)) return 'open-code';
  if (!hasValidPerformanceState(s.performance)) return 'performance';

  const performance = obj(s.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  const expectedTeamMode = teamModeForLevel(level);
  const team = obj(s.team);
  if (!hasValidTeamState(s.team)) {
    return expectedTeamMode === 'subagents' ? 'team-confirmation' : 'performance';
  }
  if (team && team.mode !== expectedTeamMode) return 'performance';
  if (expectedTeamMode === 'subagents' && !isTeamApproved(s.team)) return 'team-confirmation';

  if (s.codeGraphProvider !== 'gitnexus' && s.codeGraphProvider !== 'graphify') return 'code-graph';
  return null;
}
