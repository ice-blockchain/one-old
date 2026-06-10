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
import { detectMode, isLikelyCodingPrompt } from '../../shared/detection';
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
import { hasActiveRunClaims, hookSessionIdentity, isMaintenancePhase, legacyStatePath, lifecycleCompletedAt, normalizeState, readEffectiveState, readState, statePath, writeState } from '../../shared/state';
import { obj } from '../../shared/obj';
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
  if (!isLikelyCodingPrompt(promptText)) return '';
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
  const ocActive = openCodeDelegationActive(state);
  // Name the concrete cheapest model so the agent passes it on the quick-fix spawn
  // without resolving an indirection (haiku on Claude/Cursor, gpt-5.4-mini on Codex).
  const cheapest = resolveModel('cheapest', host) || 'the cheapest model for this host';
  const signals = hint.signals.length ? ` — signals: ${hint.signals.join(', ')}` : '';
  // Render the OpenCode instruction only when delegation is actually active, so an
  // off state doesn't leave a dead-branch clause a literal reader must evaluate.
  let openCodeClause = '';
  if (ocActive) {
    openCodeClause = teamMode === 'main-agent'
      ? ' If you prefer, offload it free via the `opencode_delegate` tool (role "quick-fix").'
      : ' OpenCode is active — call the `opencode_delegate` tool (role "quick-fix") FIRST; only if it declines, spawn the paid worker.';
  }
  const blockName = teamMode === 'main-agent' ? 'maintenance-triage-main-agent' : 'maintenance-triage-subagents';
  return block(blockName, { HINT: hint.tier, CONFIDENCE: hint.confidence, SIGNALS: signals, CHEAPEST_MODEL: cheapest, OPENCODE_CLAUSE: openCodeClause });
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
    return context(`[ACTIVE STACK: ${stack}]\n\n${block('server-deny-reason', { URL: server.url, WAIT_CMD: onboardingWaitCommand(cwd) })}`, {
      systemMessage: 'traffic-one [setup required]',
    });
  }

  // ── Post-build maintenance triage (appended to whatever context we return) ──
  const triage = maintenanceTriageDirective(cwd, normalizedState, promptText, raw, ctx.host);

  // ── Generic convergence ──
  const materialized = materializeProjectIfNeeded(cwd, { trigger: 'generic user-prompt convergence' });
  if (materialized) {
    const body = triage ? `${materialized.context}\n\n${triage}` : materialized.context;
    return context(body, { systemMessage: materialized.systemMessage });
  }

  if (triage) {
    return context(`[ACTIVE STACK: ${stack}]\n\n${triage}`, { systemMessage: `traffic-one [${stack}] maintenance` });
  }
  return context(`[ACTIVE STACK: ${stack}]`, { systemMessage: `traffic-one [${stack}]` });
}
