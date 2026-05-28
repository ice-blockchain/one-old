// src/shared/onboarding/local-prefs.ts
// Per-user Traffic One preference gate for both existing projects and
// already-configured new projects. Shared state may be present in the repo, but
// each user still needs local choices for OpenCode, performance/team, and the
// code graph provider before mutating work proceeds.

import { teamModeForLevel } from '../performance';
import type { PromptRequest } from '../prompt-request';
import {
  hasResolvedOpenCodeState,
  hasValidPerformanceState,
  hasValidTeamState,
  isTeamApproved,
} from '../state';
import {
  codeGraphChatFallback,
  openCodeChatFallback,
  performanceChatFallback,
  teamConfirmationPromptContext,
  type OnboardingBlock,
} from './fallbacks';
import { onboardingPromptRequestForStep, performanceLevelOf, type OnboardingStep } from './prompts';

type Rec = Record<string, unknown>;
type LocalPreferenceStep = Extract<OnboardingStep, 'open-code' | 'performance' | 'team-confirmation' | 'code-graph'>;

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

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

export function hasMissingLocalPreferences(state: unknown): boolean {
  return nextLocalPreferenceStep(state) !== null;
}

export interface LocalPreferencePrompt {
  step: LocalPreferenceStep;
  fallbackText: string;
  promptRequest: PromptRequest | null;
}

export function localPreferencePromptAndRequest(
  state: unknown,
  source: 'gate' | 'user-prompt' | 'session-start',
  block: OnboardingBlock,
): LocalPreferencePrompt | null {
  const step = nextLocalPreferenceStep(state);
  if (!step) return null;
  const fallbackText = (() => {
    switch (step) {
      case 'open-code':
        return ['Next unresolved Traffic One local preference: OpenCode delegation opt-in.', '', openCodeChatFallback(block)].join('\n');
      case 'performance':
        return ['Next unresolved Traffic One local preference: Agent mode.', '', performanceChatFallback(block)].join('\n');
      case 'team-confirmation':
        return teamConfirmationPromptContext(state, source === 'gate' ? 'gate' : 'user-prompt', block);
      case 'code-graph':
        return ['Next unresolved Traffic One local preference: Code graph provider.', '', codeGraphChatFallback(block)].join('\n');
    }
  })();
  return {
    step,
    fallbackText,
    promptRequest: onboardingPromptRequestForStep(step, { level: performanceLevelOf(state), fallbackText }),
  };
}

export function localPreferenceContext(
  state: unknown,
  stack: string,
  source: 'gate' | 'user-prompt' | 'session-start',
  block: OnboardingBlock,
): { context: string; promptRequest: PromptRequest | null } | null {
  const prompt = localPreferencePromptAndRequest(state, source, block);
  if (!prompt) return null;
  const intro = [
    `[ACTIVE STACK: ${stack}]`,
    '',
    'Traffic One local preferences are required for this user before implementation in this project.',
    'Read-only orientation is allowed, but feature writes, installs, and subagent work must wait until this preference is saved locally.',
    '',
    prompt.fallbackText,
  ].join('\n');
  return { context: intro, promptRequest: prompt.promptRequest };
}

