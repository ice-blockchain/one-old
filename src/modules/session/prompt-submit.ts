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
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { detectMode, isLikelyCodingPrompt, isLikelyEditRequest } from '../../shared/detection';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { ensureOnboardingServer } from '../../shared/onboarding-server/ensure';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { onboardingWaitCommand } from '../../shared/onboarding-server/wait-command';
import { serverRecordExists } from '../../shared/onboarding-server/registry';
import { projectContextOriginalPrompt } from '../../shared/onboarding/project-context';
import { updateTeamModeChangeApprovalFromPrompt } from '../../shared/onboarding/team-mode-approval';
import { pluginRoot } from '../../shared/paths';
import { promptTextFromSubmit } from '../../shared/prompt-input';
import { makeSkillBlock } from '../../shared/skill-block';
import { hasActiveRunClaims, hookSessionIdentity, isMaintenancePhase, legacyStatePath, lifecycleCompletedAt, normalizeState, readEffectiveState, readState, runIdNow, statePath, writeState } from '../../shared/state';
import { obj } from '../../shared/obj';
import { firstEmitThisSession } from '../../shared/once';
import { openCodeDelegationActive, teamModeForLevel } from '../../shared/performance';
import { resolveModel } from '../../shared/model-tiers';
import { classifyPromptComplexity } from '../../shared/triage/classify';
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
import { ensureOpenCodeDelegationReady } from './session-start-lib';
import * as fs from 'fs';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);
const sessionBlock = (name: string, vars: Record<string, string | number> = {}): string => skillBlock('session', name, vars);

// Persist the user's first request into the new-project state so the wizard can
// tailor its questions AND derive the right stack (without it, an empty prompt
// derives to `minimal`). Idempotent: only on a new project, and never overwrites
// an existing prompt — the FIRST coding prompt is the project description.
function seedOriginalPrompt(cwd: string, prompt: string): void {
  const text = (prompt || '').trim();
  if (!text) return;
  const state = readState(cwd);
  if (state.mode !== 'new-project') return;
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

function beginFreshMaintenanceRun(cwd: string, state: Rec): void {
  const runId = runIdNow();
  const sharedState = readState(cwd);
  writeState(cwd, { ...sharedState, currentRunId: runId, spawnIndex: {} });
  state.currentRunId = runId;
  state.spawnIndex = {};
}

// Post-build maintenance triage. Once the main build is complete (existing
// codebases from the start; new projects once the build flips them to maintenance)
// the machinery should scale to the request rather than treating every prompt the
// same: trivial → a cheap/OpenCode quick-fix, small → a single role, complex →
// re-engage the orchestrator. Hooks can't classify with an LLM, so we inject a
// compact directive plus a deterministic keyword hint and let the agent decide.
// Returns the directive string, or '' when triage does not apply. Guards: must be
// maintenance phase, a coding/implementation prompt (skip questions/chat), not a
// subagent session, and no orchestration run / fix-cycle currently in flight (never
// re-triage mid-run). The directive branches on team mode so it never promises a
// subagent that main-agent mode can't spawn.
function maintenanceTriageDirective(cwd: string, state: Rec, promptText: string, raw: unknown, host: string): string {
  const mode = (state.mode as string) || detectMode(cwd);
  if (!isMaintenancePhase(state, mode)) return '';
  // Broader than the onboarding coding-intent gate: a finished app's copy/UI tweaks
  // ("change the hero headline", "shorten the title") must still route through triage.
  if (!isLikelyEditRequest(promptText)) return '';
  if (hookSessionIdentity(raw).isSubagent) return '';
  // Claims from a run that finished BEFORE the lifecycle stamp are settled —
  // only claims newer than the watermark mean an orchestration is in flight.
  if (hasActiveRunClaims(cwd, state, { since: lifecycleCompletedAt(state) })) return '';

  const hint = classifyPromptComplexity(promptText);
  const team = obj(state.team);
  const perf = obj(state.performance);
  const level = perf && typeof perf.level === 'string' ? perf.level : '';
  const teamMode = team && (team.mode === 'main-agent' || team.mode === 'subagents')
    ? (team.mode as string)
    : teamModeForLevel(level);
  // Name the concrete cheapest model so the agent passes it on the quick-fix spawn
  // without resolving an indirection (haiku on Claude/Cursor, gpt-5.4-mini on Codex).
  const cheapest = resolveModel('cheapest', host) || 'the cheapest model for this host';
  const signals = hint.signals.length ? ` — signals: ${hint.signals.join(', ')}` : '';
  if (teamMode === 'subagents') beginFreshMaintenanceRun(cwd, state);
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  const ocActive = openCodeDelegationActive(state);
  // Render the OpenCode instruction only when delegation is actually active, so an
  // off state doesn't leave a dead-branch clause a literal reader must evaluate.
  let openCodeClause = '';
  let quickFixOpenCodeClause = '';
  let smallOpenCodeClause = '';
  if (ocActive) {
    if (teamMode === 'main-agent') {
      openCodeClause = ` If you prefer, offload it via the \`opencode_delegate\` tool (role "quick-fix").`;
    } else {
      quickFixOpenCodeClause = ` OpenCode is active — call the \`opencode_delegate\` tool FIRST with role "quick-fix", runId "${runId}", projectRoot, the bounded task; only if it declines, spawn the paid worker. If the host safety reviewer rejects the call but offers a user-approval path, ask the user once (it sends the task + relevant code to OpenCode's hosted model) and on approval re-call; otherwise use the paid fallback. If the tool is not exposed, say the opencode-worker MCP server is not loaded and Codex needs one restart, then use the paid fallback.`;
      smallOpenCodeClause = ` OpenCode is active — call the \`opencode_delegate\` tool FIRST with the chosen role "senior-frontend" or "senior-backend", runId "${runId}", projectRoot, the bounded task; only if it declines, spawn the paid role subagent. If the host safety reviewer rejects the call but offers a user-approval path, ask the user once (it sends the task + relevant code to OpenCode's hosted model) and on approval re-call; otherwise use the paid fallback. If the tool is not exposed, say the opencode-worker MCP server is not loaded and Codex needs one restart, then use the paid fallback.`;
    }
  }
  // The rubric is ~95% static prose: inject it in full once per session, then a
  // one-line reminder with the per-prompt variables (tier hint + fresh runId).
  // beginFreshMaintenanceRun above still runs on every triage prompt.
  if (!firstEmitThisSession(cwd, 'maintenance-triage', hookSessionIdentity(raw).sessionId)) {
    const ocReminder = ocActive && teamMode === 'subagents'
      ? ` OpenCode runId for \`opencode_delegate\`: "${runId}".`
      : '';
    return `[MAINTENANCE PHASE — triage reminder] hint: ${hint.tier} (confidence ${hint.confidence})${signals} — route per the maintenance-triage rubric from earlier in this session (full rubric: \`task-triage\` skill).${ocReminder}`;
  }
  const blockName = teamMode === 'main-agent' ? 'maintenance-triage-main-agent' : 'maintenance-triage-subagents';
  return `${block(blockName, {
    HINT: hint.tier,
    CONFIDENCE: hint.confidence,
    SIGNALS: signals,
    CHEAPEST_MODEL: cheapest,
    OPENCODE_CLAUSE: openCodeClause,
    QUICK_FIX_OPENCODE_CLAUSE: quickFixOpenCodeClause,
    SMALL_OPENCODE_CLAUSE: smallOpenCodeClause,
  })}`;
}

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

  const uninitialized = !fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd));

  // ── Coding-intent gate ──
  // On a brand-new project with no active wizard, a clearly non-coding prompt
  // must not activate Traffic One. The instant state exists, a wizard server is
  // running, the user just authenticated, or the prompt looks like build/
  // implementation work, the normal path runs — an active project is never
  // mis-skipped (and the PreToolUse gate still fires if a tool is attempted).
  if (uninitialized && !loginSucceeded && !serverRecordExists(cwd) && !isLikelyCodingPrompt(promptText)) {
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
    seedOriginalPrompt(cwd, promptText);
    const server = ensureOnboardingServer(cwd);
    // Full walkthrough once per session (shared marker with the PreToolUse gate);
    // repeat prompts get the short URL + wait-command essentials.
    const wizardBlock = firstEmitThisSession(cwd, 'onboarding-deny', hookSessionIdentity(raw).sessionId)
      ? 'server-deny-reason'
      : 'server-deny-reason-repeat';
    return context(`[ACTIVE STACK: ${stack}]\n\n${block(wizardBlock, { URL: server.url, WAIT_CMD: onboardingWaitCommand(cwd) })}`, {
      systemMessage: 'traffic-one [setup required]',
    });
  }

  // ── Post-build maintenance triage (appended to whatever context we return) ──
  const openCodeReadiness = ensureOpenCodeDelegationReady(cwd, normalizedState);
  const triage = maintenanceTriageDirective(cwd, normalizedState, promptText, raw, ctx.host);

  // ── Generic convergence ──
  const materialized = materializeProjectIfNeeded(cwd, { trigger: 'generic user-prompt convergence' });
  if (materialized) {
    const readiness = openCodeReadiness ? `${openCodeReadiness}\n` : '';
    const body = triage ? `${readiness}${materialized.context}\n\n${triage}` : `${readiness}${materialized.context}`;
    return context(body, { systemMessage: materialized.systemMessage });
  }

  if (triage) {
    return context(`${openCodeReadiness}[ACTIVE STACK: ${stack}]\n\n${triage}`, { systemMessage: `traffic-one [${stack}] maintenance` });
  }
  return context(`${openCodeReadiness}[ACTIVE STACK: ${stack}]`, { systemMessage: `traffic-one [${stack}]` });
}
