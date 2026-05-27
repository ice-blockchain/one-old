// src/modules/session/prompt-submit.ts
// UserPromptSubmit handler: drives the auth gate / auth-choice flow on every
// prompt, records/clears the team-mode-change approval, surfaces onboarding
// reminders + the one-time OpenCode opt-in, and converges project-local
// materialization. Ported 1:1 from runUserPromptSubmit (prompt-submit.cjs).
// Auth-choice parsing reads the extracted prompt text (cleaner than the legacy
// raw-string pass; the host adapter already extracts the prompt).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { classifyPromptForStack, detectMode } from '../../shared/detection';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import {
  codexDefaultModeFallbackDirective,
  hostPopupInstruction,
  onboardingReminderShort,
  openCodeOptInDirective,
} from '../../shared/onboarding/directives';
import {
  nextOnboardingPromptRequest,
  nextOnboardingStepPrompt,
  type OnboardingBlock,
  teamConfirmationPromptContext,
} from '../../shared/onboarding/fallbacks';
import { isNewProjectOnboardingIncomplete, needsTeamConfirmation } from '../../shared/onboarding/predicates';
import { onboardingPromptRequestForStep, performanceLevelOf } from '../../shared/onboarding/prompts';
import { updateTeamModeChangeApprovalFromPrompt } from '../../shared/onboarding/team-mode-approval';
import { isKnownStack } from '../../shared/config';
import { pluginRoot } from '../../shared/paths';
import { openCodePromptRequest } from '../../shared/prompt-request';
import { promptTextFromSubmit } from '../../shared/prompt-input';
import { makeSkillBlock } from '../../shared/skill-block';
import { hasResolvedOpenCodeState, legacyStatePath, normalizeState, readEffectiveState, statePath } from '../../shared/state';
import {
  authApiKeyPromptHookResult,
  authChoiceHookResult,
  authGateForHook,
  authLoginFromPromptHookResult,
  authRequiredHookResult,
  isSessionExpiryReauth,
  parseTrafficOneApiKey,
  parseUnauthenticatedAuthChoice,
  sessionExpiredReauthPromptResult,
} from './auth-gate';
import { authChoiceAllowsContinue, authChoiceStatus, tryWriteAuthChoice } from './auth-choice';
import * as fs from 'fs';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block: OnboardingBlock = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);

const TEAM_MODE_SWITCH_AUTHORIZED_FALLBACK = 'The latest user prompt explicitly requested switching away from subagents to Low/main-agent mode. The next local Traffic One preference write may change `performance.level` to "low" and `team.mode` to "main-agent"; this authorization is single-use and expires in 10 minutes.';

export function runUserPromptSubmit(ctx: Ctx): HookResult {
  const cwd = ctx.cwd;
  if (isPluginAuthoringRoot(cwd)) return noop();

  const raw = ctx.input.raw;
  const promptText = ctx.input.prompt || promptTextFromSubmit(raw);

  // ── Auth gate / auth-choice flow ──
  const authGate = authGateForHook();
  if (!authGate.authenticated) {
    const choiceStatus = authChoiceStatus(cwd);
    const authChoice = parseUnauthenticatedAuthChoice(promptText, { allowNumeric: choiceStatus === 'pending-choice' });
    if (authChoice) return authChoiceHookResult(authChoice, cwd);
    if (authChoiceAllowsContinue(cwd)) return noop();
    const promptApiKey = parseTrafficOneApiKey(promptText);
    if (promptApiKey) return authLoginFromPromptHookResult(promptApiKey);
    if (isSessionExpiryReauth(authGate)) return sessionExpiredReauthPromptResult();
    if (choiceStatus === 'authenticate') return authApiKeyPromptHookResult();
    const writeResult = tryWriteAuthChoice('pending-choice', cwd);
    return authRequiredHookResult('UserPromptSubmit', { authChoiceWrite: writeResult });
  }

  if (!fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd))) {
    return context('', { systemMessage: 'traffic-one active' });
  }
  const state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return context('', { systemMessage: 'traffic-one active' });

  const stack = (state.stack as string) || (state.mode as string) || 'unknown';
  const normalizedState = JSON.parse(JSON.stringify(state)) as Rec;
  normalizeState(normalizedState, (normalizedState.mode as string) || detectMode(cwd));

  // ── Team-mode-change approval recorded from the prompt ──
  const teamModeApproval = updateTeamModeChangeApprovalFromPrompt(cwd, normalizedState, promptText);
  if (teamModeApproval.recorded) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${block('team-mode-switch-authorized', {}, TEAM_MODE_SWITCH_AUTHORIZED_FALLBACK)}`;
    return context(additionalContext, { systemMessage: 'traffic-one [team mode switch authorized]' });
  }

  // ── Team Confirmation still pending ──
  if (needsTeamConfirmation(normalizedState)) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${teamConfirmationPromptContext(normalizedState, 'user-prompt', block)}`;
    const promptRequest = onboardingPromptRequestForStep('team-confirmation', {
      level: performanceLevelOf(normalizedState), fallbackText: additionalContext,
    });
    return context(additionalContext, { systemMessage: 'traffic-one [team confirmation required]', promptRequest });
  }

  const validStack = Boolean(state.stack && isKnownStack(state.stack));
  const isIncomplete = !validStack
    || state.onboardingComplete !== true
    || (state.mode === 'new-project' && isNewProjectOnboardingIncomplete(normalizedState));

  // ── Re-inject the short onboarding reminder while a new project is incomplete ──
  if (isIncomplete && state.mode === 'new-project') {
    const reminder = onboardingReminderShort(block);
    const classification = promptText ? classifyPromptForStack(promptText) : null;
    const promptRequest = nextOnboardingPromptRequest(normalizedState, 'user-prompt', block);
    const classificationContext = classification
      ? block('first-prompt-classification', {
        STACK: classification.stack,
        FRONTEND: classification.frontend,
        BACKEND: classification.backend,
        MOBILE: classification.mobile.enabled ? classification.mobile.framework : 'none',
        CODEX_FALLBACK: codexDefaultModeFallbackDirective(block),
        HOST_POPUP: hostPopupInstruction(block),
        NEXT_STEP: nextOnboardingStepPrompt(normalizedState, 'user-prompt', block),
      }, firstPromptClassificationFallback(classification))
      : nextOnboardingStepPrompt(normalizedState, 'user-prompt', block);
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${classificationContext ? `${classificationContext}\n\n` : ''}${reminder}`;
    return context(additionalContext, { systemMessage: 'traffic-one [onboarding incomplete]', ...(promptRequest ? { promptRequest } : {}) });
  }

  // ── Generic convergence ──
  const materialized = materializeProjectIfNeeded(cwd, { trigger: 'generic user-prompt convergence' });
  if (materialized) {
    return context(materialized.context, { systemMessage: materialized.systemMessage });
  }

  // ── One-time OpenCode opt-in (existing/auto-detected codebases) ──
  if (!hasResolvedOpenCodeState(normalizedState.openCode)) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${openCodeOptInDirective(block)}`;
    return context(additionalContext, { systemMessage: `traffic-one [${stack}] opencode opt-in`, promptRequest: openCodePromptRequest(additionalContext) });
  }

  return context(`[ACTIVE STACK: ${stack}]`, { systemMessage: `traffic-one [${stack}]` });
}

interface Classification {
  stack: string;
  frontend: string;
  backend: string;
  mobile: { enabled: boolean; framework: string };
}

function firstPromptClassificationFallback(c: Classification): string {
  return [
    '[FIRST PROMPT STACK CLASSIFICATION]',
    `stack=${c.stack}`,
    `frontend=${c.frontend}`,
    `backend=${c.backend}`,
    `mobile=${c.mobile.enabled ? c.mobile.framework : 'none'}`,
    'mode=new-project: complete Traffic One onboarding in the current thread before implementation. If no popup/input tool is available, ask fallback chat questions and stop for typed answers.',
    codexDefaultModeFallbackDirective(block),
    `Onboarding choices must be prompt popups. ${hostPopupInstruction(block)} Do not print numbered option lists in chat when a popup tool is available; never choose a default or continue implementation while an answer is pending.`,
    'Required order: Agent mode (High/Balanced/Low), Team role/model confirmation for High/Balanced, success message, rich MVP-context questionnaire, Mobile App, then Code Graph provider.',
    'Ask only the next unresolved onboarding step below:',
  ].join('\n');
}
