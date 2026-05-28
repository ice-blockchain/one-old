// src/modules/session/prompt-submit.ts
// UserPromptSubmit handler: drives the auth gate / auth-choice flow on every
// prompt, records/clears the team-mode-change approval, surfaces onboarding
// reminders, and converges project-local materialization plus per-user local
// preference prompts. Ported 1:1 from
// runUserPromptSubmit (prompt-submit.cjs).
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
import { promptTextFromSubmit } from '../../shared/prompt-input';
import { makeSkillBlock } from '../../shared/skill-block';
import { legacyStatePath, normalizeState, readEffectiveState, statePath } from '../../shared/state';
import { localPreferenceContext } from '../../shared/onboarding/local-prefs';
import {
  authApiKeyPromptHookResult,
  authChoiceHookResult,
  authGateForHook,
  authRequiredHookResult,
  isSessionExpiryReauth,
  parseTrafficOneApiKey,
  parseUnauthenticatedAuthChoice,
  runInternalAuthLogin,
  sessionExpiredReauthPromptResult,
} from './auth-gate';
import { authChoiceAllowsContinue, authChoiceStatus, tryWriteAuthChoice } from './auth-choice';
import { runSessionStartAuthed } from './session-start';
import * as fs from 'fs';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block: OnboardingBlock = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);
const sessionBlock = (name: string, vars: Record<string, string | number> = {}): string => skillBlock('session', name, vars);

// Prepend a note (e.g. the login-success line) to a context result, leaving
// non-context results untouched.
function prependContext(prefix: string, result: HookResult): HookResult {
  if (!prefix || result.kind !== 'context') return result;
  return context(`${prefix}${result.context}`, {
    ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
    ...(result.promptRequest ? { promptRequest: result.promptRequest } : {}),
  });
}

const TEAM_MODE_SWITCH_AUTHORIZED_FALLBACK = 'The latest user prompt explicitly requested switching away from subagents to Low/main-agent mode. The next local Traffic One preference write may change `performance.level` to "low" and `team.mode` to "main-agent"; this authorization is single-use and expires in 10 minutes.';

export function runUserPromptSubmit(ctx: Ctx): HookResult {
  const cwd = ctx.cwd;
  if (isPluginAuthoringRoot(cwd)) return noop();

  const raw = ctx.input.raw;
  const promptText = ctx.input.prompt || promptTextFromSubmit(raw);

  // ── Auth gate / auth-choice flow ──
  const authGate = authGateForHook();
  let loginSucceeded = false;
  if (!authGate.authenticated) {
    const choiceStatus = authChoiceStatus(cwd);
    const authChoice = parseUnauthenticatedAuthChoice(promptText, { allowNumeric: choiceStatus === 'pending-choice' });
    if (authChoice) return authChoiceHookResult(authChoice, cwd);
    if (authChoiceAllowsContinue(cwd)) return noop();
    const promptApiKey = parseTrafficOneApiKey(promptText);
    if (promptApiKey) {
      const login = runInternalAuthLogin(promptApiKey);
      if (!login.ok) {
        return context(sessionBlock('login-failed', { REASON: login.reason || 'unknown failure' }), { systemMessage: 'traffic-one authentication failed' });
      }
      // Authenticated this turn → fall through and run the authed SessionStart
      // body now, so onboarding starts in the SAME response. (Mid-session auth
      // otherwise never reaches that body, so onboarding never starts.)
      loginSucceeded = true;
    } else if (isSessionExpiryReauth(authGate)) {
      return sessionExpiredReauthPromptResult();
    } else if (choiceStatus === 'authenticate') {
      return authApiKeyPromptHookResult();
    } else {
      const writeResult = tryWriteAuthChoice('pending-choice', cwd);
      return authRequiredHookResult('UserPromptSubmit', { authChoiceWrite: writeResult });
    }
  }

  // A fresh login, or any authenticated interaction on a not-yet-initialized
  // project (auth completed mid-session, so SessionStart returned the gate and
  // never ran the authed body), runs that authed SessionStart body now — this is
  // where new-project onboarding / existing-codebase auto-detect actually starts.
  const uninitialized = !fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd));
  if (loginSucceeded || uninitialized) {
    const bootstrapped = runSessionStartAuthed(ctx);
    return loginSucceeded ? prependContext(`${sessionBlock('login-success')}\n\n`, bootstrapped) : bootstrapped;
  }
  const state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return runSessionStartAuthed(ctx);

  const stack = (state.stack as string) || (state.mode as string) || 'unknown';
  const normalizedState = JSON.parse(JSON.stringify(state)) as Rec;
  normalizeState(normalizedState, (normalizedState.mode as string) || detectMode(cwd));

  // ── Team-mode-change approval recorded from the prompt ──
  const teamModeApproval = updateTeamModeChangeApprovalFromPrompt(cwd, normalizedState, promptText);
  if (teamModeApproval.recorded) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${block('team-mode-switch-authorized', {}, TEAM_MODE_SWITCH_AUTHORIZED_FALLBACK)}`;
    return context(additionalContext, { systemMessage: 'traffic-one [team mode switch authorized]' });
  }

  const validStack = Boolean(state.stack && isKnownStack(state.stack));
  const isIncomplete = !validStack
    || state.onboardingComplete !== true
    || (state.mode === 'new-project' && isNewProjectOnboardingIncomplete(normalizedState));

  // ── Per-user local preferences required before mutating Traffic One work ──
  // Already-configured projects can be shared across users. The repo-local
  // state may be complete, but each user still needs local preferences.
  const localPrefs = validStack && state.onboardingComplete === true
    ? localPreferenceContext(normalizedState, stack, 'user-prompt', block)
    : null;
  if (localPrefs) {
    return context(localPrefs.context, {
      systemMessage: `traffic-one [${stack}] local preferences required`,
      ...(localPrefs.promptRequest ? { promptRequest: localPrefs.promptRequest } : {}),
    });
  }

  // ── Team Confirmation still pending (fallback for incomplete new-project flows) ──
  if (needsTeamConfirmation(normalizedState)) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${teamConfirmationPromptContext(normalizedState, 'user-prompt', block)}`;
    const promptRequest = onboardingPromptRequestForStep('team-confirmation', {
      level: performanceLevelOf(normalizedState), fallbackText: additionalContext,
    });
    return context(additionalContext, { systemMessage: 'traffic-one [team confirmation required]', promptRequest });
  }

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
