'use strict';

// scripts/hook-runtime/state/materialization.cjs
// Stack fingerprinting, materialization-freshness checks, and subagent / fix-cycle
// signal derivation from the shared `.traffic-one/.one.json` state.

const { VALID_AGENT_ROLES, SUBAGENT_STALE_MS } = require('./constants.cjs');

// Returns a stable string fingerprint of the stack dimensions that determine
// which rules and skills are active. Used to detect when the active set needs
// to be re-materialized (e.g. after stack change or plugin update).
function stackFingerprint(state) {
  if (!state || typeof state !== 'object') return 'minimal|none|none|none';
  return [
    state.stack   || 'minimal',
    state.frontend || 'none',
    state.backend  || 'none',
    (state.mobile && state.mobile.framework) || 'none',
  ].join('|');
}

// Returns true when .traffic-one/.one.json already carries a valid materialization
// stamp that matches the current stack. If not, implementation tools should be
// blocked until the stamp is written by SessionStart.
function isMaterialized(state) {
  if (!state || typeof state !== 'object') return false;
  if (!state.onboardingComplete) return true; // pre-onboarding: don't block
  if (!state.materializedStack) return false;
  return state.materializedStack === stackFingerprint(state);
}

// SUBAGENT SIGNALS.
// Current versions prefer per-agent run claims under:
//   .traffic-one/runs/<runId>/pending/<claimId>.json
//   .traffic-one/runs/<runId>/<agentSessionId>.json
//
// The shared .traffic-one/.one.json `currentRunId` field remains the active run
// pointer; `activeAgentRole` remains a legacy fallback for projects created by
// older plugin builds. New Codex/Claude/Cursor spawns should not rely on a
// single shared role marker because parallel agents overwrite each other.
//
// Safety: only treats a session as a subagent when materialization is fresh
// (< 30 min) and the fingerprint matches. Stale runs fall back to the full
// parent bundle so abandoned/restarted sessions stay safe.
function isSubagentSession(state) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.currentRunId !== 'string' || !state.currentRunId) return false;
  if (!state.materializedStack) return false;
  if (state.materializedStack !== stackFingerprint(state)) return false;
  if (state.materializedAt) {
    const ageMs = Date.now() - Date.parse(state.materializedAt);
    if (Number.isFinite(ageMs) && ageMs > SUBAGENT_STALE_MS) return false;
  }
  return true;
}

function activeAgentRole(state) {
  if (!state || typeof state !== 'object') return null;
  const role = state.activeAgentRole;
  return typeof role === 'string' && VALID_AGENT_ROLES.has(role) ? role : null;
}

// FIX-CYCLE DETECTION.
// `spawnIndex` is a map { role -> integer } that the orchestrator increments
// before each subagent spawn for that role within a single `currentRunId`.
//   1 = first spawn (build / plan / review pass 0)
//   2+ = re-spawn (fix cycle, re-review, etc.)
// The SessionStart hook checks this to emit an ULTRA-slim bundle for
// re-spawns: just pointers to the prior digest + the fix-cycle context file
// the orchestrator wrote before the re-spawn. Saves ~25K-30K tokens per
// fix-cycle spawn vs the already-slim role-scoped bundle.
function getSpawnIndex(state, role) {
  if (!state || typeof state !== 'object') return 0;
  const map = state.spawnIndex;
  if (!map || typeof map !== 'object') return 0;
  const n = map[role];
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function isFixCycleSession(state) {
  if (!isSubagentSession(state)) return false;
  const role = activeAgentRole(state);
  if (!role) return false;
  return getSpawnIndex(state, role) > 1;
}

module.exports = {
  stackFingerprint,
  isMaterialized,
  isSubagentSession,
  activeAgentRole,
  getSpawnIndex,
  isFixCycleSession,
};
