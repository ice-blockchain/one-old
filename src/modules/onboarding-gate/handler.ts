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
import { resolveProjectRoot } from '../../shared/hook-paths';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import { ensureOnboardingServer } from '../../shared/onboarding-server/ensure';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { onboardingWaitCommand } from '../../shared/onboarding-server/wait-command';
import { teamModeDowngradeViolation, teamModeMarkerWriteViolation } from '../../shared/onboarding/team-mode-approval';
import { pluginRoot } from '../../shared/paths';
import { firstEmitThisSession } from '../../shared/once';
import { makeSkillBlock } from '../../shared/skill-block';
import { hookSessionIdentity, normalizeState, readEffectiveState } from '../../shared/state';
import { isMutatingPreToolUse, isOnboardingWaitCommand, isReadOnlyOrientationToolUse, isStateFileOnlyPatch, isStateFilePath } from '../../shared/tool-classify';
import { authChoiceAllowsContinue } from '../session/auth-choice';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (name: string, vars: Record<string, string | number | null | undefined> = {}): string =>
  skillBlock('onboarding-gate', name, vars);

export function onboardingGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const cwd = ctx.cwd;

  if (isPluginAuthoringRoot(cwd)) return noop();

  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
  // Monorepo safety: a scaffolder may run from a sub-package cwd or target a
  // sub-package file. Resolve UP to the workspace root that holds onboarding state,
  // so a stray per-package state file can't trip a bogus per-package wizard or hide
  // that the root is already onboarded. Falls back to cwd for a standalone project.
  const root = resolveProjectRoot(cwd, filePath);

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
    // Read-only orientation (pwd, ls, Read, Glob, Grep) is allowed so the agent
    // can find its bearings while the user completes the wizard.
    if (isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
    // The blocking "wait for setup" command is allowed so the agent can keep its
    // turn open until the wizard finishes, then continue the build automatically.
    if (isOnboardingWaitCommand(toolName, toolInput)) return noop();
    const server = ensureOnboardingServer(root);
    // The full preview-pane walkthrough (~2.3 KB) injects once per session; every
    // further denied attempt repeats only the URL + wait-command essentials.
    const denyBlock = firstEmitThisSession(root, 'onboarding-deny', hookSessionIdentity(raw).sessionId)
      ? 'server-deny-reason'
      : 'server-deny-reason-repeat';
    return deny(block(denyBlock, { URL: server.url, WAIT_CMD: onboardingWaitCommand(root) }));
  }

  const materialized = materializeProjectIfNeeded(root, { trigger: 'generic pre-tool convergence' });
  if (materialized) {
    if (isMutatingPreToolUse(toolName, toolInput)) return deny(block('repaired-materialization'));
    return context(materialized.context, { systemMessage: materialized.systemMessage });
  }
  return noop();
}
