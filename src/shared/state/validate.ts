// src/shared/state/validate.ts
// Validators for onboarding-critical state sub-objects. Ported 1:1 from
// scripts/hook-runtime/state/validate.cjs.

import {
  OPEN_CODE_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
} from './constants';

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function inSet(set: Set<string>, value: unknown): boolean {
  return typeof value === 'string' && set.has(value);
}

export function hasValidPerformanceState(performance: unknown): boolean {
  const p = asObject(performance);
  return Boolean(p && inSet(PERFORMANCE_LEVEL_IDS, p.level) && inSet(PERFORMANCE_SOURCE_IDS, p.source));
}

// "Resolved" once the user answered either way: strict-boolean `enabled` + a
// known `source`. "Not now" resolves with enabled:false.
export function hasResolvedOpenCodeState(openCode: unknown): boolean {
  const o = openCode && typeof openCode === 'object' && !Array.isArray(openCode)
    ? (openCode as Record<string, unknown>)
    : null;
  return Boolean(o && typeof o.enabled === 'boolean' && inSet(OPEN_CODE_SOURCE_IDS, o.source));
}

export function hasValidTeamState(team: unknown): boolean {
  const t = asObject(team);
  return Boolean(t && inSet(TEAM_MODE_IDS, t.mode) && inSet(TEAM_SOURCE_IDS, t.source));
}

export function hasValidProjectContext(projectContext: unknown): boolean {
  const c = projectContext && typeof projectContext === 'object' && !Array.isArray(projectContext)
    ? (projectContext as Record<string, unknown>)
    : null;
  if (!c) return false;
  const answers = c.answers;
  return Boolean(
    typeof c.source === 'string' && c.source.trim() !== ''
    && typeof c.originalPrompt === 'string'
    && typeof c.summary === 'string' && c.summary.trim() !== ''
    && answers && typeof answers === 'object' && !Array.isArray(answers)
    && typeof c.collectedAt === 'string' && c.collectedAt.trim() !== '',
  );
}

// team.approved === true means the user explicitly Approved the line-up — the
// spawn gate enforces this so the model can't bypass confirmation.
export function isTeamApproved(team: unknown): boolean {
  const t = asObject(team);
  return Boolean(t && t.approved === true);
}
