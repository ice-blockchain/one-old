'use strict';

// scripts/hook-runtime/handlers/prompt-submit.cjs
// UserPromptSubmit handler. Drives the auth gate / auth-choice flow on every
// prompt, surfaces onboarding reminders + the one-time OpenCode opt-in, and
// converges project-local materialization. Function body is moved verbatim from
// the original single-file handlers.cjs.

const {
  fs,
  path,
  statePath,
  legacyStatePath,
  readState,
  normalizeState,
  detectMode,
  isKnownStack,
  isPluginAuthoringRoot,
  hasResolvedOpenCodeState,
  promptTextFromSubmit,
  classifyPromptForStack,
  updateTeamModeChangeApprovalFromPrompt,
  needsTeamConfirmation,
  teamConfirmationPromptContext,
  teamConfirmationPromptRequest,
  materializeProjectIfNeeded,
  nextOnboardingPromptRequest,
  nextOnboardingStepPrompt,
  onboardingReminderShort,
  openCodeOptInDirective,
  openCodePromptRequest,
  hostPopupInstruction,
  codexDefaultModeFallbackDirective,
} = require('./_helpers.cjs');

const {
  authGateForHook,
  authChoiceStatus,
  authChoiceAllowsContinue,
  authChoiceHookResult,
  parseUnauthenticatedAuthChoice,
  parseTrafficOneApiKey,
  authLoginFromPromptHookResult,
  isSessionExpiryReauth,
  sessionExpiredReauthPromptResult,
  authApiKeyPromptHookResult,
  authRequiredHookResult,
  tryWriteAuthChoice,
} = require('./auth.cjs');

// ── UserPromptSubmit ─────────────────────────────────────────────────────────
function runUserPromptSubmit(rawInput = '') {
  const cwd = process.cwd();
  if (isPluginAuthoringRoot(cwd)) {
    return { stdout: '', exitCode: 0 };
  }
  const authGate = authGateForHook();
  if (!authGate.authenticated) {
    const choiceStatus = authChoiceStatus(cwd);
    const authChoice = parseUnauthenticatedAuthChoice(rawInput, {
      allowNumeric: choiceStatus === 'pending-choice',
    });
    if (authChoice) {
      return authChoiceHookResult(authChoice);
    }
    if (authChoiceAllowsContinue(cwd)) return { stdout: '', exitCode: 0 };
    // Classifier-safe authentication: if the user supplied an API key (any
    // phrasing), run login INSIDE the hook process — never have the agent shell
    // out to the auth script, which Claude Code's auto-mode security classifier
    // blocks as a credential-leakage pattern. This fires regardless of how the
    // auth choice was recorded, so it also covers modal "Authenticate" answers
    // that never set choiceStatus='authenticate'.
    const promptApiKey = parseTrafficOneApiKey(rawInput);
    if (promptApiKey) return authLoginFromPromptHookResult(promptApiKey);
    if (isSessionExpiryReauth(authGate)) {
      return sessionExpiredReauthPromptResult();
    }
    if (choiceStatus === 'authenticate') {
      return authApiKeyPromptHookResult();
    }
    const writeResult = tryWriteAuthChoice('pending-choice', cwd);
    return authRequiredHookResult('UserPromptSubmit', { authChoiceWrite: writeResult });
  }

  const currentStatePath = statePath(cwd);
  const currentLegacyStatePath = legacyStatePath(cwd);
  if (!fs.existsSync(currentStatePath) && !fs.existsSync(currentLegacyStatePath)) {
    return {
      stdout: JSON.stringify({ systemMessage: 'traffic-one active' }),
      exitCode: 0,
    };
  }

  const state = readState(cwd);
  if (!state) {
    return {
      stdout: JSON.stringify({ systemMessage: 'traffic-one active' }),
      exitCode: 0,
    };
  }

  const stack = state.stack || state.mode || 'unknown';
  const normalizedState = JSON.parse(JSON.stringify(state));
  normalizeState(normalizedState, normalizedState.mode || detectMode(process.cwd()));
  const promptText = promptTextFromSubmit(rawInput);
  const teamModeApproval = updateTeamModeChangeApprovalFromPrompt(process.cwd(), normalizedState, promptText);
  if (teamModeApproval.recorded) {
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [team mode switch authorized]',
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: '[ACTIVE STACK: ' + stack + ']\n\n'
            + 'The latest user prompt explicitly requested switching away from subagents to Low/main-agent mode. '
            + 'The next `.traffic-one/.one.json` write may change `performance.level` to "low" and `team.mode` to "main-agent"; '
            + 'this authorization is single-use and expires in 10 minutes.',
        },
      }),
      exitCode: 0,
    };
  }
  if (needsTeamConfirmation(normalizedState)) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${teamConfirmationPromptContext(normalizedState, 'user-prompt')}`;
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [team confirmation required]',
        promptRequest: teamConfirmationPromptRequest(normalizedState, additionalContext),
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      }),
      exitCode: 0,
    };
  }

  const validStack = state.stack && isKnownStack(state.stack);
  const isIncomplete = !validStack || state.onboardingComplete !== true;

  // Re-inject the short onboarding reminder while a new project hasn't yet
  // persisted a valid stack. SessionStart's full directive can scroll out of
  // context across long onboarding turns or compaction; this keeps the model
  // pointed at the schema until `.traffic-one/.one.json` is fully populated.
  if (isIncomplete && state.mode === 'new-project') {
    const reminder = onboardingReminderShort();
    const classification = promptText ? classifyPromptForStack(promptText) : null;
    const promptRequest = nextOnboardingPromptRequest(normalizedState, 'user-prompt');
    const classificationContext = classification
      ? [
        '[FIRST PROMPT STACK CLASSIFICATION]',
        `stack=${classification.stack}`,
        `frontend=${classification.frontend}`,
        `backend=${classification.backend}`,
        `mobile=${classification.mobile.enabled ? classification.mobile.framework : 'none'}`,
        'mode=new-project: complete Traffic One onboarding in the current thread before implementation. If no popup/input tool is available, ask fallback chat questions and stop for typed answers.',
        codexDefaultModeFallbackDirective(),
        `Onboarding choices must be prompt popups. ${hostPopupInstruction()} Do not print numbered option lists in chat when a popup tool is available; never choose a default or continue implementation while an answer is pending.`,
        'Required order: Agent mode (High/Balanced/Low), Team role/model confirmation for High/Balanced, success message, rich MVP-context questionnaire, Mobile App, then Code Graph provider.',
        'Ask only the next unresolved onboarding step below:',
        nextOnboardingStepPrompt(normalizedState, 'user-prompt'),
      ].join('\n')
      : nextOnboardingStepPrompt(normalizedState, 'user-prompt');
    return {
      stdout: JSON.stringify({
        systemMessage: 'traffic-one [onboarding incomplete]',
        ...(promptRequest ? { promptRequest } : {}),
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[ACTIVE STACK: ${stack}]\n\n${classificationContext ? `${classificationContext}\n\n` : ''}${reminder}`,
        },
      }),
      exitCode: 0,
    };
  }

  const materialized = materializeProjectIfNeeded(process.cwd(), 'generic user-prompt convergence');
  if (materialized && materialized.stdout) {
    return materialized;
  }

  // One-time OpenCode delegation opt-in. New projects ask it inside the
  // onboarding chain (before the Performance popup); every other session —
  // existing/auto-detected codebases, and projects onboarded before this
  // feature existed — gets it here, surfaced until the choice is recorded in
  // `.traffic-one/.one.json` and then never again. Non-blocking: the user's current
  // request still proceeds.
  if (!hasResolvedOpenCodeState(normalizedState.openCode)) {
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${openCodeOptInDirective()}`;
    return {
      stdout: JSON.stringify({
        systemMessage: `traffic-one [${stack}] opencode opt-in`,
        promptRequest: openCodePromptRequest(additionalContext),
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      }),
      exitCode: 0,
    };
  }

  return {
    stdout: JSON.stringify({
      systemMessage: `traffic-one [${stack}]`,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[ACTIVE STACK: ${stack}]`,
      },
    }),
    exitCode: 0,
  };
}

module.exports = {
  runUserPromptSubmit,
};
