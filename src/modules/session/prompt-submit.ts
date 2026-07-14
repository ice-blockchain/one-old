// src/modules/session/prompt-submit.ts
// UserPromptSubmit handler: drives the auth gate / auth-choice flow on every
// prompt, records/clears the team-mode-change approval, and — once a project is a
// Traffic One project but onboarding is incomplete — points the user at the local
// setup wizard (the wizard owns the questions now; this only surfaces its URL and
// converges materialization). A deterministic coding-intent heuristic suppresses
// premature activation on a brand-new project when the prompt is clearly not a
// coding/implementation request. Auth flow ported 1:1 from runUserPromptSubmit.

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { detectMode, isLikelyCodingPrompt, promptHasStackSignal } from '../../shared/detection';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { maybeFlipToMaintenance } from '../materialize/build-complete';
import { prepareOnboardingServer } from '../../shared/onboarding-server/bootstrap';
import { formatWizardBanner } from '../../shared/onboarding-server/ensure';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import { windsurfSetupReason, windsurfSetupRepeatReason } from '../../shared/onboarding-server/windsurf-setup';
import { serverRecordExists } from '../../shared/onboarding-server/registry';
import { projectContextOriginalPrompt } from '../../shared/onboarding/project-context';
import { updateTeamModeChangeApprovalFromPrompt } from '../../shared/onboarding/team-mode-approval';
import { pluginRoot } from '../../shared/paths';
import { promptTextFromSubmit } from '../../shared/prompt-input';
import { makeSkillBlock } from '../../shared/skill-block';
import { hookSessionIdentity, isSubagentThread, legacyStatePath, normalizeState, readEffectiveState, readState, statePath, writeState } from '../../shared/state';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { obj } from '../../shared/obj';
import { firstEmitThisSession, stampEmitMarker } from '../../shared/once';
import { maintenanceTriageDirective } from './triage-directive';
import { buildOpenCodePlanBatchPendingDirective } from '../../shared/opencode-plan-directive';
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
import { modelChoiceReplyPending, parseModelChoice, writeModelChoice } from '../agent-model/model-choice';
import { runSessionStartAuthed } from './session-start';
import { ensureOpenCodeDelegationReady } from './session-start-lib';
import * as fs from 'fs';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}, fallback = ''): string =>
  skillBlock('onboarding-gate', name, vars, fallback);
const sessionBlock = (name: string, vars: Record<string, string | number> = {}): string => skillBlock('session', name, vars);

function opencodeSetupDirective(url: string, waitCommand: string, hostLabel = 'OpenCode'): string {
  return [
    'Traffic One project setup is required before building.',
    `Setup link: ${url}`,
    `Wait command: ${waitCommand}`,
    'Show the setup link, then immediately run the wait command in the current turn; do not wait for another user message first.',
    `If the wait command prints TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED, stop and tell the user to restart ${hostLabel}, then type "continue" or "resume" after restart.`,
  ].join('\n\n');
}

// Persist the user's first request into the new-project state so the wizard can
// tailor its questions AND derive the right stack (without it, an empty prompt
// derives to `minimal`). Idempotent: only on a new project, and never overwrites
// an existing prompt — the FIRST coding prompt is the project description.
function seedOriginalPrompt(cwd: string, prompt: string): void {
  const text = (prompt || '').trim();
  if (!text) return;
  // `originalPrompt` is the project DESCRIPTION — the wizard derives the stack from it and the
  // maintenance-triage continuation routes on it. A control / non-coding command ("stop all",
  // "cancel", "pause", a greeting) is NOT a description; seeding it pollutes both. Only seed a
  // prompt that looks like build/coding work — the SAME predicates the activation gate uses, so
  // anything that could legitimately be the first build prompt still seeds. This also stops a
  // later control command from becoming `originalPrompt` when the first build prompt wasn't
  // captured (e.g. state was reset mid-session).
  if (!isLikelyCodingPrompt(text) && !promptHasStackSignal(text)) return;
  const state = readState(cwd);
  // Seed for EVERY mode (was new-project-only): the onboarding-wait runner reads
  // `originalPrompt` after SETUP_COMPLETE to emit the maintenance-triage routing
  // for the continued request — existing codebases are exactly where that
  // continuation lands in maintenance phase. Never overwrite an existing seed.
  if (typeof state.originalPrompt === 'string' && state.originalPrompt.trim()) return;
  if (projectContextOriginalPrompt(state)) return;
  try {
    writeState(cwd, { ...state, originalPrompt: text });
  } catch {
    // best-effort; the wizard still runs, just without prompt-tailored defaults
  }
}

// Prepend a note (e.g. the login-success line) to a context result, leaving
// non-context results untouched.
function prependContext(prefix: string, result: HookResult): HookResult {
  if (!prefix || result.kind !== 'context') return result;
  return context(`${prefix}${result.context}`, {
    ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
    ...(result.promptRequest ? { promptRequest: result.promptRequest } : {}),
  });
}

// Post-build maintenance triage lives in ./triage-directive (shared with the
// onboarding-wait runner, which emits it for the SETUP-COMPLETE continuation —
// that request never reaches UserPromptSubmit).

export function runUserPromptSubmit(ctx: Ctx): HookResult {
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  initializeTrafficOneEnv(cwd, ctx.host);

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
      // body now, so setup starts in the SAME response.
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

  // ── Disabled/unavailable-model spawn choice (Cursor) ──
  // When picked tier models aren't offered (or the spawn gate surfaced a degradation choice),
  // the user's reply lands here. Honor it before any other handling. Fail closed: nothing
  // records `use-fallback` except this explicit chat reply (or a future host modal).
  {
    const choiceState = readEffectiveState(cwd);
    const choiceRunId = typeof choiceState.currentRunId === 'string' && choiceState.currentRunId.trim()
      ? choiceState.currentRunId.trim() : '';
    if (choiceRunId && modelChoiceReplyPending(cwd, choiceState as Record<string, unknown>)) {
      const modelChoice = parseModelChoice(promptText);
      if (modelChoice) {
        writeModelChoice(cwd, choiceRunId, modelChoice);
        const recordedBlock = modelChoice === 'enable-retry' ? 'model-choice-recorded-enable' : 'model-choice-recorded-fallback';
        return context(skillBlock('agent-model', recordedBlock, {}), { systemMessage: 'traffic-one: model choice recorded' });
      }
    }
  }

  const uninitialized = !fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd));

  // ── Coding-intent gate ──
  // On a brand-new project with no active wizard, a clearly non-coding prompt
  // must not activate Traffic One. The instant state exists, a wizard server is
  // running, the user just authenticated, or the prompt looks like build/
  // implementation work, the normal path runs — an active project is never
  // mis-skipped (and the PreToolUse gate still fires if a tool is attempted).
  //
  // `promptHasStackSignal` widens "looks like work" to also admit a verb-less
  // PROJECT DESCRIPTION ("a marketplace for freelancers", "a platform connecting
  // tutors and students"). Without it, such a first prompt is dropped here, the
  // FIRST project description is captured nowhere (seedOriginalPrompt runs only
  // past this gate), and a later thin "ok build it" becomes originalPrompt — which
  // classifyPromptForStack maps to `minimal`. A signal-less greeting/question still
  // has no stack signal, so genuine chit-chat is still suppressed.
  if (uninitialized && !loginSucceeded && !serverRecordExists(cwd)
    && !isLikelyCodingPrompt(promptText) && !promptHasStackSignal(promptText)) {
    return noop();
  }

  // A fresh login, or any authenticated interaction on a not-yet-initialized
  // project (auth completed mid-session, so SessionStart returned the gate and
  // never ran the authed body), runs that authed SessionStart body now — this is
  // where new-project setup / existing-codebase auto-detect actually starts.
  if (loginSucceeded || uninitialized) {
    const bootstrapped = runSessionStartAuthed(ctx);
    seedOriginalPrompt(cwd, promptText);
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
    const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${block('team-mode-switch-authorized')}`;
    return context(additionalContext, { systemMessage: 'traffic-one [team mode switch authorized]' });
  }

  // ── Onboarding incomplete → surface the local setup wizard URL ──
  // The wizard owns the questions + state writes; the agent only points the user
  // at it and waits. Covers new-project onboarding AND an already-configured
  // project missing this user's local preferences.
  if (!computeOnboarding(cwd).done) {
    // Subagents never onboard — onboarding is the parent/main-agent's job and a
    // worker thread cannot drive the wizard (see the onboarding-gate handler). If a
    // subagent prompt reaches here (e.g. a stray nested root), don't surface it.
    if (isSubagentThread(raw)) return noop();
    // Cursor fallback: a subagent's own events carry no reliable subagent marker, so
    // isSubagentThread misses them. The orchestrator is recorded as MAIN at subagentStart; a
    // session that is NOT a known main session is a subagent → don't surface the wizard to it.
    if (ctx.host === 'cursor') {
      const id = hookSessionIdentity(raw);
      if (id.sessionId && isForeignOnboardingThread(cwd, id.sessionId)) return noop();
    }
    seedOriginalPrompt(cwd, promptText);
    const prepared = prepareOnboardingServer(cwd, ctx.host);
    if (prepared.kind !== 'ready') {
      return context(`[ACTIVE STACK: ${stack}]\n\n${prepared.reason}`, {
        systemMessage: prepared.kind === 'bootstrap-required'
          ? 'traffic-one [setup permission required]'
          : 'traffic-one [setup launcher failed]',
      });
    }
    const { server, waitCommand } = prepared;
    if (ctx.host === 'opencode' || ctx.host === 'kilo') {
      const systemMessage = formatWizardBanner(ctx.host, server.url, 'traffic-one [setup required]');
      return context(`[ACTIVE STACK: ${stack}]\n\n${opencodeSetupDirective(server.url, waitCommand, ctx.host === 'kilo' ? 'Kilo' : 'OpenCode')}`, {
        systemMessage,
      });
    }
    if (ctx.host === 'windsurf') {
      const first = firstEmitThisSession(cwd, 'onboarding-deny', hookSessionIdentity(raw).sessionId);
      const vars = { URL: server.url, WAIT_CMD: waitCommand };
      const directive = first
        ? block('windsurf-server-deny-reason', vars, windsurfSetupReason(server.url, waitCommand))
        : block('windsurf-server-deny-reason-repeat', vars, windsurfSetupRepeatReason(server.url, waitCommand));
      return context(directive, {
        systemMessage: formatWizardBanner(ctx.host, server.url, 'traffic-one [setup required]'),
      });
    }
    // Full walkthrough once per session (shared marker with the PreToolUse gate);
    // repeat prompts get the short URL + wait-command essentials.
    const wizardBlock = firstEmitThisSession(cwd, 'onboarding-deny', hookSessionIdentity(raw).sessionId)
      ? 'server-deny-reason'
      : 'server-deny-reason-repeat';
    // The full recipe rides additional_context (agent-facing). On Cursor that is the
    // ONLY place the URL would appear unless the agent reposts it as a link — and it
    // may not. So also put the LIVE clickable wizard URL in the user-facing channel
    // (systemMessage → user_message on Cursor), so the user always gets a working link
    // on the first prompt regardless of the agent. Host-gated: Claude opens the wizard
    // in its preview pane and Codex via its own recipe, so they keep the plain banner.
    stampEmitMarker(cwd, 'wizard-url-shown');
    const systemMessage = formatWizardBanner(ctx.host, server.url, 'traffic-one [setup required]');
    return context(`[ACTIVE STACK: ${stack}]\n\n${block(wizardBlock, { URL: server.url, WAIT_CMD: waitCommand })}`, {
      systemMessage,
    });
  }

  // ── A settled new-project build flips to maintenance at the prompt boundary ──
  // The orchestrator's explicit Phase-5 stamp is the primary maintenance signal, but
  // on Cursor it (and claim activation) is unreliable: a FINISHED build can stay in
  // "building" with leftover never-activated pending claims. That mis-routes this
  // request through the build-phase gates (new-project monorepo + run-team) and blocks
  // the spawned worker. A NEW user prompt means the prior build turn ended, so flip
  // here (the no-active-claims guard is relaxed at the prompt boundary — see
  // maybeFlipToMaintenance) and refresh the in-memory lifecycle so the triage below
  // sees maintenance + the completion watermark. Subagent prompts never flip the
  // project lifecycle (that is the main agent's boundary).
  if (!isSubagentThread(raw) && maybeFlipToMaintenance(cwd, normalizedState, { atPromptBoundary: true })) {
    normalizedState.lifecycle = (readState(cwd) as Rec).lifecycle;
  }

  // ── Post-build maintenance triage (appended to whatever context we return) ──
  const openCodeReadiness = ensureOpenCodeDelegationReady(cwd, normalizedState);
  const planBatchReminder = buildOpenCodePlanBatchPendingDirective(cwd, normalizedState);
  const triage = maintenanceTriageDirective(cwd, normalizedState, promptText, raw, ctx.host);

  const prefixOpenCode = [openCodeReadiness, planBatchReminder].filter(Boolean).join('\n');

  // ── Generic convergence ──
  const materialized = materializeProjectIfNeeded(cwd, { trigger: 'generic user-prompt convergence' });
  if (materialized) {
    const readiness = prefixOpenCode ? `${prefixOpenCode}\n` : '';
    const body = triage ? `${readiness}${materialized.context}\n\n${triage}` : `${readiness}${materialized.context}`;
    return context(body, { systemMessage: materialized.systemMessage });
  }

  if (triage) {
    return context(`${prefixOpenCode}[ACTIVE STACK: ${stack}]\n\n${triage}`, { systemMessage: `traffic-one [${stack}] maintenance` });
  }
  return context(`${prefixOpenCode}[ACTIVE STACK: ${stack}]`, { systemMessage: `traffic-one [${stack}]` });
}
