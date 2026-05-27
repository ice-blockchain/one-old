// src/shared/onboarding/fallbacks.ts
// Assembles the new-project onboarding chat-fallback PROSE (shown when no host
// popup tool is available) from the onboarding-gate skill blocks + the dynamic
// helpers, and wires the step router → prose + popup request. The `block`
// function (skillBlock bound to 'onboarding-gate') returns skill prose with
// {{VARS}} filled, or the verbatim fallback if the block is missing. Ported 1:1
// from the *ChatFallback / nextOnboardingStepPromptAndRequest helpers.

import type { PromptRequest } from '../prompt-request';
import { PROJECT_CONTEXT_ANSWER_KEYS, projectContextDomainQuestionLines, projectContextOriginalPrompt } from './project-context';
import { nextOnboardingStep, onboardingPromptRequestForStep, performanceLevelOf, type OnboardingStep } from './prompts';
import { renderTeamLines } from './team-lines';

type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
export type OnboardingBlock = (name: string, vars: Vars, fallback: string) => string;

// OpenCode install one-liner (ported from opencode-prompt.cjs).
export const OPEN_CODE_INSTALL = 'curl -fsSL https://opencode.ai/install | bash';

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

export function openCodeChatFallback(block: OnboardingBlock): string {
  return block('open-code', { INSTALL: OPEN_CODE_INSTALL }, [
    'Traffic One can delegate bounded coding tasks to OpenCode — a free, local AI',
    'agent — to save your paid token budget. Traffic One still plans, supervises,',
    'and verifies; OpenCode executes, and every change is kept in a reviewable',
    `digest. To actually use it you install OpenCode (\`${OPEN_CODE_INSTALL}\`)`,
    'and sign in. The delegation feature ships in a later update; this only records',
    'your preference.',
    '',
    'Save tokens by delegating coding tasks to OpenCode?',
    '',
    '  1. Enable OpenCode delegation',
    '  2. Not now',
    '',
    'Reply with the option number or label.',
  ].join('\n'));
}

export function performanceChatFallback(block: OnboardingBlock): string {
  return block('performance', {}, [
    'Traffic One needs to know how you want to run agents for this build.',
    'How do you want to run agents for this build?',
    '',
    '  1. High (Recommended) — Subagent team with max-power models',
    '  2. Balanced — Subagent team with efficient mid-tier models',
    '  3. Low — Main agent only with role roadmap checklist',
    '',
    'Reply with the option number or label.',
  ].join('\n'));
}

export function mobileChatFallback(block: OnboardingBlock): string {
  return block('mobile', {}, [
    'Traffic One needs the mobile app decision for this project.',
    '',
    'Do you want a mobile app too?',
    '',
    '  1. Web only (Recommended)',
    '  2. Ionic + Capacitor',
    '  3. React Native / Expo',
    '',
    'Reply with the option number or label.',
  ].join('\n'));
}

export function codeGraphChatFallback(block: OnboardingBlock): string {
  return block('code-graph', {}, [
    'Traffic One needs the code graph provider for this project.',
    '',
    'Which provider should we use for the codebase graph?',
    '',
    '  1. GitNexus',
    '  2. graphify',
    '',
    'Reply with the option number or label.',
  ].join('\n'));
}

export function projectContextChatFallback(state: unknown, block: OnboardingBlock): string {
  const originalPrompt = projectContextOriginalPrompt(state);
  const promptIntro = originalPrompt ? `Original request I should tailor this to: "${originalPrompt}"\n\n` : '';
  const answerKeys = PROJECT_CONTEXT_ANSWER_KEYS.join(', ');
  const domainQuestions = projectContextDomainQuestionLines(originalPrompt).map((line) => `- ${line}`).join('\n');
  const verbatim = [
    "Traffic One was successfully set up. Let's collect the project details next.",
    '',
    `${promptIntro}Answer these MVP-context questions in one reply so the build plan is complete:`,
    '',
    '1. Audience and jobs: who uses it, what problem they solve, and the top 2-3 user journeys.',
    '2. V1 scope: must-have features, nice-to-haves to defer, and any launch deadline or demo expectation.',
    '3. Roles and auth: anonymous, user, customer, creator/provider, staff/admin, permissions, and profile data.',
    '4. Data model: core entities and relationships the MVP must store or seed.',
    '5. Admin and operations: dashboards, CRUD, moderation, user/content/transaction management, analytics, support, and audit needs. Include this when the app has managed content, users, transactions, or operational workflows, even if the first request did not mention admin.',
    '6. Business model and payments: free, paid, freemium, lead-gen, subscription, one-time purchase, marketplace commission, or internal tool? Are payments in or out for v1?',
    '7. Content and integrations: source of seed/real data, uploads/files, search, notifications/email, realtime, maps/calendar/AI/external APIs, import/export.',
    '8. Success criteria and product tone: what makes the MVP feel complete, what metrics matter, and what visual/brand direction should guide the UI.',
    '',
    `Use these answer keys where possible: ${answerKeys}.`,
    '',
    'Dynamic questions for this request:',
    domainQuestions,
    '',
    'Save the answer in `.traffic-one/.one.json` as `projectContext` with `source`, `originalPrompt`, `summary`, `answers`, and `collectedAt` before asking the Mobile App prompt.',
  ].join('\n');
  return block('project-context', { PROMPT_INTRO: promptIntro, ANSWER_KEYS: answerKeys, DOMAIN_QUESTIONS: domainQuestions }, verbatim);
}

export function teamConfirmationChatFallback(level: string, overrides: unknown, block: OnboardingBlock): string {
  const teamLines = renderTeamLines(level, overrides).join('\n');
  const verbatim = [
    `Traffic One — confirm the subagent team for ${String(level).toUpperCase()} mode:`,
    '',
    teamLines,
    '',
    '  1. Approve — use the team above and launch the subagents.',
    '  2. Re-pick performance — choose a different performance level.',
    '  3. Customise — tell me which role(s) to retier (highest | balanced | cheapest).',
    '',
    'Reply with the option number or label. For "Customise", also list the',
    'role/tier changes, e.g. "senior-reviewer=highest, senior-tester=balanced".',
  ].join('\n');
  return block('team-confirmation-chat', { LEVEL_UPPER: String(level).toUpperCase(), TEAM_LINES: teamLines }, verbatim);
}

export function teamConfirmationPromptContext(state: unknown, source: 'gate' | 'user-prompt', block: OnboardingBlock): string {
  const s = obj(state);
  const perf = s && obj(s.performance);
  const level = perf && typeof perf.level === 'string' ? perf.level : '';
  const team = s && obj(s.team);
  const overrides = team && obj(team.overrides) ? team.overrides : null;
  const teamChat = teamConfirmationChatFallback(level, overrides, block);
  const sourceNote = source === 'user-prompt'
    ? block('team-confirmation-source-user-prompt', {}, 'If the latest user message is an explicit "Approve" answer to this Team Confirmation prompt, first save local Traffic One preferences with `team.approved: true` (and any collected `team.overrides`), then continue.')
    : block('team-confirmation-source-gate', {}, 'Your next visible assistant message must ask this approval question and then stop for the user answer.');
  const verbatim = [
    `Traffic One Team Confirmation is still required before the ${level} subagent run can start.`,
    'The user selected a multi-agent performance level, but local Traffic One preferences do not contain `team.approved: true`.',
    'Do not spawn Task/spawn_agent/background-agent workers, do not write feature source, and do not set `team.source: "unavailable"` as a shortcut. If subagents are unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before any state rewrite.',
    sourceNote,
    'Use the host popup tool when available (Codex `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI). This is onboarding popup 2. If no popup tool is exposed, show this plain-chat fallback verbatim:',
    '',
    teamChat,
  ].join('\n');
  return block('team-confirmation-context', { LEVEL: level, SOURCE_NOTE: sourceNote, TEAM_CHAT: teamChat }, verbatim);
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
  const verbatim = [
    'Traffic One onboarding gate: mode=new-project and onboarding is not complete.',
    'Complete Traffic One onboarding in the current thread before using tools. If the popup tool is unavailable, the next unresolved fallback prompt must be displayed as the next visible assistant message.',
    '',
    'The previous assistant turn tried to use tools before completing onboarding. Stop tool use now. Your next visible assistant message must ask only this unresolved step:',
    '',
    nextStepPrompt,
    '',
    'The onboarding state remains incomplete until `.traffic-one/.one.json` contains shared project facts (stack, frontend, backend, projectContext, mobile, technologies, realtime, confirmed, onboardingComplete, confirmedAt) and local Traffic One preferences contain openCode, codeGraphProvider, performance, team (including `team.approved: true` after Team Confirmation for Balanced/High), and toolchain stamps.',
    'After sending that prompt, stop. Do not choose defaults, inspect package versions, scaffold, install, edit files, spawn helper agents, or continue implementation until the typed answer is received and the remaining onboarding prompts are resolved.',
  ].join('\n');
  return block('gate-fallback-reason', { NEXT_STEP_PROMPT: nextStepPrompt }, verbatim);
}

export function teamConfirmationGateFallbackReason(state: unknown, block: OnboardingBlock): string {
  const context = teamConfirmationPromptContext(state, 'gate', block);
  const verbatim = [
    'Traffic One Team Confirmation gate: the role/model lineup has not been approved.',
    '',
    context,
  ].join('\n');
  return block('team-confirmation-gate-reason', { CONTEXT: context }, verbatim);
}

export function repairedMaterializationDenyReason(block: OnboardingBlock): string {
  return block('repaired-materialization', {}, [
    'Traffic One state was repaired/materialized before this tool use.',
    'The attempted mutating tool has been denied once so it cannot run against stale `.traffic-one/.one.json`, rules, skills, or root agent context.',
    'rerun the same tool now; the canonical `.traffic-one/.one.json` and project-local materialization are current.',
  ].join('\n'));
}
