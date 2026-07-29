// src/shared/state/validate.ts
// Validators for onboarding-critical state sub-objects. Ported 1:1 from
// scripts/hook-runtime/state/validate.cjs.

import { STACK_IDS } from '../../config/stacks';
import { teamModeForLevel } from '../performance';
import {
  BACKEND_IDS,
  FRONTEND_IDS,
  MOBILE_FRAMEWORK_IDS,
  MOBILE_SOURCE_IDS,
  OPEN_CODE_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
} from '../../config/state';
import { hasInitializedToolchain } from './toolchain';

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

// team.approved === true means the user confirmed the line-up in the wizard's team
// step (the single "Start the build" confirmation, which shows the role→model
// line-up for the chosen performance). The spawn gate reads this; once it is set
// during onboarding, nothing re-asks afterward.
export function isTeamApproved(team: unknown): boolean {
  const t = asObject(team);
  return Boolean(t && t.approved === true);
}

export function hasTechnologyArrays(technologies: unknown): boolean {
  const t = asObject(technologies);
  return Boolean(t && Array.isArray(t.frontend) && Array.isArray(t.backend) && Array.isArray(t.mobile));
}

function hasValidMobileState(mobile: unknown): boolean {
  const m = asObject(mobile);
  return Boolean(m
    && typeof m.enabled === 'boolean'
    && inSet(MOBILE_FRAMEWORK_IDS, m.framework)
    && inSet(MOBILE_SOURCE_IDS, m.source));
}

// "Resolved" for a new project: a valid mobile object whose source is not "none"
// (i.e. the Mobile App prompt was actually answered).
export function hasResolvedNewProjectMobileState(mobile: unknown): boolean {
  const m = asObject(mobile);
  return hasValidMobileState(mobile) && Boolean(m && m.source !== 'none');
}

function formatStateValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

function idList(set: Set<string>): string {
  return [...set].map((id) => `\`${id}\``).join(' · ');
}

// Full new-project readiness validator. Returns a list of human-readable issues
// (empty array == ready to materialize). Ported 1:1 from _helpers.cjs.
export function trafficOneStateValidationIssues(
  state: unknown,
  validCodeGraphProviders: string[] = ['gitnexus', 'graphify'],
): string[] {
  const issues: string[] = [];
  const s = asObject(state);
  if (!s) return ['`.traffic-one/.one.json` must contain a JSON object.'];

  if (!s.stack) {
    issues.push('`stack` is missing.');
  } else if (typeof s.stack !== 'string' || !STACK_IDS.has(s.stack)) {
    issues.push(`\`stack\` is ${formatStateValue(s.stack)}; valid values: ${idList(STACK_IDS)}.`);
  }

  if (!s.frontend) {
    issues.push('`frontend` is missing.');
  } else if (typeof s.frontend !== 'string' || !FRONTEND_IDS.has(s.frontend)) {
    issues.push(`\`frontend\` is ${formatStateValue(s.frontend)}; valid values: ${idList(FRONTEND_IDS)}.`);
  }

  if (!s.backend) {
    issues.push('`backend` is missing.');
  } else if (typeof s.backend !== 'string' || !BACKEND_IDS.has(s.backend)) {
    issues.push(`\`backend\` is ${formatStateValue(s.backend)}; valid values: ${idList(BACKEND_IDS)}.`);
  }

  const mobile = asObject(s.mobile);
  if (!mobile) {
    issues.push('`mobile` must be an object with `enabled`, `framework`, and `source`.');
  } else {
    if (typeof mobile.enabled !== 'boolean') {
      issues.push(`\`mobile.enabled\` is ${formatStateValue(mobile.enabled)}; expected boolean.`);
    }
    if (typeof mobile.framework !== 'string' || !MOBILE_FRAMEWORK_IDS.has(mobile.framework)) {
      issues.push(`\`mobile.framework\` is ${formatStateValue(mobile.framework)}; valid values: ${idList(MOBILE_FRAMEWORK_IDS)}.`);
    } else if (
      s.mode === 'new-project'
      && mobile.framework === 'ionic-capacitor'
      && s.frontend === 'none'
    ) {
      issues.push('`mobile.framework="ionic-capacitor"` requires an explicit web `frontend`; Ionic is an overlay, not a standalone native profile.');
    }
    if (typeof mobile.source !== 'string' || !MOBILE_SOURCE_IDS.has(mobile.source)) {
      issues.push(`\`mobile.source\` is ${formatStateValue(mobile.source)}; valid values: ${idList(MOBILE_SOURCE_IDS)}.`);
    } else if (s.mode === 'new-project' && mobile.source === 'none') {
      issues.push('`mobile.source` must be `prompted` or `explicit` after the Mobile App prompt for new-project onboarding.');
    }
  }

  if (!hasTechnologyArrays(s.technologies)) {
    issues.push('`technologies` must contain `frontend`, `backend`, and `mobile` arrays.');
  }

  if (s.mode === 'new-project' && !hasValidProjectContext(s.projectContext)) {
    issues.push('`projectContext` must be an object with `source`, `originalPrompt`, `summary`, `answers`, and `collectedAt`.');
  }

  if (s.mode === 'new-project' && !hasValidTeamState(s.team)) {
    issues.push(`\`team\` must be an object with valid \`mode\` (${idList(TEAM_MODE_IDS)}) and \`source\` (${idList(TEAM_SOURCE_IDS)}).`);
  }

  if (s.mode === 'new-project' && !hasValidPerformanceState(s.performance)) {
    issues.push(`\`performance\` must be an object with valid \`level\` (${idList(PERFORMANCE_LEVEL_IDS)}) and \`source\` (\`prompted\` · \`explicit\`).`);
  }

  if (s.mode === 'new-project' && hasValidPerformanceState(s.performance) && hasValidTeamState(s.team)) {
    const perf = asObject(s.performance);
    const team = asObject(s.team);
    const expectedTeamMode = teamModeForLevel(perf ? String(perf.level) : '');
    if (team && team.mode !== expectedTeamMode) {
      issues.push(`\`team.mode\` is ${formatStateValue(team.mode)} but performance.level=${formatStateValue(perf?.level)} requires ${formatStateValue(expectedTeamMode)}.`);
    }
    if (expectedTeamMode === 'subagents' && !isTeamApproved(s.team)) {
      issues.push('`team.approved` must be true after Team Confirmation before balanced/high subagents can run.');
    }
  }

  const cgProvider = typeof s.codeGraphProvider === 'string' ? s.codeGraphProvider : '';
  if (!cgProvider) {
    issues.push('`codeGraphProvider` is missing.');
  } else if (!validCodeGraphProviders.includes(cgProvider)) {
    issues.push(`\`codeGraphProvider\` is ${formatStateValue(cgProvider)}; valid values: ${validCodeGraphProviders.map((id) => `\`${id}\``).join(' · ')}.`);
  }

  if (!hasInitializedToolchain(s.toolchain)) {
    issues.push('`toolchain` must include initialized entries for every tracked tool.');
  }
  if (s.confirmed !== true) {
    issues.push('`confirmed` must be true.');
  }
  if (s.onboardingComplete !== true) {
    issues.push('`onboardingComplete` must be true.');
  }
  if (typeof s.confirmedAt !== 'string' || s.confirmedAt.trim() === '') {
    issues.push('`confirmedAt` must be a non-empty ISO-8601 string.');
  }

  return issues;
}
