// src/shared/onboarding/local-prefs.ts
// Per-user Traffic One preference STEP router for both existing projects and
// already-configured new projects. Shared state may be present in the repo, but
// each user still needs local choices for OpenCode, performance/team, and the
// code graph provider before mutating work proceeds. The wizard server consumes
// nextLocalPreferenceStep; the prose/popup assemblers were removed when onboarding
// moved into the local wizard (shared/onboarding-server).

import { obj } from '../obj';
import { detectHostPlan } from '../host-plan';
import { canonicalHost, hostModelSnapshot } from '../model-tiers';
import { readOneHostSettings } from '../one-settings';
import { teamModeForLevel } from '../performance';
import {
  hasResolvedOpenCodeState,
  hasValidPerformanceState,
  hasValidTeamState,
  isTeamApproved,
} from '../state';
import type { OnboardingStep } from './prompts';

export type LocalPreferenceStep = Extract<OnboardingStep, 'open-code' | 'performance' | 'team-confirmation' | 'code-graph'>;

export interface LocalPreferenceTarget {
  plan: string;
  modelsUpdatedAt: string;
}

export function currentLocalPreferenceTarget(
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
): LocalPreferenceTarget {
  const activeHost = canonicalHost(host);
  const plan = detectHostPlan(activeHost, env);
  const storedCatalog = readOneHostSettings(activeHost, env);
  return {
    plan,
    // The one.json snapshot is the API-refreshed source. A brand-new/offline
    // install or an offline plan transition falls back to the bundled target-plan
    // date so configuredFor never combines one plan with another plan's catalog.
    modelsUpdatedAt: storedCatalog?.plan === plan
      ? storedCatalog.updatedAt
      : hostModelSnapshot(activeHost, plan).updatedAt,
  };
}

function configuredForMatches(value: unknown, target: LocalPreferenceTarget): boolean {
  const configured = obj(value);
  return configured?.plan === target.plan
    && configured.modelsUpdatedAt === target.modelsUpdatedAt;
}

export function nextLocalPreferenceStep(
  state: unknown,
  host?: unknown,
  target: LocalPreferenceTarget | null | undefined = undefined,
): LocalPreferenceStep | null {
  const s = obj(state);
  if (!s || !s.stack) return null;
  const activeHost = canonicalHost(host);
  if (activeHost !== 'opencode' && activeHost !== 'kilo' && !hasResolvedOpenCodeState(s.openCode)) return 'open-code';
  if (!hasValidPerformanceState(s.performance)) return 'performance';
  const current = target === undefined ? currentLocalPreferenceTarget(activeHost) : target;
  if (current && !configuredForMatches(s.configuredFor, current)) return 'performance';

  const performance = obj(s.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  const expectedTeamMode = teamModeForLevel(level);
  const team = obj(s.team);
  if (!hasValidTeamState(s.team)) {
    return expectedTeamMode === 'subagents' ? 'team-confirmation' : 'performance';
  }
  if (team && team.mode !== expectedTeamMode) return 'performance';
  if (expectedTeamMode === 'subagents' && !isTeamApproved(s.team)) return 'team-confirmation';

  if (s.codeGraphProvider !== 'gitnexus' && s.codeGraphProvider !== 'graphify') return 'code-graph';
  return null;
}
