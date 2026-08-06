// src/modules/session/prompt-submit.ts
// UserPromptSubmit handler: respects the durable plugin-use choice on every
// prompt, records/clears the team-mode-change approval, and — once a project is a
// Traffic One project but onboarding is incomplete — points the user at the local
// setup wizard (the wizard owns the questions now; this only surfaces its URL and
// converges materialization). A deterministic coding-intent heuristic suppresses
// premature activation on a brand-new project when the prompt is clearly not a
// coding/implementation request. API-key intake belongs to the wizard.

import { context, mergeResults, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { detectMode, detectStackFromCodebase, isLikelyCodingPrompt, isRuntimeControlPrompt, promptHasStackSignal } from '../../shared/detection';
import {
  techClassifyHints,
  techClassifyRequiredCompactReason,
  techClassifyRequiredReason,
} from '../../shared/onboarding-server/tech-classify-setup';
import { seedOriginalPrompt } from '../../shared/onboarding/seed-prompt';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { maybeFlipToMaintenance } from '../materialize/build-complete';
import { prepareOnboardingServer } from '../../shared/onboarding-server/bootstrap';
import { onboardingDeclineCommand, onboardingReconsiderCommand, onboardingSetTechCommandTemplate, onboardingSyncSessionId, usePluginQuestion } from '../../shared/onboarding-server/wait-command';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { formatWizardBanner } from '../../shared/onboarding-server/ensure';
import { computeOnboarding, usePluginQuestionPending } from '../../shared/onboarding-server/flow';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import { windsurfSetupReason, windsurfSetupRepeatReason } from '../../shared/onboarding-server/windsurf-setup';
import { serverRecordExists } from '../../shared/onboarding-server/registry';
import { updateTeamModeChangeApprovalFromPrompt } from '../../shared/onboarding/team-mode-approval';
import { pluginRoot } from '../../shared/paths';
import { promptTextFromSubmit } from '../../shared/prompt-input';
import { makeSkillBlock } from '../../shared/skill-block';
import { isUninstallTrafficOneIntent, uninstallDirective } from '../../shared/uninstall-intent';
import { hookSessionIdentity, isSubagentThread, legacyStatePath, normalizeState, readEffectiveState, readState, statePath, writeState } from '../../shared/state';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { uiLibraryFromPrompt } from '../../shared/capabilities';
import { firstEmitThisSession } from '../../shared/once';
import { localFallbackLine, localFallbackSection, type LocalFallback } from '../../shared/onboarding-server/wizard-links';
import { maintenanceTriageDirective, unresolvedRunDirective } from './triage-directive';
import { buildOpenCodePlanBatchPendingDirective } from '../../shared/opencode-plan/directive';
import { recordPendingModelChoiceReply } from '../agent-model/choice-reply';
import { runSessionStartAuthed } from './session-start';
import { ensureOpenCodeDelegationReady } from './session-start-lib';
import * as fs from 'fs';
import { finalizePaidMaintenanceFallback } from '../../shared/maintenance/fallback';
import { reconcileRunSettlement } from '../../shared/run-settlement';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}, fallback = ''): string =>
  skillBlock('onboarding-gate', name, vars, fallback);

function opencodeSetupDirective(url: string, localFallback: LocalFallback, waitCommand: string, hostLabel = 'OpenCode'): string {
  return [
    'Traffic One project setup is required before building.',
    `Setup link: ${url}`,
    ...(localFallback ? [String(localFallback)] : []),
    `Wait command: ${waitCommand}`,
    'Show the setup link, then immediately run the wait command in the current turn; do not wait for another user message first.',
    `If the wait command prints TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED, stop and tell the user to restart ${hostLabel}, then type "continue" or "resume" after restart.`,
  ].join('\n\n');
}

// The prompt is the only source of `uiLibrary` — there is no wizard step for it —
// so a refused write is the loss of an explicit user instruction, not a cache miss.
// Said once, in both places that record it.
function uiLibraryNotRecorded(library: string): string {
  return `[traffic-one] the UI library you named (\`${library}\`) could not be recorded: the state write fence refused `
    + '`.traffic-one/.one.json`. It will not be applied to this project until that file is writable and you name it again.';
}

// `originalPrompt` seeding lives in shared/onboarding/seed-prompt (also used by
// the onboarding-wait runner's `--use --seed-prompt=…` yes path). While the
// ask-first question is pending it is NEVER called — nothing may be written
// before the user's recorded yes; the prompt rides the yes command instead.

// Post-build maintenance triage lives in ./triage-directive (shared with the
// onboarding-wait runner, which emits it for the SETUP-COMPLETE continuation —
// that request never reaches UserPromptSubmit).

export function runUserPromptSubmit(ctx: Ctx): HookResult {
  // ── Uninstall request ──
  // Deliberately the FIRST thing checked, ahead of every gate below. Uninstalling
  // is machine-global, so cwd is irrelevant: isNonProjectRoot would drop the
  // request when it is typed from $HOME or a non-project dir, the declined-project
  // branch matches the very same "traffic one" mention and would answer with how to
  // RE-ENABLE, and the coding-intent gate drops it on an uninitialized project
  // because asking to uninstall is not a coding prompt. This is also the last
  // moment our code can run at all — no host fires a plugin uninstall hook, so once
  // the bundle is gone nothing of ours executes again. The directive only ARMS the
  // cleanup; the agent takes one explicit confirmation before running it.
  if (isUninstallTrafficOneIntent(ctx.input.prompt || promptTextFromSubmit(ctx.input.raw))) {
    return context(uninstallDirective(ctx.host), { systemMessage: 'traffic-one [uninstall requested]' });
  }

  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  initializeTrafficOneEnv(cwd, ctx.host);

  const raw = ctx.input.raw;
  const sessionId = hookSessionIdentity(raw).sessionId;
  const syncSession = onboardingSyncSessionId(sessionId);
  const promptText = ctx.input.prompt || promptTextFromSubmit(raw);

  // Declined project: Traffic One stays silent on every prompt. The ONE signal
  // that re-opens the conversation is the user explicitly naming Traffic One —
  // then the agent is told how to re-enable it (which re-runs onboarding and,
  // in ask-first mode, the use-plugin question).
  if (pluginUseDeclined(cwd)) {
    if (/\btraffic[\s_-]?one\b/i.test(promptText)) {
      return context(
        'traffic-one — this project has Traffic One DISABLED by the user\'s own earlier choice. '
        + 'If the user is now asking to use/enable Traffic One here, run this command, then follow its output:\n'
        + `${onboardingReconsiderCommand(cwd, ctx.host, syncSession)}\n`
        + 'If the user is asking something else, continue without Traffic One and do not mention it.',
      );
    }
    return noop();
  }

  // ── Auth gate ──
  // Auth intake now lives in the wizard's api-key page (never in a prompt message,
  // which some hosts flag). When auth is enforced but the key isn't entered yet,
  // computeOnboarding returns the 'api-key' step, so the onboarding-incomplete
  // surface below points the user at the wizard (which shows that page). Nothing to
  // parse from the prompt here.

  // ── Disabled/unavailable-model spawn choice (Cursor) ──
  // When picked tier models aren't offered (or the spawn gate surfaced a degradation choice),
  // the user's reply lands here. Honor it before any other handling. Fail closed: nothing
  // records `use-fallback` except this explicit chat reply (or a future host modal).
  // NOTE: pending may only be armed by the failure reconcile at priority 35 on this same
  // event — the agent-model.model-choice-reply sweep (priority 45) re-runs this recorder
  // after the reconcile so the FIRST reply is never dropped.
  {
    const recorded = recordPendingModelChoiceReply(cwd, promptText);
    if (recorded) return recorded;
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
  // classifyPromptForStack maps to a bare frontend shell carrying none of the real
  // project's surfaces. A signal-less greeting/question still has no stack signal,
  // so genuine chit-chat is still suppressed.
  if (uninitialized && !serverRecordExists(cwd)
    && !isLikelyCodingPrompt(promptText) && !promptHasStackSignal(promptText)) {
    return noop();
  }

  // Any interaction on a not-yet-initialized project (SessionStart fires before a
  // prompt exists and defers a pristine new project) runs the authed SessionStart
  // body now — this is where new-project setup / existing-codebase auto-detect
  // actually starts. Auth is handled by the onboarding surface (it shows the
  // api-key page first while unauthenticated).
  if (uninitialized) {
    const bootstrapped = runSessionStartAuthed(ctx);
    // Ask-first pending: write NOTHING before the user's answer — the prompt
    // rides the yes command (--seed-prompt) inside the question the authed body
    // just emitted, and the runner seeds it after recording the yes.
    if (!usePluginQuestionPending(cwd)) {
      seedOriginalPrompt(cwd, promptText);
      const explicitUiLibrary = uiLibraryFromPrompt(promptText);
      if (explicitUiLibrary && fs.existsSync(statePath(cwd))) {
        // The prompt is the ONLY source of `uiLibrary` — the wizard has no step
        // for it — so a refused write loses the user's explicit request outright
        // unless they happen to name the library again in a later prompt. Merged
        // onto the bootstrap result rather than dropped; a deny short-circuits the
        // merge, so this never dilutes a refusal.
        if (!writeState(cwd, { ...readState(cwd), uiLibrary: explicitUiLibrary })) {
          return mergeResults([bootstrapped, context(uiLibraryNotRecorded(explicitUiLibrary))]);
        }
      }
    }
    return bootstrapped;
  }
  let state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return runSessionStartAuthed(ctx);
  const explicitUiLibrary = uiLibraryFromPrompt(promptText);
  let uiLibraryRefused = '';
  if (explicitUiLibrary && state.uiLibrary !== explicitUiLibrary && !isSubagentThread(raw)) {
    // Only mirror into the in-memory state once the write has landed: everything
    // below this point reads `state`, and carrying a `uiLibrary` that `.one.json`
    // does not have is how the rest of the session behaves correctly on a value
    // no later hook can read back.
    if (writeState(cwd, { ...readState(cwd), uiLibrary: explicitUiLibrary })) {
      state = { ...state, uiLibrary: explicitUiLibrary };
    } else {
      uiLibraryRefused = uiLibraryNotRecorded(explicitUiLibrary);
    }
  }
  const settlementRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (settlementRunId && !isSubagentThread(raw)) {
    const fallback = finalizePaidMaintenanceFallback(cwd, settlementRunId);
    if (fallback.status !== 'completed') reconcileRunSettlement(cwd, settlementRunId);
  }

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
  const onboardingView = computeOnboarding(cwd);
  if (!onboardingView.done) {
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
    // Ask-first: relay the host-chat question instead of launching the wizard —
    // no server, no URL, and no writes (seeding included) until the user answers
    // yes. The prompt rides the yes command so the runner seeds it post-yes.
    if (usePluginQuestionPending(cwd)) {
      return context(`[ACTIVE STACK: ${stack}]\n\n${usePluginQuestion(cwd, ctx.host, promptText, syncSession)}`, {
        systemMessage: 'traffic-one [asking whether to use Traffic One]',
      });
    }
    seedOriginalPrompt(cwd, promptText);
    // Setup is pending on the AGENT (tech classification), not the user: no
    // wizard server, no link — hand the classification recipe to the agent
    // (the seeded prompt above still feeds postSetupTriage after completion).
    if (onboardingView.step === 'tech-detect') {
      const template = onboardingSetTechCommandTemplate(cwd, ctx.host, syncSession);
      const hints = techClassifyHints(detectStackFromCodebase(cwd));
      const reason = ctx.host === 'opencode' || ctx.host === 'kilo'
        ? techClassifyRequiredCompactReason(template, hints)
        : block('tech-classify-required', {
          SET_TECH_TEMPLATE: template,
          HINTS: hints,
        }, techClassifyRequiredReason(template, hints));
      return context(`[ACTIVE STACK: ${stack}]\n\n${reason}`, {
        systemMessage: 'traffic-one [setup required]',
      });
    }
    const prepared = prepareOnboardingServer(cwd, ctx.host, { syncSession });
    if (prepared.kind !== 'ready') {
      return context(`[ACTIVE STACK: ${stack}]\n\n${prepared.reason}`, {
        systemMessage: prepared.kind === 'bootstrap-required'
          ? 'traffic-one [setup permission required]'
          : 'traffic-one [setup launcher failed]',
      });
    }
    const { server, waitCommand } = prepared;
    // Hosted link alone when the dashboard is healthy; the loopback wizard joins it
    // only when the probe says the hosted page is unusable (or has not answered yet).
    const localFallback = localFallbackSection(cwd, server.localWizardUrl, process.env, ctx.host);
    if (ctx.host === 'opencode' || ctx.host === 'kilo') {
      const systemMessage = formatWizardBanner(ctx.host, server.dashboardUrl, localFallback, 'traffic-one [setup required]');
      return context(`[ACTIVE STACK: ${stack}]\n\n${opencodeSetupDirective(server.dashboardUrl, localFallbackLine(cwd, server.localWizardUrl, process.env, ctx.host), waitCommand, ctx.host === 'kilo' ? 'Kilo' : 'OpenCode')}`, {
        systemMessage,
      });
    }
    if (ctx.host === 'windsurf') {
      const first = firstEmitThisSession(cwd, 'onboarding-deny', sessionId);
      const vars = { URL: server.dashboardUrl, LOCAL_FALLBACK: localFallback, WAIT_CMD: waitCommand };
      const directive = first
        ? block('windsurf-server-deny-reason', vars, windsurfSetupReason(server.dashboardUrl, localFallback, waitCommand))
        : block('windsurf-server-deny-reason-repeat', vars, windsurfSetupRepeatReason(server.dashboardUrl, localFallback, waitCommand));
      return context(directive, {
        systemMessage: formatWizardBanner(ctx.host, server.dashboardUrl, localFallback, 'traffic-one [setup required]'),
      });
    }
    // Full walkthrough once per session (shared marker with the PreToolUse gate);
    // repeat prompts get the short URL + wait-command essentials.
    const wizardBlock = firstEmitThisSession(cwd, 'onboarding-deny', sessionId)
      ? 'server-deny-reason'
      : 'server-deny-reason-repeat';
    // The full recipe rides additional_context (agent-facing). On Cursor that is the
    // ONLY place the URL would appear unless the agent reposts it as a link — and it
    // may not. So also put the LIVE clickable wizard URL in the user-facing channel
    // (systemMessage → user_message on Cursor), so the user always gets a working link
    // on the first prompt regardless of the agent.
    const systemMessage = formatWizardBanner(ctx.host, server.dashboardUrl, localFallback, 'traffic-one [setup required]');
    return context(`[ACTIVE STACK: ${stack}]\n\n${block(wizardBlock, {
      URL: server.dashboardUrl,
      LOCAL_FALLBACK: localFallback,
      WAIT_CMD: waitCommand,
      DECLINE_CMD: onboardingDeclineCommand(cwd, ctx.host),
    })}`, {
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
  // Runtime-only local server/process commands are parent work. Do not even emit
  // OpenCode setup/batch routing around them; maintenanceTriageDirective also skips
  // run creation and worker instructions for this same narrow classification.
  const runtimeControl = isRuntimeControlPrompt(promptText);
  const unresolved = runtimeControl ? '' : unresolvedRunDirective(cwd, normalizedState, promptText, raw);
  const parentOwned = runtimeControl || Boolean(unresolved);
  const openCodeReadiness = parentOwned ? '' : ensureOpenCodeDelegationReady(cwd, normalizedState);
  // Full pending-batch recipe once per session, then a one-line reminder — this
  // fires on EVERY prompt while the batch is open. The spawn gate stays the
  // enforcement; the marker is burned only when a directive actually emitted.
  const planBatchDirective = parentOwned ? '' : buildOpenCodePlanBatchPendingDirective(cwd, normalizedState);
  const planBatchReminder = planBatchDirective
    ? (firstEmitThisSession(cwd, 'opencode-plan-batch-pending', sessionId)
      ? planBatchDirective
      : '[traffic-one] OpenCode Step 0 still pending — finish the plan batch via `opencode_delegate_from_plan` before implementer spawns (full recipe earlier this session).')
    : '';
  const triage = unresolved || maintenanceTriageDirective(cwd, normalizedState, promptText, raw, ctx.host);

  const prefixOpenCode = [uiLibraryRefused, openCodeReadiness, planBatchReminder].filter(Boolean).join('\n');

  // ── Generic convergence ──
  const materialized = materializeProjectIfNeeded(cwd, { trigger: 'generic user-prompt convergence' });
  if (materialized) {
    const readiness = prefixOpenCode ? `${prefixOpenCode}\n` : '';
    const body = triage ? `${readiness}${materialized.context}\n\n${triage}` : `${readiness}${materialized.context}`;
    return context(body, { systemMessage: materialized.systemMessage });
  }

  if (triage) {
    return context(`${prefixOpenCode}[ACTIVE STACK: ${stack}]\n\n${triage}`, {
      systemMessage: unresolved
        ? `traffic-one [${stack}] unresolved run`
        : `traffic-one [${stack}] maintenance`,
    });
  }
  return context(`${prefixOpenCode}[ACTIVE STACK: ${stack}]`, { systemMessage: `traffic-one [${stack}]` });
}
