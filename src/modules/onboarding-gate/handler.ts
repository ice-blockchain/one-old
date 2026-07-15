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

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { detectMode } from '../../shared/detection';
import { isOnboardedProjectRoot, resolveProjectRoot } from '../../shared/hook-paths';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { buildOrchestrationDirective } from '../../shared/build-orchestration-directive';
import { prepareOnboardingServer } from '../../shared/onboarding-server/bootstrap';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import { windsurfSetupReason, windsurfSetupRepeatReason } from '../../shared/onboarding-server/windsurf-setup';
import { teamModeDowngradeViolation, teamModeMarkerWriteViolation } from '../../shared/onboarding/team-mode-approval';
import { pluginRoot } from '../../shared/paths';
import { firstEmitThisSession, stampEmitMarker } from '../../shared/once';
import { makeSkillBlock } from '../../shared/skill-block';
import { ensureCurrentRunId, hookSessionIdentity, isSubagentThread, normalizeState, readEffectiveState } from '../../shared/state';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';
import { canonicalToolName, isMutatingPreToolUse, isOnboardingBootstrapCommand, isOnboardingWaitCommand, isReadOnlyOrientationToolUse, isStateFileOnlyPatch, isStateFilePath, parsedToolInput } from '../../shared/tool-classify';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { usePluginQuestionPending } from '../../shared/onboarding-server/flow';
import { onboardingDeclineCommand, usePluginQuestion } from '../../shared/onboarding-server/wait-command';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}, fallback = ''): string =>
  skillBlock('onboarding-gate', name, vars, fallback);

export function onboardingGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  // Use the adapter-parsed (host-agnostic) tool for classification. Cursor's
  // rawName is a coarse subcommand (before-shell-execution …) the classifiers
  // don't recognize, and its command/path live on the parsed tool, NOT
  // raw.tool_input — so deriving from raw alone made every command/file allow-check
  // (the onboarding wait command, read-only orientation) silently fail on Cursor.
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  const cwd = ctx.cwd;

  if (isNonProjectRoot(cwd)) return noop();

  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
  // Monorepo safety: a scaffolder may run from a sub-package cwd or target a
  // sub-package file. Resolve UP to the workspace root that holds onboarding state,
  // so a stray per-package state file can't trip a bogus per-package wizard or hide
  // that the root is already onboarded. Falls back to cwd for a standalone project.
  const root = resolveProjectRoot(cwd, filePath, { ceiling: ctx.input.workspaceRoot });
  // The resolver skips authoring roots, but its fallback can still return cwd /
  // a hint dir inside the plugin repo — never gate or materialize there.
  if (isNonProjectRoot(root)) return noop();
  initializeTrafficOneEnv(root, ctx.host);

  if (authChoiceAllowsContinue(root) || pluginUseDeclined(root)) return noop();
  // Auth is enforced HERE now (the separate priority-0 auth PreToolUse gate is
  // retired): computeOnboarding below returns the 'api-key' step while the web
  // API key is unentered, so this gate opens the wizard on that page and blocks
  // mutating tools until the key is entered.

  const state = readEffectiveState(root);
  const mode = (state.mode as string) || detectMode(root);
  const effectiveState: Rec = { ...state, mode };
  normalizeState(effectiveState, mode);

  // Team-mode write guards stay active — these are post-onboarding runtime
  // guardrails, not onboarding questions.
  if (teamModeMarkerWriteViolation(root, toolName, toolInput)) {
    return deny(block('team-mode-marker-guard'));
  }
  if (teamModeDowngradeViolation(root, toolName, toolInput, effectiveState)) {
    return deny(block('team-mode-downgrade-guard'));
  }

  // The model is allowed to write the canonical state file itself.
  if (isStateFilePath(filePath) || isStateFileOnlyPatch(toolName, toolInput)) return noop();

  if (!computeOnboarding(root).done) {
    // A SUBAGENT must never be sent to the setup wizard. Onboarding is the parent/
    // main-agent's job, completed BEFORE any subagent spawns, and a worker thread
    // cannot make the in-app browser visible to show the wizard — so a deny here
    // just traps it looping on the wait command. Reaching this branch in a subagent
    // means a stray nested root was resolved (e.g. a leaked packages/*/.traffic-one);
    // let the worker proceed with its assigned task (often REMOVING that leak).
    if (isSubagentThread(raw)) return noop();
    // Cursor fallback: a subagent's OWN events carry no reliable subagent marker, so
    // isSubagentThread can't catch them, and an onboarding-incomplete subagent here would loop on
    // the wait command. The orchestrator's session is recorded as MAIN at subagentStart; a session
    // that is NOT a known main session is a subagent → let it proceed (don't trap it on the wizard).
    if (ctx.host === 'cursor') {
      const id = hookSessionIdentity(raw);
      const workspaceRoot = asString(ctx.input.workspaceRoot);
      const sessionRoot = isOnboardedProjectRoot(root)
        ? root
        : (workspaceRoot && isOnboardedProjectRoot(workspaceRoot) ? workspaceRoot : root);
      if (id.sessionId && isForeignOnboardingThread(sessionRoot, id.sessionId)) return noop();
    }
    // Cursor does not reliably render UserPromptSubmit user_message, and agents sometimes skip
    // reposting the URL before running the wait command. Force one visible, clickable link at the
    // shell boundary, then allow the retry so setup can block normally.
    // The approved bootstrap is the only way a sandboxed hook can start an
    // unsandboxed wizard that owns ~/.traffic-one/projects. Admit it before the
    // Cursor URL-repost path, which necessarily calls the same failing launcher.
    if (isOnboardingBootstrapCommand(toolName, toolInput)) return noop();
    if (isOnboardingWaitCommand(toolName, toolInput)) {
      // Ask-first pending: the runner invocation IS the answer path (--use /
      // --decline) — let it run without pre-launching the wizard or reposting
      // a URL the user has not said yes to.
      if (usePluginQuestionPending(root)) return noop();
      if (ctx.host === 'cursor') {
        const prepared = prepareOnboardingServer(root, ctx.host);
        // The wait command is the recovery path when the hook sandbox itself
        // cannot launch the wizard. Never deny that recovery command merely
        // because the same restricted hook cannot pre-create its URL.
        if (prepared.kind !== 'ready') return noop();
        const { server, waitCommand } = prepared;
        const id = hookSessionIdentity(raw).sessionId;
        if (server.dashboardUrl
          && firstEmitThisSession(root, 'cursor-onboarding-wait-link', id)) {
          stampEmitMarker(root, 'wizard-url-shown');
          return deny(block('cursor-wait-link-first', {
            URL: server.dashboardUrl,
            WAIT_CMD: waitCommand,
          }));
        }
      }
      return noop();
    }
    // Ask-first: the user has not said whether this project uses Traffic One.
    // Deny mutating work with the HOST-CHAT question — no wizard server, no
    // setup URL, until the user answers (yes → --use runs the normal wait).
    if (usePluginQuestionPending(root)) {
      return deny(usePluginQuestion(root, ctx.host));
    }
    const declineCmd = onboardingDeclineCommand(root, ctx.host);
    const prepared = prepareOnboardingServer(root, ctx.host);
    if (prepared.kind !== 'ready') {
      // Windsurf renders a denied read as a failed tool card. Its prompt hook
      // already carries this bootstrap recipe, so preserve harmless orientation
      // and repeat the actionable block on the first mutation. Other hosts need
      // the first tool denial because that is their most reliable visible channel.
      if (ctx.host === 'windsurf' && isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
      return deny(prepared.reason);
    }
    const { server, waitCommand } = prepared;
    const vars = { URL: server.dashboardUrl, WAIT_CMD: waitCommand, DECLINE_CMD: declineCmd };
    // OpenCode: the full multi-host deny block (URLs + shell commands + JavaScript
    // code blocks + "do NOT…" behavioral overrides) triggers the model's prompt-
    // injection safety training — it reads as a third-party hijack attempt and
    // refuses to follow the instructions. Use a minimal, factual message instead:
    // just the wizard URL and wait command, no behavioral overrides or code blocks.
    if (ctx.host === 'opencode') {
      return deny(
        `Traffic One project setup is required before building. `
        + `Show this setup link to the user: ${vars.URL}\n\n`
        + `Then immediately run this wait command in the current turn (timeout ~9 minutes); do not wait for another user message first:\n${vars.WAIT_CMD}\n\n`
        + `If it prints TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED, stop and tell the user to restart OpenCode, `
        + `then type "continue" or "resume" after restart to continue development. Development resumes only after the restarted OpenCode process loads the new settings.\n\n`
        + `If the user does not want Traffic One for this project, run instead: ${declineCmd}`,
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
      if (first) return deny(block('windsurf-server-deny-reason', vars, windsurfSetupReason(vars.URL, vars.WAIT_CMD)));
      return deny(block('windsurf-server-deny-reason-repeat', vars, windsurfSetupRepeatReason(vars.URL, vars.WAIT_CMD)));
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
    if (firstEmitThisSession(root, 'onboarding-deny-tool', hookSessionIdentity(raw).sessionId)) {
      stampEmitMarker(root, 'wizard-url-shown');
      return deny(block('server-deny-reason', vars));
    }
    // Recipe already delivered this session → orientation flows; every further
    // non-orientation / mutating attempt repeats only the URL + wait-command.
    if (isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
    return deny(block('server-deny-reason-repeat', vars));
  }

  // Onboarding is complete → the build is starting. PRE-mint the build run-id for
  // new-project so the orchestrator READS `currentRunId` at Phase 0 instead of
  // fabricating one with `date` — a self-generated ISO/UTC id splits run state into a
  // stray `runs/<id>` tree (assignments/digests the run-team + OpenCode gates can't
  // see). Idempotent (reuses an existing id); the spawn gate would otherwise mint it
  // only on the first spawn, AFTER the orchestrator has already built the prompt.
  const buildRunId = mode === 'new-project' ? ensureCurrentRunId(root, effectiveState) : '';

  const materialized = materializeProjectIfNeeded(root, { trigger: 'generic pre-tool convergence' });
  if (materialized) {
    if (isMutatingPreToolUse(toolName, toolInput)) return deny(block('repaired-materialization'));
    return context(materialized.context, { systemMessage: materialized.systemMessage });
  }
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
    return context(orchestration ? `${runIdLines}\n\n${orchestration}` : runIdLines);
  }
  return noop();
}
