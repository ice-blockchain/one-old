// src/modules/onboarding-gate/handler.ts
// PreToolUse onboarding gate (priority 10): on a new project, block mutating
// tools until onboarding is complete, surfacing the next unresolved prompt;
// repair-and-converge when onboarding is actually done. Ported 1:1 from
// runCheckOnboardingGate (gates.cjs:80). Auth is enforced by the priority-0
// session gate before this runs. Deny PROSE comes from the onboarding-gate
// skill via the shared/onboarding assemblers.

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
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
import { localPreferenceContext } from '../../shared/onboarding/local-prefs';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { normalizeState, readEffectiveState } from '../../shared/state';
import { isMutatingPreToolUse, isReadOnlyOrientationToolUse, isStateFileOnlyPatch, isStateFilePath } from '../../shared/tool-classify';
import { authChoiceAllowsContinue } from '../session/auth-choice';

const skillBlock = makeSkillBlock(pluginRoot);
const block: OnboardingBlock = (name, vars) => skillBlock('onboarding-gate', name, vars);

export function onboardingGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const cwd = ctx.cwd;

  if (isPluginAuthoringRoot(cwd)) return noop();
  if (authChoiceAllowsContinue(cwd)) return noop();
  // Auth is enforced by the priority-0 session gate before this gate runs.

  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path ?? toolInput.filePath ?? toolInput.path);
  const state = readEffectiveState(cwd);
  const mode = (state.mode as string) || detectMode(cwd);
  const effectiveState: Rec = { ...state, mode };
  normalizeState(effectiveState, mode);

  if (teamModeMarkerWriteViolation(cwd, toolName, toolInput)) {
    return deny(block('team-mode-marker-guard', {}));
  }
  if (teamModeDowngradeViolation(cwd, toolName, toolInput, effectiveState)) {
    return deny(block('team-mode-downgrade-guard', {}));
  }

  // The model is allowed to write the canonical state file itself.
  if (isStateFilePath(filePath) || isStateFileOnlyPatch(toolName, toolInput)) return noop();

  const localPrefs = localPreferenceContext(effectiveState, String(effectiveState.stack || mode), 'gate', block);
  if (localPrefs) {
    if (isReadOnlyOrientationToolUse(toolName, toolInput)) return noop();
    return deny(localPrefs.context, {
      ...(localPrefs.promptRequest ? { promptRequest: localPrefs.promptRequest } : {}),
    });
  }

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
