// src/shared/onboarding/repair.ts
// Auto-repair of a new-project onboarding state that is complete-but-noncanonical
// (e.g. needs a normalize pass): if every required field is present and valid
// after normalization, rewrite the canonical state and materialize. Ported 1:1
// from canRepairNewProjectOnboardingState / repairNewProjectOnboardingState
// (_helpers.cjs).

import { isKnownStack } from '../config';
import { detectMode } from '../detection';
import { type MaterializeOutcome, materializeProjectFromState } from '../materialize';
import { teamModeForLevel } from '../performance';
import {
  BACKEND_IDS,
  FRONTEND_IDS,
  hasResolvedNewProjectMobileState,
  hasValidPerformanceState,
  hasValidProjectContext,
  hasValidTeamState,
  isTeamApproved,
  normalizeState,
  writeState,
} from '../state';
import { isNewProjectOnboardingIncomplete } from './predicates';

type Rec = Record<string, unknown>;

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

// True when `state` is an onboarding-complete new project that only needs a
// normalize pass to become canonical (so the gate can repair instead of deny).
export function canRepairNewProjectOnboardingState(state: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  if (s.onboardingComplete !== true) return false;
  if (s.confirmed === false) return false;
  const candidate = JSON.parse(JSON.stringify(s)) as Rec;
  normalizeState(candidate, (candidate.mode as string) || 'new-project');
  if (candidate.mode !== 'new-project') return false;
  if (typeof candidate.stack !== 'string' || !isKnownStack(candidate.stack)) return false;
  if (typeof candidate.frontend !== 'string' || !FRONTEND_IDS.has(candidate.frontend)) return false;
  if (typeof candidate.backend !== 'string' || !BACKEND_IDS.has(candidate.backend)) return false;
  if (!hasValidProjectContext(candidate.projectContext)) return false;
  if (candidate.mobile === undefined || candidate.mobile === null) return false;
  if (!hasResolvedNewProjectMobileState(candidate.mobile)) return false;
  if (!hasValidTeamState(candidate.team)) return false;
  if (!hasValidPerformanceState(candidate.performance)) return false;
  const team = obj(candidate.team);
  const performance = obj(candidate.performance);
  if (!team || !performance) return false;
  const expectedTeamMode = teamModeForLevel(String(performance.level));
  if (team.mode !== expectedTeamMode) return false;
  if (expectedTeamMode === 'subagents' && !isTeamApproved(candidate.team)) return false;
  if (candidate.codeGraphProvider !== 'gitnexus' && candidate.codeGraphProvider !== 'graphify') return false;

  normalizeState(candidate, (candidate.mode as string) || 'new-project');
  return !isNewProjectOnboardingIncomplete(candidate);
}

// Repair + materialize, or null when the state cannot be auto-repaired (the gate
// then falls through to the onboarding prompt).
export function repairNewProjectOnboardingState(cwd: string, state: unknown, trigger: string): MaterializeOutcome | null {
  if (!canRepairNewProjectOnboardingState(state)) return null;
  try {
    const repaired = JSON.parse(JSON.stringify(state)) as Rec;
    normalizeState(repaired, (repaired.mode as string) || detectMode(cwd));
    writeState(cwd, repaired);
    return materializeProjectFromState(cwd, { trigger });
  } catch (error) {
    const detail = error && (error as Error).message ? (error as Error).message : String(error || 'unknown error');
    return {
      status: 'failed',
      systemMessage: 'traffic-one — project-local materialization failed',
      context: `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
      result: null,
    };
  }
}
