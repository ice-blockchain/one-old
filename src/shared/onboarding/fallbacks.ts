// src/shared/onboarding/fallbacks.ts
// Assembles the new-project onboarding chat-fallback PROSE (shown when no host
// popup tool is available) by reading the onboarding-gate skill blocks and
// filling their {{VARS}}, then wires the step router → prose + popup request.
// The wording lives ONLY in the onboarding-gate SKILL.md (the single source);
// these helpers just compute the dynamic vars and select the block. A
// block-coverage test guarantees every referenced block exists, so the optional
// `fallback` arg is left empty here.

import type { PromptRequest } from '../prompt-request';
import { PROJECT_CONTEXT_ANSWER_KEYS, projectContextDomainQuestionLines, projectContextOriginalPrompt } from './project-context';
import { nextOnboardingStep, onboardingPromptRequestForStep, performanceLevelOf, type OnboardingStep } from './prompts';
import { renderTeamLines } from './team-lines';

type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
export type OnboardingBlock = (name: string, vars?: Vars, fallback?: string) => string;

// OpenCode install one-liner (ported from opencode-prompt.cjs).
export const OPEN_CODE_INSTALL = 'curl -fsSL https://opencode.ai/install | bash';

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

export function openCodeChatFallback(block: OnboardingBlock): string {
  return block('open-code', { INSTALL: OPEN_CODE_INSTALL });
}

export function performanceChatFallback(block: OnboardingBlock): string {
  return block('performance', {});
}

export function mobileChatFallback(block: OnboardingBlock): string {
  return block('mobile', {});
}

export function codeGraphChatFallback(block: OnboardingBlock): string {
  return block('code-graph', {});
}

export function projectContextChatFallback(state: unknown, block: OnboardingBlock): string {
  const originalPrompt = projectContextOriginalPrompt(state);
  const promptIntro = originalPrompt ? `Original request I should tailor this to: "${originalPrompt}"\n\n` : '';
  const answerKeys = PROJECT_CONTEXT_ANSWER_KEYS.join(', ');
  const domainQuestions = projectContextDomainQuestionLines(originalPrompt).map((line) => `- ${line}`).join('\n');
  return block('project-context', { PROMPT_INTRO: promptIntro, ANSWER_KEYS: answerKeys, DOMAIN_QUESTIONS: domainQuestions });
}

export function teamConfirmationChatFallback(level: string, overrides: unknown, block: OnboardingBlock): string {
  const teamLines = renderTeamLines(level, overrides).join('\n');
  return block('team-confirmation-chat', { LEVEL_UPPER: String(level).toUpperCase(), TEAM_LINES: teamLines });
}

export function teamConfirmationPromptContext(state: unknown, source: 'gate' | 'user-prompt', block: OnboardingBlock): string {
  const s = obj(state);
  const perf = s && obj(s.performance);
  const level = perf && typeof perf.level === 'string' ? perf.level : '';
  const team = s && obj(s.team);
  const overrides = team && obj(team.overrides) ? team.overrides : null;
  const teamChat = teamConfirmationChatFallback(level, overrides, block);
  const sourceNote = source === 'user-prompt'
    ? block('team-confirmation-source-user-prompt', {})
    : block('team-confirmation-source-gate', {});
  return block('team-confirmation-context', { LEVEL: level, SOURCE_NOTE: sourceNote, TEAM_CHAT: teamChat });
}

export interface OnboardingPromptAndRequest {
  fallbackText: string;
  promptRequest: PromptRequest | null;
}

// Build the {fallbackText, promptRequest} for the next unresolved onboarding
// step. Mirrors nextOnboardingStepPromptAndRequest (_helpers.cjs).
export function nextOnboardingStepPromptAndRequest(
  state: unknown,
  source: 'gate' | 'user-prompt',
  block: OnboardingBlock,
): OnboardingPromptAndRequest {
  const step = nextOnboardingStep(state);
  const level = performanceLevelOf(state);

  const stepFallback = (s: OnboardingStep): string => {
    switch (s) {
      case 'open-code': return ['Next unresolved Traffic One onboarding step: OpenCode delegation opt-in.', '', openCodeChatFallback(block)].join('\n');
      case 'performance': return ['Next unresolved Traffic One onboarding step: Agent mode.', '', performanceChatFallback(block)].join('\n');
      case 'team-confirmation':
      case 'team': return teamConfirmationPromptContext(state, source, block);
      case 'project-context': return projectContextChatFallback(state, block);
      case 'mobile': return mobileChatFallback(block);
      case 'code-graph': return codeGraphChatFallback(block);
      case 'state': return [
        'Traffic One onboarding state is still incomplete or noncanonical.',
        'Complete `.traffic-one/.one.json` plus local Traffic One preferences before continuing.',
      ].join('\n');
    }
  };

  if (!step) {
    return {
      fallbackText: [
        'Traffic One onboarding state is still incomplete or noncanonical.',
        'Complete `.traffic-one/.one.json` plus local Traffic One preferences before continuing.',
      ].join('\n'),
      promptRequest: null,
    };
  }

  return {
    fallbackText: stepFallback(step),
    promptRequest: onboardingPromptRequestForStep(step, { level, fallbackText: stepFallback(step) }),
  };
}

export function nextOnboardingStepPrompt(state: unknown, source: 'gate' | 'user-prompt', block: OnboardingBlock): string {
  return nextOnboardingStepPromptAndRequest(state, source, block).fallbackText;
}

export function nextOnboardingPromptRequest(state: unknown, source: 'gate' | 'user-prompt', block: OnboardingBlock): PromptRequest | null {
  return nextOnboardingStepPromptAndRequest(state, source, block).promptRequest;
}

// ── Gate deny reasons (compose the prose blocks above) ───────────────────────

export function onboardingGateFallbackReason(state: unknown, block: OnboardingBlock): string {
  const nextStepPrompt = nextOnboardingStepPrompt(state, 'gate', block);
  return block('gate-fallback-reason', { NEXT_STEP_PROMPT: nextStepPrompt });
}

export function teamConfirmationGateFallbackReason(state: unknown, block: OnboardingBlock): string {
  const context = teamConfirmationPromptContext(state, 'gate', block);
  return block('team-confirmation-gate-reason', { CONTEXT: context });
}

export function repairedMaterializationDenyReason(block: OnboardingBlock): string {
  return block('repaired-materialization', {});
}
