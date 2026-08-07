// src/modules/onboarding-gate/handler.ts
// PreToolUse onboarding gate (priority 10): until onboarding is complete, ensure
// the local wizard server is running and DENY mutating tools with its URL. The
// questions + per-answer state writes now live in the wizard server
// (shared/onboarding-server), not in agent prose — so this gate no longer emits
// per-step popups or chat fallbacks. Auth is enforced by the priority-0 session
// gate before this runs. Read-only orientation and writing the canonical state
// file stay allowed; once onboarding is complete we converge materialization
// exactly as before. Completeness is computed by the SAME predicates the wizard
// uses (computeOnboarding), covering both new-project onboarding and an existing
// project missing this user's local preferences.

import * as fs from 'fs';

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { detectMode, detectStackFromCodebase } from '../../shared/detection';
import {
  techClassifyHints,
  techClassifyRequiredCompactReason,
  techClassifyRequiredReason,
} from '../../shared/onboarding-server/tech-classify-setup';
import { isOnboardedProjectRoot } from '../../shared/hook/paths';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { buildOrchestrationDirective } from '../plan-guard/build-orchestration-directive';
import { maintenanceTriageFallbackDirective } from '../session/triage-directive';
import { prepareOnboardingServer } from '../../shared/onboarding-server/bootstrap';
import { claimLaunchTimeoutRetry } from '../../shared/onboarding-server/launch-timeout';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import { claudeWaitBackgroundDeniedReason, claudeWaitLinkFirstReason } from '../../shared/onboarding-server/claude-setup';
import { assistantPostedLink } from '../../shared/onboarding-server/link-evidence';
import { codexWaitLinkFirstReason } from '../../shared/onboarding-server/codex-setup';
import { cursorWaitLinkFirstReason } from '../../shared/onboarding-server/cursor-setup';
import { windsurfSetupReason, windsurfSetupRepeatReason } from '../../shared/onboarding-server/windsurf-setup';
import { teamModeDowngradeViolation, teamModeMarkerWriteViolation } from '../../shared/onboarding/team-mode-approval';
import { windsurfBackend } from '../../shared/windsurf-backend';
import { pluginRoot } from '../../shared/paths';
import { firstEmitThisSession } from '../../shared/once';
import {
  localFallbackLine,
  localFallbackSection,
  SETUP_LINK_NUDGE_TTL_MS,
  setupLinkNudgeLabel,
  type LocalFallback,
  wizardOpened,
} from '../../shared/onboarding-server/wizard-links';
import { formatWizardBanner, processAlive } from '../../shared/onboarding-server/ensure';
import { readServerRecord } from '../../shared/onboarding-server/registry';
import { agentOnboardingUrls } from '../../config/dashboard';
import { emittedWithin, stampEmitMarker } from '../../shared/once';
import { ensureOnboardingWaitPermission } from '../../shared/onboarding-server/wait-permission';
import { makeSkillBlock } from '../../shared/skill-block';
import { ensureCurrentRunId, hookSessionIdentity, isSubagentThread, normalizeState, readEffectiveState } from '../../shared/state';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { canonicalToolName, isBrowserOpenCommand, isModelCaptureCommand, isMutatingPreToolUse, isOnboardingBootstrapCommand, isOnboardingWaitCommand, isReadOnlyOrientationToolUse, isStateFileOnlyWritePatch, isStateFilePath, isTrafficOneDoctorCommand, parsedToolInput } from '../../shared/tool-classify';
import { browserOpenDeniedReason } from '../../shared/onboarding-server/browser-open';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { usePluginQuestionPending } from '../../shared/onboarding-server/flow';
import { onboardingDeclineCommand, onboardingSetTechCommandTemplate, onboardingSyncSessionId, usePluginQuestion } from '../../shared/onboarding-server/wait-command';
import {
  cursorRunPolicyMissingTiers,
  ensureRunModelPolicy,
  readRunModelPolicy,
  runModelPolicyPath,
} from '../../shared/run-model-policy';
import { modelCaptureCommand } from '../../shared/model-gate-command';
import { resolveToolScope } from '../../shared/tool-scope';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}, fallback = ''): string =>
  skillBlock('onboarding-gate', name, vars, fallback);

// A tool that can only LOOK. Deliberately the read-tool half of
// isReadOnlyOrientationToolUse without its shell half: this predicate guards the
// infrastructure-failure carve-out below, where "the launcher is broken" must
// never cost the user the ability to read their own code, and where admitting
// arbitrary non-mutating shell would also admit arbitrary code execution.
// `toolName` is the adapter-canonical name (canonicalToolName), so Cursor's
// coarse `before-read-file`/`before-grep` subcommands arrive here already mapped
// to Read/Grep by their tool CLASS.
const READ_ONLY_INSPECTION_TOOL = /^(Read|Glob|Grep|LS|NotebookRead)$/i;

function isReadOnlyInspectionTool(toolName: string): boolean {
  const name = toolName.includes('.') ? (toolName.split('.').pop() as string) : toolName;
  return READ_ONLY_INSPECTION_TOOL.test(name);
}

// Read-only orientation is deliberately NOT denied while setup is pending — but a
// bare noop() meant a session that only reads produced no user-visible surface at
// all, so the link existed only in a collapsed tool result and a background task
// file. Observed live: the user never received a link and setup could not complete.
//
// Ride a `systemMessage` on the release instead. It is the USER-facing channel
// (→ user_message on Cursor) and an empty `context` costs zero prompt tokens on
// Claude, so this stays free and never blocks the tool. Same wording every other
// surface uses, so no new prose and no T1BLOCK.
// Read a LIVE wizard link without spawning anything. prepareOnboardingServer would
// launch a server as a side effect, which a nudge must never do. Also the Stop
// backstop's engagement gate: no live record ⇒ this session never engaged setup.
export function liveWizardLink(root: string, host: string): { dashboardUrl: string; token: string; localFallback: LocalFallback } | null {
  const rec = readServerRecord(root, process.env, host);
  if (!rec || rec.url.includes(':0/') || !processAlive(rec.pid)) return null;
  const urls = agentOnboardingUrls(process.env, rec.port, rec.token);
  const dashboardUrl = urls.dashboardUrl || urls.localWizardUrl;
  if (!dashboardUrl) return null;
  return {
    dashboardUrl,
    token: rec.token,
    localFallback: localFallbackSection(root, urls.localWizardUrl, process.env, host),
  };
}

function setupLinkNudge(
  root: string,
  host: string,
  dashboardUrl: string,
  token: string,
  localFallback: LocalFallback,
): HookResult {
  // Only where an empty context is genuinely free and systemMessage is a
  // user-visible channel: Claude/Cursor (systemMessage → user_message), Copilot
  // (systemMessage rides both wire surfaces; the CLI omits an empty context), and
  // Windsurf-Cascade (hook stdout renders under show_output: true). Codex stays
  // excluded — it emits additionalContext unconditionally, so an empty context is
  // not free and the deny reason is its only real surface. OpenCode/Kilo deliver
  // through their wrapper's own prompt-part/idle surfaces instead.
  if (host !== 'claude' && host !== 'cursor' && host !== 'copilot' && host !== 'windsurf') return noop();
  // Devin native merges systemMessage into agent-facing additionalContext — the
  // nudge would burn the shared TTL marker without ever reaching the user (the
  // exact invisible-producer failure this marker discipline exists to prevent).
  // Devin's own Stop block owns re-delivery there; only Cascade renders hook
  // stdout to the user.
  if (host === 'windsurf' && windsurfBackend(process.env) === 'devin') return noop();
  // Never emit a placeholder, and stand down once a browser demonstrably has the
  // wizard open — re-offering then reads as "start over" mid-setup.
  if (!dashboardUrl) return noop();
  if (wizardOpened(root, token, process.env, host)) return noop();
  // Cross-process TTL: the waiter and every hook process are separate PIDs.
  if (emittedWithin(root, setupLinkNudgeLabel(token), SETUP_LINK_NUDGE_TTL_MS)) return noop();
  stampEmitMarker(root, setupLinkNudgeLabel(token));
  return context('', {
    systemMessage: formatWizardBanner(host, dashboardUrl, localFallback, 'traffic-one [setup required]'),
  });
}


export function onboardingGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  // Use the adapter-parsed (host-agnostic) tool for classification. Cursor's
  // rawName is a coarse subcommand (before-shell-execution …) the classifiers
  // don't recognize, and its command/path live on the parsed tool, NOT
  // raw.tool_input — so deriving from raw alone made every command/file allow-check
  // (the onboarding wait command, read-only orientation) silently fail on Cursor.
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  // Doctor is the recovery command this gate's own deny prose prescribes, so it
  // must be callable from EVERY state a user can be stuck in — including the
  // pre-consent one, where the ask-first fence below denies unconditionally,
  // and the onboarded-but-unbuildable ones, where the Cursor model-policy
  // branches deny long after any per-branch exemption. Hoisted to the top of
  // the handler, ahead of every fence, because an exemption placed inside one
  // branch is only reachable on that branch's `prepared.kind` and left doctor
  // denied in exactly the states it exists for.
  //
  // Nothing above it and nothing after it runs: this returns before
  // resolveToolScope, initializeTrafficOneEnv, computeOnboarding,
  // prepareOnboardingServer (which would SPAWN a wizard server) and the
  // ensureCurrentRunId/ensureRunModelPolicy writers — so a pre-consent project
  // stays byte-identical, which is the consent write fence's requirement.
  // isTrafficOneDoctorCommand is a bounded exact-argv grammar over
  // `node <this runtime's own doctor.cjs> [one recognized flag]`
  // (tool-classify.ts), so this cannot widen to any other command.
  if (isTrafficOneDoctorCommand(toolName, toolInput)) return noop();
  const cwd = ctx.cwd;

  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
  const toolScope = resolveToolScope(ctx);
  if (toolScope.standsDown) return noop();
  // Monorepo safety: a scaffolder may run from a sub-package cwd or target a
  // sub-package file. Resolve UP to the workspace root that holds onboarding state,
  // so a stray per-package state file can't trip a bogus per-package wizard or hide
  // that the root is already onboarded. A hook whose raw cwd is the plugin
  // source instead resolves against its explicit external file/workdir/command
  // target, so authoring stand-down never leaks across the boundary.
  const root = toolScope.projectRoot;
  // The resolver skips authoring roots, but its fallback can still return cwd /
  // a hint dir inside the plugin repo — never gate or materialize there.
  if (isNonProjectRoot(root)) return noop();
  initializeTrafficOneEnv(root, ctx.host);

  // Cursor child events do not consistently carry a parent/subagent bit. The
  // onboarding registry records the main conversation; any other conversation
  // for that onboarded workspace is a child. Compute this once and apply it to
  // both incomplete and complete flows so a child can never mint/rebase the
  // parent run policy or be sent back through onboarding.
  const identity = hookSessionIdentity(raw);
  const syncSession = onboardingSyncSessionId(identity.sessionId);
  const workspaceRoot = asString(ctx.input.workspaceRoot);
  const cursorSessionRoot = isOnboardedProjectRoot(root)
    ? root
    : (workspaceRoot && isOnboardedProjectRoot(workspaceRoot) ? workspaceRoot : root);
  const childEvent = isSubagentThread(raw)
    || (ctx.host === 'cursor'
      && Boolean(identity.sessionId)
      && isForeignOnboardingThread(cursorSessionRoot, identity.sessionId || ''));

  if (pluginUseDeclined(root)) return noop();
  // computeOnboarding returns the 'api-key' step while the API key is missing,
  // so this gate opens the wizard on that page and blocks mutating tools until
  // the key is validated and stored.

  const state = readEffectiveState(root, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const mode = (state.mode as string) || detectMode(root);
  const effectiveState: Rec = { ...state, mode };
  normalizeState(effectiveState, mode);

  // Team-mode write guards stay active — these are post-onboarding runtime
  // guardrails, not onboarding questions.
  if (teamModeMarkerWriteViolation(root, toolName, toolInput)) {
    return deny(block('team-mode-marker-guard'), { denyId: 'team-mode-marker-guard' });
  }
  if (teamModeDowngradeViolation(root, toolName, toolInput, effectiveState)) {
    return deny(block('team-mode-downgrade-guard'), { denyId: 'team-mode-downgrade-guard' });
  }

  // The model is allowed to write the canonical state file itself — the state
  // gate's own deny prose tells it to ("Write the Traffic One state file with
  // mode, stack, backend, realtime, confirmed, onboardingComplete …"), so this
  // exemption is load-bearing and removing it would deny the command the
  // product prescribes.
  //
  // WRITE, though, not "touch by any means". The patch half used to admit a
  // `*** Delete File: .traffic-one/.one.json` patch, because it asked only
  // which files the operations NAME and never which operations they are:
  // measured on an onboarding-incomplete project, that patch returned `noop`
  // from this gate while the same project denied an ordinary `src/app.ts`
  // write. isStateFileOnlyWritePatch asks for add/update only.
  //
  // Deliberately NOT also anchored to `root`. The obvious second narrowing —
  // "and it must be THIS project's state file" — is vacuous here: for a
  // foreign state path, absolute or via `../`, resolveToolScope re-anchors
  // `root` onto that project before this line runs (measured both spellings),
  // so the anchored predicate would compare the target against the very root
  // the target selected and pass every time.
  if (isStateFilePath(filePath) || isStateFileOnlyWritePatch(toolName, toolInput)) return noop();

  const onboarding = computeOnboarding(root);
  const onboardingComplete = onboarding.done;
  if (!onboardingComplete) {
    // A SUBAGENT must never be sent to the setup wizard. Onboarding is the parent/
    // main-agent's job, completed BEFORE any subagent spawns, and a worker thread
    // cannot make the in-app browser visible to show the wizard — so a deny here
    // just traps it looping on the wait command. Reaching this branch in a subagent
    // means a stray nested root was resolved (e.g. a leaked packages/*/.traffic-one);
    // let the worker proceed with its assigned task (often REMOVING that leak).
    if (childEvent) return noop();
    // Cursor fallback: a subagent's OWN events carry no reliable subagent marker, so
    // isSubagentThread can't catch them, and an onboarding-incomplete subagent here would loop on
    // the wait command. The orchestrator's session is recorded as MAIN at subagentStart; a session
    // that is NOT a known main session is a subagent → let it proceed (don't trap it on the wizard).
    // Cursor does not reliably render UserPromptSubmit user_message, and agents sometimes skip
    // reposting the URL before running the wait command. Force one visible, clickable link at the
    // shell boundary, then allow the retry so setup can block normally.
    // A backgrounded onboarding runner (bootstrap or waiter) writes its output —
    // including the setup link it prints — into a background task file the user
    // never opens, and its nonzero pending exit renders as "Background task
    // failed", which the agent reads as a broken command and abandons (observed
    // live on 1.0.43). Only Claude's Bash payload carries the flag; deny EVERY
    // such request — backgrounding is never right here — and prescribe the
    // identical command in the foreground. Hoisted ABOVE the bootstrap release
    // below so a backgrounded `--use --bootstrap-only` is caught too.
    if (ctx.host === 'claude'
      && toolInput.run_in_background === true
      && (isOnboardingBootstrapCommand(toolName, toolInput) || isOnboardingWaitCommand(toolName, toolInput))) {
      const live = liveWizardLink(root, ctx.host);
      const urlLine = live ? `Open Traffic One setup: ${live.dashboardUrl}` : '';
      const observed = asString(toolInput.command ?? toolInput.cmd);
      return deny(block('claude-wait-background-denied', {
        URL_LINE: urlLine,
        WAIT_CMD: observed,
      }, claudeWaitBackgroundDeniedReason(urlLine, observed)), { denyId: 'claude-wait-background-denied' });
    }
    // The approved bootstrap is the only way a sandboxed hook can start an
    // unsandboxed wizard that owns ~/.traffic-one/projects. Admit it before the
    // Cursor URL-repost path, which necessarily calls the same failing launcher.
    if (isOnboardingBootstrapCommand(toolName, toolInput)) return noop();
    // Hoisted ABOVE every orientation release below — `open '<url>'` matches
    // nothing in the mutating-command vocabulary, so each host branch would
    // otherwise wave it through as harmless orientation. The user opens the setup
    // link themselves; an agent that opens it also tends to believe it "shared"
    // the link, and then never posts it (observed 2cu/5cu).
    if (isBrowserOpenCommand(toolName, toolInput)) {
      return deny(block('browser-open-denied', {}, browserOpenDeniedReason()), { denyId: 'browser-open-denied' });
    }
    // Setup is pending on the AGENT (tech classification), not the user: the
    // deterministic tables derived no stack, so the agent must inspect the repo
    // and submit via `--set-tech`. No wizard/link ceremony here — reads stay
    // allowed (inspection IS the classification work), the runner commands
    // pass (the waiter/bootstrap self-direct with their own token), and every
    // mutating tool gets the recipe. Ask-first still owns the pre-consent turn
    // (its deny below asks the question instead).
    if (onboarding.step === 'tech-detect' && !usePluginQuestionPending(root)) {
      if (isOnboardingWaitCommand(toolName, toolInput)) return noop();
      if (isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
      const template = onboardingSetTechCommandTemplate(root, ctx.host, syncSession);
      const hints = techClassifyHints(detectStackFromCodebase(root));
      const reason = ctx.host === 'opencode' || ctx.host === 'kilo'
        ? techClassifyRequiredCompactReason(template, hints)
        : block('tech-classify-required', {
          SET_TECH_TEMPLATE: template,
          HINTS: hints,
        }, techClassifyRequiredReason(template, hints));
      return deny(reason, { denyId: 'tech-classify-required' });
    }
    if (isOnboardingWaitCommand(toolName, toolInput)) {
      // Ask-first pending: the runner invocation IS the answer path (--use /
      // --decline) — let it run without pre-launching the wizard or reposting
      // a URL the user has not said yes to.
      if (usePluginQuestionPending(root)) return noop();
      if (ctx.host === 'cursor') {
        const prepared = prepareOnboardingServer(root, ctx.host, { syncSession });
        // The wait command is the recovery path when the hook sandbox itself
        // cannot launch the wizard. Never deny that recovery command merely
        // because the same restricted hook cannot pre-create its URL.
        if (prepared.kind !== 'ready') return noop();
        const { server, waitCommand } = prepared;
        // The user has the wizard open in a browser — the server watched it arrive.
        // Ordering another post now would race them finishing setup. This is the
        // ONLY thing that silences this branch: the old marker fired whenever some
        // surface merely PRODUCED the links, including the bootstrap stdout Cursor
        // collapses into "ran N commands", which is exactly how a run reached the
        // user with the agent claiming a link it had never posted.
        if (wizardOpened(root, server.token, process.env, ctx.host)) return noop();
        const id = hookSessionIdentity(raw).sessionId;
        // Same assistant-posted stand-down as Claude/Codex. Cursor DOES expose a
        // readable parent transcript — `~/.cursor/projects/<slug>/agent-transcripts/
        // <id>/<id>.jsonl` — whose assistant records separate `text` blocks (the
        // model speaking) from `tool_use` blocks (an `open '<url>'` that shows the
        // user nothing). Only the former counts, so this cannot be satisfied by
        // the bootstrap stdout Cursor collapses into "ran N commands".
        if (server.dashboardUrl && assistantPostedLink({
          url: server.dashboardUrl,
          host: ctx.host,
          raw,
          sessionId: id,
          cwd: root,
        })) return noop();
        if (server.dashboardUrl
          && firstEmitThisSession(root, 'cursor-onboarding-wait-link', id)) {
          const localFallback = localFallbackSection(root, server.localWizardUrl, process.env, ctx.host);
          return deny(block('cursor-wait-link-first', {
            URL: server.dashboardUrl,
            LOCAL_FALLBACK: localFallback,
            WAIT_CMD: waitCommand,
          }, cursorWaitLinkFirstReason(server.dashboardUrl, localFallback, waitCommand)), { denyId: 'cursor-wait-link-first' });
        }
      }
      // Claude mirrors the Cursor link-first deny: hook output and blocked
      // commands render inside a collapsed tool block, so the nudge below is
      // agent-invisible in practice and the recipe's "post the link" step is
      // routinely skipped (observed live on 1.0.43 — the user never got a link).
      // One deny per session orders the visible repost; the allowed retry then
      // proceeds into the blocking wait. Never fired over an open wizard, and the
      // recovery path (server not ready) is never trapped. A link the ASSISTANT
      // already posted in the live transcript is delivery evidence too (observed
      // 16cl/019fbca1 on 1.0.45: the compliant model posted right after
      // bootstrap, and this deny — arrival-only back then — ordered a duplicate
      // in the seconds before the user could click); the wait then runs with no
      // deny AND no nudge ride.
      if (ctx.host === 'claude') {
        const prepared = prepareOnboardingServer(root, ctx.host, { syncSession });
        if (prepared.kind === 'ready') {
          const { server, waitCommand } = prepared;
          if (server.dashboardUrl && !wizardOpened(root, server.token, process.env, ctx.host)) {
            if (assistantPostedLink({
              url: server.dashboardUrl,
              host: ctx.host,
              raw,
              sessionId: hookSessionIdentity(raw).sessionId,
            })) return noop();
            if (firstEmitThisSession(root, 'claude-onboarding-wait-link', hookSessionIdentity(raw).sessionId)) {
              const localFallback = localFallbackSection(root, server.localWizardUrl, process.env, ctx.host);
              return deny(block('claude-wait-link-first', {
                URL: server.dashboardUrl,
                LOCAL_FALLBACK: localFallback,
                WAIT_CMD: waitCommand,
              }, claudeWaitLinkFirstReason(server.dashboardUrl, localFallback, waitCommand)), { denyId: 'claude-wait-link-first' });
            }
          }
        }
      }
      // Codex: the deny reason is the ONLY channel that reaches the model (see
      // the walkthrough comment below), so the wait command gets its own
      // self-contained link-first deny. DEDICATED marker — deliberately not
      // 'onboarding-deny-tool': an orientation call may have burned the
      // walkthrough without the link ever being posted, and this deny must not
      // consume the walkthrough for later mutating calls either. Same
      // assistant-posted stand-down as Claude (the rollout is the transcript).
      if (ctx.host === 'codex') {
        const prepared = prepareOnboardingServer(root, ctx.host, { syncSession });
        if (prepared.kind === 'ready') {
          const { server, waitCommand } = prepared;
          if (server.dashboardUrl && !wizardOpened(root, server.token, process.env, ctx.host)) {
            if (assistantPostedLink({
              url: server.dashboardUrl,
              host: ctx.host,
              raw,
              sessionId: hookSessionIdentity(raw).sessionId,
            })) return noop();
            if (firstEmitThisSession(root, 'codex-onboarding-wait-link', hookSessionIdentity(raw).sessionId)) {
              const localFallback = localFallbackSection(root, server.localWizardUrl, process.env, ctx.host);
              return deny(block('codex-wait-link-first', {
                URL: server.dashboardUrl,
                LOCAL_FALLBACK: localFallback,
                WAIT_CMD: waitCommand,
              }, codexWaitLinkFirstReason(server.dashboardUrl, localFallback, waitCommand)), { denyId: 'codex-wait-link-first' });
            }
          }
        }
      }
      // The waiter is the LAST tool call before the agent blocks — often for
      // minutes, and frequently as a background task whose banner lands in a file
      // the user never opens. So this is the final chance to put the link in front
      // of them: after this there are no more PreToolUse events to ride on.
      // Observed live: "Ran 2 commands → Waiting for setup completion", 4 minutes,
      // no link anywhere the user could see it.
      // Not on Cursor: its branch above owns a purpose-built link deny, and reaching
      // here means it deliberately stayed quiet (wizard already open, or the link
      // was delivered this session). A second surface would just double-post.
      const waitLink = ctx.host === 'cursor' ? null : liveWizardLink(root, ctx.host);
      if (waitLink) {
        return setupLinkNudge(root, ctx.host, waitLink.dashboardUrl, waitLink.token, waitLink.localFallback);
      }
      return noop();
    }
    // Ask-first: the user has not said whether this project uses Traffic One.
    // Deny mutating work with the HOST-CHAT question — no wizard server, no
    // setup URL, until the user answers (yes → --use runs the normal wait).
    if (usePluginQuestionPending(root)) {
      return deny(usePluginQuestion(root, ctx.host, undefined, syncSession), { denyId: 'onboarding-use-plugin-question' });
    }
    const declineCmd = onboardingDeclineCommand(root, ctx.host);
    const prepared = prepareOnboardingServer(root, ctx.host, { syncSession });
    if (prepared.kind !== 'ready') {
      // (The doctor exemption that used to live here, guarded on
      // `prepared.kind === 'start-failed'`, is now unconditional at the top of
      // this handler — it was unreachable from the ask-first fence above and
      // from the Cursor branches below, which is precisely the states a stuck
      // user runs doctor from.)
      //
      // INFRASTRUCTURE FAILURE NEVER BLOCKS READING. Measured before this
      // existed: on every host but Windsurf, a launcher failure denied Read,
      // Grep, Glob and LS as well as writes, so a user whose setup server could
      // not start could not inspect their own code — and the agent could not
      // gather the evidence the diagnostic asks it to report. Windsurf already
      // carved this out for its own rendering reasons; the principle is
      // host-independent and the carve-out is now unconditional.
      //
      // Deliberately NARROWER than the Windsurf line it replaces:
      // isReadOnlyOrientationToolUse also admits every non-mutating SHELL
      // command, and `node some-script.cjs` is arbitrary execution, not a read.
      // Widening that to all hosts would, among other things, wave through the
      // near-collision doctor copies the exact-argv doctor grammar above exists
      // to refuse. Reads are reads.
      if (isReadOnlyInspectionTool(toolName)) return noop();
      if (ctx.host === 'windsurf' && isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
      if (prepared.kind === 'start-timeout') {
        // Bounded-then-terminal. The retry is prescribed at most ONCE per
        // (project, host) per ten minutes, by the runtime rather than by the
        // prose — an agent can ignore "retry once", it cannot ignore being
        // handed the terminal message instead. The claim is taken HERE, at the
        // only surface that BLOCKS: prompt-submit and SessionStart also observe
        // this timeout and render the same retryable text, but they release the
        // turn, so letting one of them spend the budget would hand this gate
        // the terminal message on the very first tool call.
        return claimLaunchTimeoutRetry(root, process.env, ctx.host)
          ? deny(prepared.reason, { denyId: 'onboarding-server-start-timeout' })
          : deny(prepared.terminalReason, { denyId: 'onboarding-server-start-timeout-exhausted' });
      }
      return deny(prepared.reason, {
        denyId: prepared.kind === 'start-failed'
          ? 'onboarding-server-start-failed'
          : 'onboarding-server-not-ready',
      });
    }
    const { server, waitCommand } = prepared;
    // Every deny below prescribes the wait command; make sure the host's
    // permission classifier will let it run without another interruption.
    ensureOnboardingWaitPermission(root, ctx.host);
    // The hosted dashboard is the link the user gets. The loopback wizard is added
    // only when the dashboard is actually unusable (404/410/5xx/unreachable) or
    // when the probe has not landed yet — a healthy sign-in wall is the intended
    // flow, not an outage, so it does NOT earn a second URL.
    const localFallback = localFallbackSection(root, server.localWizardUrl, process.env, ctx.host);
    const vars = {
      URL: server.dashboardUrl,
      LOCAL_FALLBACK: localFallback,
      WAIT_CMD: waitCommand,
      DECLINE_CMD: declineCmd,
    };
    // OpenCode/Kilo: the full multi-host deny block (URLs + shell commands +
    // JavaScript code blocks + "do NOT…" behavioral overrides) triggers the
    // model's prompt-injection safety training — it reads as a third-party hijack
    // attempt and refuses to follow the instructions. Use a minimal, factual
    // message instead: just the wizard URL and wait command, no behavioral
    // overrides or code blocks. The fallback uses the bare one-line form for the
    // same reason. The restart note is OpenCode-only: the waiter emits
    // TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED exclusively for host === 'opencode',
    // so promising it on Kilo would be false prose.
    if (ctx.host === 'opencode' || ctx.host === 'kilo') {
      const wrapperFallback = localFallbackLine(root, server.localWizardUrl, process.env, ctx.host);
      const restartNote = ctx.host === 'opencode'
        ? 'If it prints TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED, stop and tell the user to restart OpenCode, '
          + 'then type "continue" or "resume" after restart to continue development. Development resumes only after the restarted OpenCode process loads the new settings.\n\n'
        : '';
      return deny(
        'Traffic One project setup is required before building. '
        + `Show this setup link to the user: ${vars.URL}\n\n`
        + (wrapperFallback ? `${wrapperFallback}\n\n` : '')
        + `Then immediately run this wait command in the current turn (timeout ~9 minutes); do not wait for another user message first:\n${vars.WAIT_CMD}\n\n`
        + restartNote
        + `If the user does not want Traffic One for this project, run instead: ${declineCmd}`,
        { denyId: 'onboarding-setup-required-opencode' },
      );
    }
    if (ctx.host === 'windsurf') {
      // Windsurf renders an exit-2 pre-hook as a failed tool card. Never spend
      // that blocking surface on harmless orientation (`ls`, reads, grep): let
      // the agent inspect while the user completes the already-open wizard.
      // The host entry turns the first mutation deny into an inline setup wait,
      // then releases that SAME tool after onboarding completes.
      if (isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
      const first = firstEmitThisSession(root, 'onboarding-deny-tool', hookSessionIdentity(raw).sessionId);
      return first
        ? deny(block('windsurf-server-deny-reason', vars, windsurfSetupReason(vars.URL, localFallback, vars.WAIT_CMD)), { denyId: 'windsurf-server-deny-reason' })
        : deny(block('windsurf-server-deny-reason-repeat', vars, windsurfSetupRepeatReason(vars.URL, localFallback, vars.WAIT_CMD)), { denyId: 'windsurf-server-deny-reason-repeat' });
    }
    // Deliver the FULL preview-pane walkthrough on the first GATED tool of the
    // session — INCLUDING a read-only orientation call. On Codex the PreToolUse
    // DENY REASON is the ONLY output surfaced to the model: PreToolUse
    // additionalContext is rejected outright (openai/codex#19385) and
    // UserPromptSubmit.additionalContext is version-flaky (#16486/#16933). A
    // DEDICATED marker (not the UserPromptSubmit 'onboarding-deny' one) guarantees
    // this fires regardless of whether the prompt hook's context landed — otherwise
    // an orientation-only opening turn leaves the agent hunting for the wizard
    // (observed on Codex). One denied orientation call is the cost; the deny prose
    // itself says orientation is allowed and to open the wizard, so the agent
    // pivots immediately.
    // Claude Code is the exception among these hosts: its prompt-hook context is
    // reliable (the ask-first question already landed through it) and a denied
    // read renders as a red failed-tool card, so orientation flows like on
    // Windsurf and the walkthrough lands on the first mutating call instead.
    if (ctx.host === 'claude' && isReadOnlyOrientationToolUse(toolName, toolInput)) {
      return setupLinkNudge(root, ctx.host, server.dashboardUrl, server.token, localFallback);
    }
    // The user has the wizard open in a browser — the server watched it arrive, so
    // re-posting the link now would read as "start over" while they are mid-setup.
    // This variant is truthful because it is backed by that observation; the old
    // one fired whenever any surface had merely PRODUCED the link, which is how the
    // agent ended up telling the user to use a link it had never posted.
    const wizardIsOpen = wizardOpened(root, server.token, process.env, ctx.host);
    // Copilot renders `systemMessage` on BOTH its wire surfaces INCLUDING a deny
    // (CLI and VS Code), so the wizard banner rides the deny itself — the one
    // guaranteed user-visible moment on that host. Shares the nudge's TTL marker
    // so the two surfaces keep a single cadence, and stands down once a browser
    // demonstrably has the wizard open.
    const copilotDenyBanner = (): { systemMessage: string } | Record<string, never> => {
      if (ctx.host !== 'copilot' || wizardIsOpen || !server.dashboardUrl) return {};
      if (emittedWithin(root, setupLinkNudgeLabel(server.token), SETUP_LINK_NUDGE_TTL_MS)) return {};
      stampEmitMarker(root, setupLinkNudgeLabel(server.token));
      return { systemMessage: formatWizardBanner(ctx.host, server.dashboardUrl, localFallback, 'traffic-one [setup required]') };
    };
    if (firstEmitThisSession(root, 'onboarding-deny-tool', hookSessionIdentity(raw).sessionId)) {
      return deny(wizardIsOpen
        ? block('server-deny-reason-links-shown', vars)
        : block('server-deny-reason', vars), { ...copilotDenyBanner(), denyId: wizardIsOpen ? 'onboarding-server-deny-links-shown' : 'onboarding-server-deny-first' });
    }
    // Recipe already delivered this session → orientation flows; every further
    // non-orientation / mutating attempt repeats only the URL + wait-command. The
    // URL rides EVERY repeat until the wizard is open: the full walkthrough is what
    // must not repeat, not the link itself.
    if (isReadOnlyOrientationToolUse(toolName, toolInput)) {
      return setupLinkNudge(root, ctx.host, server.dashboardUrl, server.token, localFallback);
    }
    return deny(wizardIsOpen
      ? block('server-deny-reason-links-shown', vars)
      : block('server-deny-reason-repeat', vars), { ...copilotDenyBanner(), denyId: wizardIsOpen ? 'onboarding-server-deny-links-shown' : 'onboarding-server-deny-repeat' });
  }

  if (childEvent) return noop();

  // Onboarding is complete → the build is starting. PRE-mint the build run-id for
  // new-project so the orchestrator READS `currentRunId` at Phase 0 instead of
  // fabricating one with `date` — a self-generated ISO/UTC id splits run state into a
  // stray `runs/<id>` tree (assignments/digests the run-team + OpenCode gates can't
  // see). Idempotent (reuses an existing id); the spawn gate would otherwise mint it
  // only on the first spawn, AFTER the orchestrator has already built the prompt.
  const subagentsMode = obj(effectiveState.team)?.mode === 'subagents';
  const buildRunId = (mode === 'new-project' || subagentsMode) ? ensureCurrentRunId(root, effectiveState) : '';
  if (buildRunId && subagentsMode) {
    const policy = ensureRunModelPolicy(
      root,
      buildRunId,
      ctx.host,
      effectiveState,
      { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
    );
    if (!policy) {
      const missingCursorTiers = ctx.host === 'cursor'
        ? cursorRunPolicyMissingTiers(
          root,
          ctx.host,
          effectiveState,
          { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
        )
        : null;
      // This exact hook-owned capture command is the only action that can make
      // an unpublished Cursor policy buildable. Admit it without weakening the
      // gate for sibling projects, fake runners, other hosts, or a corrupt
      // create-once policy that capture cannot repair.
      const captureCanRepair = Boolean(
        missingCursorTiers?.length
        && !fs.existsSync(runModelPolicyPath(root, buildRunId)),
      );
      if (captureCanRepair && isModelCaptureCommand(toolName, toolInput, root)) return noop();
      if (captureCanRepair) {
        return deny(
          `traffic-one — Cursor models required: before run ${buildRunId} can be frozen, capture exact picker ids covering `
          + `${missingCursorTiers?.join(', ')} and run `
          + `\`${modelCaptureCommand(root, 'cursor')}\`. Retry this parent tool afterward. No child may start without the immutable snapshot.`,
          { denyId: 'onboarding-cursor-models-required', denyTarget: buildRunId },
        );
      }
      const frozenPolicy = readRunModelPolicy(root, buildRunId);
      if (frozenPolicy?.host !== undefined && frozenPolicy.host !== ctx.host) {
        return deny(
          `traffic-one — model policy unavailable: run ${buildRunId} is already frozen for ${frozenPolicy.host}, not ${ctx.host}. `
          + 'Start a new parent run for this host; do not rebase or replace model-policy.json.',
          { denyId: 'onboarding-model-policy-host-mismatch', denyTarget: buildRunId },
        );
      }
      if (frozenPolicy) {
        return deny(
          `traffic-one — run bootstrap unavailable: Performance and immutable model policy are already saved for run ${buildRunId}, `
          + 'but the runtime could not publish or validate its capability baseline and parent bootstrap. Do not redo onboarding '
          + 'or replace model-policy.json. Update or repair Traffic One, then retry this parent tool with the same run.',
          { denyId: 'onboarding-run-bootstrap-unavailable', denyTarget: buildRunId },
        );
      }
      return deny(
        'traffic-one — model policy unavailable: the parent could not freeze the acknowledged host/plan model catalog '
        + `for run ${buildRunId}. Reopen Performance if prompted, then retry this parent tool. Do not spawn a child `
        + 'and do not let a child create or replace model-policy.json.',
        { denyId: 'onboarding-model-policy-freeze-failed', denyTarget: buildRunId },
      );
    }
    if (policy.host !== ctx.host) {
      return deny(
        `traffic-one — model policy unavailable: run ${buildRunId} is already frozen for ${policy.host}, not ${ctx.host}. `
        + 'Start a new parent run for this host; do not rebase or replace model-policy.json.',
        { denyId: 'onboarding-model-policy-host-mismatch', denyTarget: buildRunId },
      );
    }
  }

  const materialized = materializeProjectIfNeeded(root, { trigger: 'generic pre-tool convergence' });
  if (materialized) {
    if (isMutatingPreToolUse(toolName, toolInput)) return deny(block('repaired-materialization'), { denyId: 'repaired-materialization' });
    return context(materialized.context, { systemMessage: materialized.systemMessage });
  }
  // Headless sessions never fire UserPromptSubmit, so the prompt-boundary
  // maintenance triage directive is never delivered there. An unburned
  // 'maintenance-triage' once-marker at the first MUTATING/SPAWN gated call is
  // that signature (an interactive edit prompt would have burned it before any
  // tool ran) — emit the rubric here instead. Guidance only: rotation stays at
  // the prompt boundary and the pre-mint above owns the run id.
  const triageFallback = (isMutatingPreToolUse(toolName, toolInput) || ctx.input.tool?.class === 'spawn-agent')
    ? maintenanceTriageFallbackDirective(
      root,
      buildRunId ? { ...effectiveState, currentRunId: buildRunId } : effectiveState,
      raw,
      ctx.host,
    )
    : '';
  // Announce the run-id ONCE, before the first spawn prompt is built, so the literal
  // value is salient (where the host surfaces PreToolUse context). The plan gate's
  // run-id write-guard enforces it regardless of whether this context lands.
  if (buildRunId && firstEmitThisSession(root, 'run-id-announce', hookSessionIdentity(raw).sessionId)) {
    const orchestration = buildOrchestrationDirective(root, ctx.host, effectiveState);
    const runIdLines = [
      `traffic-one — build run-id: ${buildRunId}. This is \`currentRunId\` in .traffic-one/.one.json.`,
      `Use this EXACT value wherever a run-id is needed — \`.traffic-one/runs/${buildRunId}/\` and`,
      `\`.traffic-one/digests/${buildRunId}/\` paths, and "Run ID:" lines in spawn prompts. Do NOT run`,
      '`date` to mint one; the plan gate denies writing under any other run-id.',
    ].join(' ');
    return context([runIdLines, orchestration, triageFallback].filter(Boolean).join('\n\n'));
  }
  if (triageFallback) return context(triageFallback);
  return noop();
}
