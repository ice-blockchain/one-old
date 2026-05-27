'use strict';

// scripts/hook-runtime/state/state.cjs
// Low-level JSON / file I/O helpers and the .traffic-one.json read/write API.
// Every module that needs to touch the state file goes through here.
//
// Implementation is split into cohesive sub-modules; this is the aggregating
// entry point that preserves the public export surface:
//   io · constants · canonicalize · validate · normalize · materialization · run-agent

const {
  parseJsonText,
  safeReadText,
  safeReadJson,
  writeJson,
  nowIso,
  getPluginVersion,
} = require('./io.cjs');
const {
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  OPEN_CODE_SOURCE_IDS,
  KNOWN_ADDONS,
  VALID_AGENT_ROLES,
  RUNS_REL_DIR,
} = require('./constants.cjs');
const {
  canonicalizeStateShape,
  canonicalTeamOverrides,
  overridesEqual,
  codeGraphProviderFromValue,
  canonicalPerformanceLevel,
  canonicalOpenCodeSource,
} = require('./canonicalize.cjs');
const {
  hasValidTeamState,
  hasValidProjectContext,
  isTeamApproved,
  hasValidPerformanceState,
  hasResolvedOpenCodeState,
} = require('./validate.cjs');
const {
  readState,
  writeState,
  normalizeState,
  initializeToolchainState,
  defaultTechnologiesFor,
  requireAddon,
} = require('./normalize.cjs');
const {
  stackFingerprint,
  isMaterialized,
  isSubagentSession,
  activeAgentRole,
  getSpawnIndex,
  isFixCycleSession,
} = require('./materialization.cjs');
const {
  runIdNow,
  hookSessionIdentity,
  ensureRunAgentClaim,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
} = require('./run-agent.cjs');

module.exports = {
  parseJsonText,
  safeReadText,
  safeReadJson,
  writeJson,
  nowIso,
  readState,
  writeState,
  canonicalizeStateShape,
  normalizeState,
  initializeToolchainState,
  defaultTechnologiesFor,
  hasValidTeamState,
  hasValidProjectContext,
  isTeamApproved,
  canonicalTeamOverrides,
  overridesEqual,
  codeGraphProviderFromValue,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  OPEN_CODE_SOURCE_IDS,
  canonicalPerformanceLevel,
  canonicalOpenCodeSource,
  hasValidPerformanceState,
  hasResolvedOpenCodeState,
  requireAddon,
  KNOWN_ADDONS,
  getPluginVersion,  // exported for testing + diagnostic
  stackFingerprint,
  isMaterialized,
  isSubagentSession,
  activeAgentRole,
  VALID_AGENT_ROLES,
  getSpawnIndex,
  isFixCycleSession,
  RUNS_REL_DIR,
  runIdNow,
  hookSessionIdentity,
  ensureRunAgentClaim,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
};
