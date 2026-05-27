'use strict';

// scripts/hook-runtime/state/run-agent.cjs
// Per-agent run-claim machinery: writes/reads `.traffic-one/runs/<runId>/...`
// claim files so parallel subagents resolve their own role context instead of
// fighting over a single shared marker in `.traffic-one/.one.json`.

const fs = require('fs');
const path = require('path');

const {
  RUNS_REL_DIR,
  VALID_AGENT_ROLES,
  SUBAGENT_STALE_MS,
  PENDING_AGENT_CLAIM_STALE_MS,
} = require('./constants.cjs');
const { safeReadJson, writeJson, nowIso, parseJsonText } = require('./io.cjs');
const {
  stackFingerprint,
  getSpawnIndex,
  isSubagentSession,
  activeAgentRole,
} = require('./materialization.cjs');
const { writeState } = require('./normalize.cjs');

function runIdNow() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

function safePathSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160);
}

function runsRoot(cwd) {
  return path.join(cwd, RUNS_REL_DIR);
}

function runDir(cwd, runId) {
  return path.join(runsRoot(cwd), safePathSegment(runId));
}

function pendingDir(cwd, runId) {
  return path.join(runDir(cwd, runId), 'pending');
}

function runAgentFile(cwd, runId, sessionId) {
  return path.join(runDir(cwd, runId), `${safePathSegment(sessionId)}.json`);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nestedValue(source, keys) {
  let current = source;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function hookSessionIdentity(rawInput) {
  const data = rawInput && typeof rawInput === 'object'
    ? rawInput
    : parseJsonText(rawInput, {});
  const payload = data && typeof data.payload === 'object' ? data.payload : {};
  const source = data && typeof data.source === 'object'
    ? data.source
    : payload && typeof payload.source === 'object'
      ? payload.source
      : {};
  const threadSpawn = nestedValue(source, ['subagent', 'thread_spawn'])
    || nestedValue(data, ['subagent', 'thread_spawn'])
    || nestedValue(payload, ['subagent', 'thread_spawn'])
    || {};

  const sessionId = firstString(
    data.session_id,
    data.sessionId,
    data.sessionID,
    data.id,
    payload.session_id,
    payload.sessionId,
    payload.id,
    nestedValue(data, ['session', 'id']),
    nestedValue(payload, ['session', 'id']),
  );
  const parentSessionId = firstString(
    data.parent_session_id,
    data.parentSessionId,
    payload.parent_session_id,
    payload.parentSessionId,
    threadSpawn.parent_thread_id,
    threadSpawn.parentThreadId,
    threadSpawn.parent_session_id,
    threadSpawn.parentSessionId,
  );
  const threadSource = firstString(
    data.thread_source,
    data.threadSource,
    payload.thread_source,
    payload.threadSource,
  );
  const isSubagent = Boolean(
    threadSource === 'subagent'
    || parentSessionId
    || nestedValue(source, ['subagent'])
    || nestedValue(data, ['subagent'])
    || nestedValue(payload, ['subagent'])
  );

  return {
    sessionId,
    parentSessionId,
    isSubagent,
  };
}

function timestampAgeMs(value) {
  if (typeof value !== 'string' || !value.trim()) return Infinity;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}

function isFreshTimestamp(value, maxAgeMs) {
  return timestampAgeMs(value) <= maxAgeMs;
}

function stateAllowsRunContext(state, runId) {
  if (!state || typeof state !== 'object') return false;
  if (typeof runId !== 'string' || !runId) return false;
  if (typeof state.currentRunId === 'string' && state.currentRunId && state.currentRunId !== runId) return false;
  if (!state.materializedStack) return false;
  if (state.materializedStack !== stackFingerprint(state)) return false;
  return true;
}

function claimAllowsState(state, claim) {
  if (!claim || typeof claim !== 'object') return false;
  if (!VALID_AGENT_ROLES.has(claim.role)) return false;
  if (!stateAllowsRunContext(state, claim.runId)) return false;
  if (claim.stackFingerprint && claim.stackFingerprint !== stackFingerprint(state)) return false;
  if (!isFreshTimestamp(claim.createdAt, SUBAGENT_STALE_MS)) return false;
  return true;
}

function runIdsForLookup(cwd, state) {
  const ids = [];
  if (state && typeof state.currentRunId === 'string' && state.currentRunId) {
    ids.push(state.currentRunId);
  }
  try {
    if (fs.existsSync(runsRoot(cwd))) {
      const diskIds = fs.readdirSync(runsRoot(cwd), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const id of diskIds) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
  } catch {
    // Best-effort lookup; fall back to currentRunId only.
  }
  return ids;
}

function readClaimFile(filePath) {
  const claim = safeReadJson(filePath, null);
  return claim && typeof claim === 'object' ? claim : null;
}

function listPendingClaims(cwd, runId) {
  try {
    const dir = pendingDir(cwd, runId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => {
        const filePath = path.join(dir, entry.name);
        const claim = readClaimFile(filePath);
        return claim ? { filePath, claim } : null;
      })
      .filter(Boolean)
      .filter(({ claim }) => isFreshTimestamp(claim.createdAt, PENDING_AGENT_CLAIM_STALE_MS))
      .sort((left, right) => String(left.claim.createdAt).localeCompare(String(right.claim.createdAt)));
  } catch {
    return [];
  }
}

function listClaimedAgents(cwd, runId) {
  try {
    const dir = runDir(cwd, runId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readClaimFile(path.join(dir, entry.name)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function countRunClaimsForRole(cwd, runId, role) {
  const pending = listPendingClaims(cwd, runId).filter(({ claim }) => claim.role === role).length;
  const claimed = listClaimedAgents(cwd, runId).filter((claim) => claim.role === role).length;
  return pending + claimed;
}

function nextSpawnIndex(cwd, state, runId, role) {
  const stateIndex = getSpawnIndex(state, role);
  const diskIndex = countRunClaimsForRole(cwd, runId, role) + 1;
  return Math.max(stateIndex, diskIndex, 1);
}

function ensureRunAgentClaim(cwd, state, role, rawInput, metadata = {}) {
  if (!VALID_AGENT_ROLES.has(role)) return null;
  const source = state && typeof state === 'object' ? { ...state } : {};
  const runId = typeof source.currentRunId === 'string' && source.currentRunId
    ? source.currentRunId
    : runIdNow();
  const spawnIndex = nextSpawnIndex(cwd, source, runId, role);
  const identity = hookSessionIdentity(rawInput);
  const claimId = `${role}-${spawnIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const claim = {
    version: 1,
    runId,
    claimId,
    role,
    spawnIndex,
    status: 'pending',
    parentSessionId: identity.sessionId || null,
    createdAt: nowIso(),
    stackFingerprint: stackFingerprint(source),
    toolName: metadata.toolName || null,
    agentType: metadata.agentType || null,
    model: metadata.model || null,
  };

  fs.mkdirSync(pendingDir(cwd, runId), { recursive: true });
  writeJson(path.join(pendingDir(cwd, runId), `${safePathSegment(claimId)}.json`), claim);

  source.currentRunId = runId;
  source.spawnIndex = source.spawnIndex && typeof source.spawnIndex === 'object'
    ? { ...source.spawnIndex, [role]: spawnIndex }
    : { [role]: spawnIndex };
  writeState(cwd, source);

  return claim;
}

function contextFromClaim(claim, source) {
  return {
    source,
    runId: claim.runId,
    role: claim.role,
    spawnIndex: Number.isInteger(claim.spawnIndex) && claim.spawnIndex > 0 ? claim.spawnIndex : 1,
    sessionId: claim.sessionId || null,
    claimId: claim.claimId || null,
  };
}

function resolveRunAgentContext(cwd, state, rawInput, options = {}) {
  const identity = hookSessionIdentity(rawInput);
  const shouldClaimPending = options.claimPending !== false;
  const runIds = runIdsForLookup(cwd, state);

  if (identity.sessionId) {
    for (const runId of runIds) {
      const claim = readClaimFile(runAgentFile(cwd, runId, identity.sessionId));
      if (claimAllowsState(state, claim)) {
        return contextFromClaim(claim, 'run-agent');
      }
    }
  }

  if (shouldClaimPending && identity.isSubagent) {
    for (const runId of runIds) {
      const pending = listPendingClaims(cwd, runId)
        .filter(({ claim }) => claimAllowsState(state, claim));
      const matched = pending.find(({ claim }) => (
        identity.parentSessionId
        && claim.parentSessionId
        && claim.parentSessionId === identity.parentSessionId
      )) || pending[0];
      if (!matched) continue;

      const sessionId = identity.sessionId || matched.claim.sessionId || matched.claim.claimId;
      const claimed = {
        ...matched.claim,
        status: 'claimed',
        sessionId,
        parentSessionId: identity.parentSessionId || matched.claim.parentSessionId || null,
        claimedAt: nowIso(),
      };
      fs.mkdirSync(runDir(cwd, runId), { recursive: true });
      writeJson(runAgentFile(cwd, runId, sessionId), claimed);
      try {
        fs.rmSync(matched.filePath, { force: true });
      } catch {
        // Leaving a duplicate pending file is harmless; freshness will expire it.
      }
      return contextFromClaim(claimed, 'run-agent');
    }
  }

  return null;
}

function hasRunAgentState(cwd, state) {
  const runId = state && typeof state.currentRunId === 'string' ? state.currentRunId : null;
  if (!runId) return false;
  return fs.existsSync(runDir(cwd, runId));
}

function legacyRunAgentContext(state) {
  if (!isSubagentSession(state)) return null;
  const role = activeAgentRole(state);
  if (!role) return null;
  return {
    source: 'legacy-state',
    runId: state.currentRunId,
    role,
    spawnIndex: getSpawnIndex(state, role) || 1,
    sessionId: null,
    claimId: null,
  };
}

module.exports = {
  runIdNow,
  hookSessionIdentity,
  ensureRunAgentClaim,
  resolveRunAgentContext,
  hasRunAgentState,
  legacyRunAgentContext,
};
