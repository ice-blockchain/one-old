// src/modules/onboarding-gate/handler.ts
// PreToolUse onboarding gate (priority 10): on a new project, block mutating
// tools until onboarding is complete, surfacing the next unresolved prompt;
// repair-and-converge when onboarding is actually done. Ported 1:1 from
// runCheckOnboardingGate (gates.cjs:80). Auth is enforced by the priority-0
// session gate before this runs. Deny PROSE comes from the onboarding-gate
// skill via the shared/onboarding assemblers.

import { context, deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { detectMode } from '../../shared/detection';
import { materializeProjectIfNeeded } from '../../shared/materialize';
import {
  nextOnboardingPromptRequest,
  onboardingGateFallbackReason,
  type OnboardingBlock,
  repairedMaterializationDenyReason,
  teamConfirmationGateFallbackReason,
} from '../../shared/onboarding/fallbacks';
import { isNewProjectOnboardingIncomplete, needsTeamConfirmation } from '../../shared/onboarding/predicates';
import { onboardingPromptRequestForStep, performanceLevelOf } from '../../shared/onboarding/prompts';
import { repairNewProjectOnboardingState } from '../../shared/onboarding/repair';
import { teamModeDowngradeViolation, teamModeMarkerWriteViolation } from '../../shared/onboarding/team-mode-approval';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { normalizeState, readEffectiveState } from '../../shared/state';
import { isMutatingPreToolUse, isReadOnlyOrientationToolUse, isStateFileOnlyPatch, isStateFilePath } from '../../shared/tool-classify';
import { authChoiceAllowsContinue } from '../session/auth-choice';

type Rec = Record<string, unknown>;

const skillBlock = makeSkillBlock(pluginRoot);
const block: OnboardingBlock = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);

const MARKER_GUARD_FALLBACK = 'Traffic One team mode guard: `team.modeChangeApproval` is an internal, single-use marker that can only be written by the UserPromptSubmit hook after an explicit user request. Do not add or refresh it in `.traffic-one/.one.json` manually.';
const DOWNGRADE_GUARD_FALLBACK = 'Traffic One team mode guard: local Traffic One preferences currently record `team.mode="subagents"`. This write would switch the project to `team.mode="main-agent"`, but the latest user prompt did not explicitly say they no longer want subagents and want Low/main-agent mode. Ask the user to say that explicitly before rewriting local `performance.level="low"` and `team.mode="main-agent"`. Do not use `team.source="unavailable"` or a state rewrite as a workaround.';

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function onboardingGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const cwd = ctx.cwd;

  if (isPluginAuthoringRoot(cwd)) return noop();
  if (authChoiceAllowsContinue(cwd)) return noop();
  // Auth is enforced by the priority-0 session gate before this gate runs.

  const filePath = asString(toolInput.file_path);
  const state = readEffectiveState(cwd);
  const mode = (state.mode as string) || detectMode(cwd);
  const effectiveState: Rec = { ...state, mode };
  normalizeState(effectiveState, mode);

  if (teamModeMarkerWriteViolation(cwd, toolName, toolInput)) {
    return deny(block('team-mode-marker-guard', {}, MARKER_GUARD_FALLBACK));
  }
  if (teamModeDowngradeViolation(cwd, toolName, toolInput, effectiveState)) {
    return deny(block('team-mode-downgrade-guard', {}, DOWNGRADE_GUARD_FALLBACK));
  }

  // The model is allowed to write the canonical state file itself.
  if (isStateFilePath(filePath) || isStateFileOnlyPatch(toolName, toolInput)) return noop();

  if (mode === 'new-project' && isNewProjectOnboardingIncomplete(effectiveState)) {
    const repaired = repairNewProjectOnboardingState(cwd, effectiveState, 'generic pre-tool onboarding repair');
    if (repaired) {
      if (isMutatingPreToolUse(toolName, toolInput)) return deny(repairedMaterializationDenyReason(block));
      return context(repaired.context, { systemMessage: repaired.systemMessage });
    }
    // Read-only orientation (pwd, ls, Read, Glob, Grep) is allowed so the agent
    // can locate cwd and write the state file to the right place.
    if (isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
    if (needsTeamConfirmation(effectiveState)) {
      const reason = teamConfirmationGateFallbackReason(effectiveState, block);
      const promptRequest = onboardingPromptRequestForStep('team-confirmation', {
        level: performanceLevelOf(effectiveState), fallbackText: reason,
      });
      return deny(reason, { promptRequest });
    }
    const reason = onboardingGateFallbackReason(effectiveState, block);
    const promptRequest = nextOnboardingPromptRequest(effectiveState, 'gate', block);
    return deny(reason, { promptRequest });
  }

  const materialized = materializeProjectIfNeeded(cwd, { trigger: 'generic pre-tool convergence' });
  if (materialized) {
    if (isMutatingPreToolUse(toolName, toolInput)) return deny(repairedMaterializationDenyReason(block));
    return context(materialized.context, { systemMessage: materialized.systemMessage });
  }
  return noop();
}
