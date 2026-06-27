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
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { detectMode } from '../../shared/detection';
import { isOnboardedProjectRoot, resolveProjectRoot } from '../../shared/hook-paths';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { ensureOnboardingServer } from '../../shared/onboarding-server/ensure';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { isForeignOnboardingThread } from '../../shared/onboarding-server/onboarding-session';
import { onboardingWaitCommand } from '../../shared/onboarding-server/wait-command';
import { teamModeDowngradeViolation, teamModeMarkerWriteViolation } from '../../shared/onboarding/team-mode-approval';
import { pluginRoot } from '../../shared/paths';
import { firstEmitThisSession } from '../../shared/once';
import { makeSkillBlock } from '../../shared/skill-block';
import { ensureCurrentRunId, hookSessionIdentity, isSubagentThread, normalizeState, readEffectiveState } from '../../shared/state';
import { canonicalToolName, isMutatingPreToolUse, isOnboardingWaitCommand, isReadOnlyOrientationToolUse, isStateFileOnlyPatch, isStateFilePath, parsedToolInput } from '../../shared/tool-classify';
import { authChoiceAllowsContinue } from '../session/auth-choice';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);

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

  if (isPluginAuthoringRoot(cwd)) return noop();

  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
  // Monorepo safety: a scaffolder may run from a sub-package cwd or target a
  // sub-package file. Resolve UP to the workspace root that holds onboarding state,
  // so a stray per-package state file can't trip a bogus per-package wizard or hide
  // that the root is already onboarded. Falls back to cwd for a standalone project.
  const root = resolveProjectRoot(cwd, filePath, { ceiling: ctx.input.workspaceRoot });
  // The resolver skips authoring roots, but its fallback can still return cwd /
  // a hint dir inside the plugin repo — never gate or materialize there.
  if (isPluginAuthoringRoot(root)) return noop();

  if (authChoiceAllowsContinue(root)) return noop();
  // Auth is enforced by the priority-0 session gate before this gate runs.

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
    if (isOnboardingWaitCommand(toolName, toolInput)) {
      if (ctx.host === 'cursor') {
        const server = ensureOnboardingServer(root, { host: ctx.host });
        const id = hookSessionIdentity(raw).sessionId;
        if (server.url && !server.url.includes(':0/')
          && firstEmitThisSession(root, 'cursor-onboarding-wait-link', id)) {
          return deny(block('cursor-wait-link-first', {
            URL: server.url,
            WAIT_CMD: onboardingWaitCommand(root, ctx.host),
          }));
        }
      }
      return noop();
    }
    const server = ensureOnboardingServer(root, { host: ctx.host });
    const vars = { URL: server.url, WAIT_CMD: onboardingWaitCommand(root, ctx.host) };
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
    return context(
      `traffic-one — build run-id: ${buildRunId}. This is \`currentRunId\` in .traffic-one/.one.json. `
      + `Use this EXACT value wherever a run-id is needed — \`.traffic-one/runs/${buildRunId}/\` and `
      + `\`.traffic-one/digests/${buildRunId}/\` paths, and "Run ID:" lines in spawn prompts. Do NOT run `
      + '`date` to mint one; the plan gate denies writing under any other run-id.',
    );
  }
  return noop();
}
