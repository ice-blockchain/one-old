// src/shared/onboarding/predicates.ts
// Pure new-project onboarding predicates (no prose, no IO). The onboarding gate
// + SessionStart flow read these to decide whether onboarding is resolved and
// whether Team Confirmation is still pending. Ported 1:1 from _helpers.cjs
// (isNewProjectOnboardingIncomplete:969, needsTeamConfirmation:1420).

import { obj, type Rec } from '../obj';
import { isKnownStack } from '../config';
import { teamModeForLevel } from '../performance';
import {
  BACKEND_IDS,
  FRONTEND_IDS,
  hasInitializedToolchain,
  hasResolvedNewProjectMobileState,
  hasResolvedOpenCodeState,
  hasTechnologyArrays,
  hasValidPerformanceState,
  hasValidProjectContext,
  hasValidTeamState,
  isTeamApproved,
} from '../state';

// True when mode==="new-project" and any required shared-state or local-pref
// onboarding field is still missing/invalid (blocks scaffolding/tool use).
export function isNewProjectOnboardingIncomplete(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  if (s.mode !== 'new-project') return false;

  const performance = obj(s.performance);
  const team = obj(s.team);

  const hasValidStack = typeof s.stack === 'string' && isKnownStack(s.stack);
  const hasOpenCode = hasResolvedOpenCodeState(s.openCode);
  const hasGraphProvider = s.codeGraphProvider === 'gitnexus' || s.codeGraphProvider === 'graphify';
  const hasFrontend = typeof s.frontend === 'string' && FRONTEND_IDS.has(s.frontend);
  const hasBackend = typeof s.backend === 'string' && BACKEND_IDS.has(s.backend);
  const hasTeam = hasValidTeamState(s.team);
  const hasPerformance = hasValidPerformanceState(s.performance);
  const hasProjectContext = hasValidProjectContext(s.projectContext);
  const expectedTeamMode = performance ? teamModeForLevel(String(performance.level)) : null;
  const teamMatchesPerformance = hasTeam && hasPerformance && Boolean(team) && team!.mode === expectedTeamMode;
  const hasRequiredTeamApproval = hasTeam && hasPerformance
    && (expectedTeamMode !== 'subagents' || isTeamApproved(s.team));

  return !hasValidStack
    || !hasOpenCode
    || !hasFrontend
    || !hasBackend
    || !hasProjectContext
    || !hasResolvedNewProjectMobileState(s.mobile)
    || !hasTechnologyArrays(s.technologies)
    || !hasGraphProvider
    || !hasTeam
    || !hasPerformance
    || !teamMatchesPerformance
    || !hasRequiredTeamApproval
    || !hasInitializedToolchain(s.toolchain)
    || s.confirmed !== true
    || s.onboardingComplete !== true
    || typeof s.confirmedAt !== 'string'
    || s.confirmedAt.trim() === '';
}

// True when a Balanced/High new project still needs the user to approve the
// subagent role/model line-up (team.mode="subagents" but team.approved !== true).
export function needsTeamConfirmation(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  if (s.mode !== 'new-project') return false;
  if (!hasValidPerformanceState(s.performance)) return false;
  if (!hasValidTeamState(s.team)) return false;
  const performance = obj(s.performance);
  const team = obj(s.team);
  if (!performance || !team) return false;
  if (teamModeForLevel(String(performance.level)) !== 'subagents') return false;
  if (team.mode !== 'subagents') return false;
  return !isTeamApproved(s.team);
}
