'use strict';

// scripts/hook-runtime/state/validate.cjs
// Validators for the onboarding-critical state sub-objects (performance,
// openCode, team, projectContext) plus the team-approval marker check.

const {
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  OPEN_CODE_SOURCE_IDS,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
} = require('./constants.cjs');

function hasValidPerformanceState(performance) {
  return Boolean(
    performance
    && typeof performance === 'object'
    && PERFORMANCE_LEVEL_IDS.has(performance.level)
    && PERFORMANCE_SOURCE_IDS.has(performance.source),
  );
}

// The OpenCode opt-in is "resolved" once the user has answered either way:
// a strict-boolean `enabled` plus a known `source`. "Not now" resolves it with
// enabled:false, so onboarding can advance without re-asking.
function hasResolvedOpenCodeState(openCode) {
  return Boolean(
    openCode
    && typeof openCode === 'object'
    && !Array.isArray(openCode)
    && typeof openCode.enabled === 'boolean'
    && OPEN_CODE_SOURCE_IDS.has(openCode.source),
  );
}

function hasValidTeamState(team) {
  return Boolean(
    team
    && typeof team === 'object'
    && TEAM_MODE_IDS.has(team.mode)
    && TEAM_SOURCE_IDS.has(team.source)
  );
}

function hasValidProjectContext(projectContext) {
  return Boolean(
    projectContext
    && typeof projectContext === 'object'
    && !Array.isArray(projectContext)
    && typeof projectContext.source === 'string'
    && projectContext.source.trim() !== ''
    && typeof projectContext.originalPrompt === 'string'
    && typeof projectContext.summary === 'string'
    && projectContext.summary.trim() !== ''
    && projectContext.answers
    && typeof projectContext.answers === 'object'
    && !Array.isArray(projectContext.answers)
    && typeof projectContext.collectedAt === 'string'
    && projectContext.collectedAt.trim() !== ''
  );
}

// Team Confirmation sets `team.approved: true` when the user
// explicitly Approves the team line-up. Used by the spawn gate to enforce
// that the model can't bypass confirmation with "I'll auto-approve the default".
function isTeamApproved(team) {
  return Boolean(team && typeof team === 'object' && team.approved === true);
}

module.exports = {
  hasValidPerformanceState,
  hasResolvedOpenCodeState,
  hasValidTeamState,
  hasValidProjectContext,
  isTeamApproved,
};
