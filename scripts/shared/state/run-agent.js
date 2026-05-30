"use strict";
// src/shared/state/run-agent.ts
// Per-agent run-claim machinery under .traffic-one/runs/<runId>/... so parallel
// subagents resolve their own role context. Ported 1:1 from
// scripts/hook-runtime/state/run-agent.cjs.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runIdNow = runIdNow;
exports.transcriptThreadId = transcriptThreadId;
exports.inferRoleFromTranscript = inferRoleFromTranscript;
exports.hookSessionIdentity = hookSessionIdentity;
exports.ensureRunAgentClaim = ensureRunAgentClaim;
exports.resolveRunAgentContext = resolveRunAgentContext;
exports.claimThreadRole = claimThreadRole;
exports.hasRunAgentState = hasRunAgentState;
exports.legacyRunAgentContext = legacyRunAgentContext;
const obj_1 = require("../obj");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const fsjson_1 = require("../fsjson");
const constants_1 = require("./constants");
const io_1 = require("./io");
const materialization_1 = require("./materialization");
const normalize_1 = require("./normalize");
function runIdNow() {
    return Date.now().toString();
}
function safePathSegment(value) {
    return String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}
function runsRoot(cwd) {
    return path.join(cwd, constants_1.RUNS_REL_DIR);
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
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return null;
}
function nestedValue(source, keys) {
    let current = source;
    for (const key of keys) {
        if (!current || typeof current !== 'object')
            return undefined;
        current = current[key];
    }
    return current;
}
// Codex reports the orchestrator's session_id in every hook payload — even for
// subagent threads — so session_id can't tell threads apart. The only per-thread
// discriminator is transcript_path, whose rollout filename ends with the running
// thread's id (the child's `agent_id`). Parse that canonical UUID.
const ROLLOUT_THREAD_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
function transcriptThreadId(transcriptPath) {
    if (typeof transcriptPath !== 'string' || !transcriptPath)
        return null;
    const base = transcriptPath.replace(/\\/g, '/').split('/').pop() || '';
    const match = base.match(ROLLOUT_THREAD_RE);
    return match ? match[1].toLowerCase() : null;
}
// Infer the Traffic One role assigned to a subagent by reading its rollout
// (transcript_path) and matching the spawn assignment "You are … senior-X". Anchored
// on "You are" (within one clause) so a prompt that ALSO names other roles — e.g.
// "you are senior-frontend … avoid backend-owned paths … senior-backend owns the API"
// — still resolves the assigned role, not a cross-referenced one. Best-effort: returns
// null if the file is unreadable or the assignment isn't present yet (SubagentStart can
// fire before the rollout is flushed; the child's first write re-attempts when it is).
const SPAWN_ROLE_RE = /\byou are\b[^.\n]{0,40}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i;
function inferRoleFromTranscript(transcriptPath) {
    if (typeof transcriptPath !== 'string' || !transcriptPath)
        return null;
    let raw;
    try {
        raw = fs.readFileSync(transcriptPath, 'utf8');
    }
    catch {
        return null;
    }
    const userTexts = [];
    for (const line of raw.split('\n')) {
        if (!line.includes('"user"'))
            continue; // cheap prefilter before JSON.parse
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        const p = (0, obj_1.obj)(parsed?.payload) || (0, obj_1.obj)(parsed) || {};
        if (p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content))
            continue;
        const text = p.content
            .map((seg) => {
            const s = (0, obj_1.obj)(seg);
            return s && s.type === 'input_text' && typeof s.text === 'string' ? s.text : '';
        })
            .filter(Boolean)
            .join('\n');
        if (text)
            userTexts.push(text);
    }
    for (let i = userTexts.length - 1; i >= 0; i -= 1) {
        const match = (userTexts[i] || '').match(SPAWN_ROLE_RE);
        const role = match ? match[1].toLowerCase() : null;
        if (role && constants_1.VALID_AGENT_ROLES.has(role))
            return role;
    }
    return null;
}
function hookSessionIdentity(rawInput) {
    const data = (rawInput && typeof rawInput === 'object'
        ? rawInput
        : (0, fsjson_1.parseJson)(typeof rawInput === 'string' ? rawInput : '', {}));
    const payload = (0, obj_1.obj)(data.payload) || {};
    const source = (0, obj_1.obj)(data.source) || (0, obj_1.obj)(payload.source) || {};
    const threadSpawn = (nestedValue(source, ['subagent', 'thread_spawn'])
        || nestedValue(data, ['subagent', 'thread_spawn'])
        || nestedValue(payload, ['subagent', 'thread_spawn'])
        || {});
    const sessionId = firstString(data.session_id, data.sessionId, data.sessionID, data.id, payload.session_id, payload.sessionId, payload.id, nestedValue(data, ['session', 'id']), nestedValue(payload, ['session', 'id']));
    const parentSessionId = firstString(data.parent_session_id, data.parentSessionId, payload.parent_session_id, payload.parentSessionId, threadSpawn.parent_thread_id, threadSpawn.parentThreadId, threadSpawn.parent_session_id, threadSpawn.parentSessionId);
    const transcriptPath = firstString(data.transcript_path, data.transcriptPath, payload.transcript_path, payload.transcriptPath);
    const threadId = transcriptThreadId(transcriptPath);
    const threadSource = firstString(data.thread_source, data.threadSource, payload.thread_source, payload.threadSource);
    const isSubagent = Boolean(threadSource === 'subagent'
        || parentSessionId
        || nestedValue(source, ['subagent'])
        || nestedValue(data, ['subagent'])
        || nestedValue(payload, ['subagent']));
    return { sessionId, parentSessionId, isSubagent, threadId, transcriptPath };
}
function timestampAgeMs(value) {
    if (typeof value !== 'string' || !value.trim())
        return Infinity;
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}
function isFreshTimestamp(value, maxAgeMs) {
    return timestampAgeMs(value) <= maxAgeMs;
}
function stateAllowsRunContext(state, runId) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return false;
    if (typeof runId !== 'string' || !runId)
        return false;
    if (typeof s.currentRunId === 'string' && s.currentRunId && s.currentRunId !== runId)
        return false;
    if (!s.materializedStack)
        return false;
    if (s.materializedStack !== (0, materialization_1.stackFingerprint)(s))
        return false;
    return true;
}
function claimAllowsState(state, claim) {
    const c = (0, obj_1.obj)(claim);
    if (!c)
        return false;
    if (typeof c.role !== 'string' || !constants_1.VALID_AGENT_ROLES.has(c.role))
        return false;
    if (!stateAllowsRunContext(state, c.runId))
        return false;
    if (c.stackFingerprint && c.stackFingerprint !== (0, materialization_1.stackFingerprint)(state))
        return false;
    if (!isFreshTimestamp(c.createdAt, constants_1.SUBAGENT_STALE_MS))
        return false;
    return true;
}
function runIdsForLookup(cwd, state) {
    const ids = [];
    const s = (0, obj_1.obj)(state);
    if (s && typeof s.currentRunId === 'string' && s.currentRunId)
        ids.push(s.currentRunId);
    try {
        if (fs.existsSync(runsRoot(cwd))) {
            const diskIds = fs.readdirSync(runsRoot(cwd), { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort()
                .reverse();
            for (const id of diskIds)
                if (!ids.includes(id))
                    ids.push(id);
        }
    }
    catch {
        // best-effort
    }
    return ids;
}
function readClaimFile(filePath) {
    return (0, obj_1.obj)((0, fsjson_1.readJson)(filePath, null));
}
function listPendingClaims(cwd, runId) {
    try {
        const dir = pendingDir(cwd, runId);
        if (!fs.existsSync(dir))
            return [];
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => {
            const filePath = path.join(dir, entry.name);
            const claim = readClaimFile(filePath);
            return claim ? { filePath, claim } : null;
        })
            .filter((item) => item !== null)
            .filter(({ claim }) => isFreshTimestamp(claim.createdAt, constants_1.PENDING_AGENT_CLAIM_STALE_MS))
            .sort((left, right) => String(left.claim.createdAt).localeCompare(String(right.claim.createdAt)));
    }
    catch {
        return [];
    }
}
function listClaimedAgents(cwd, runId) {
    try {
        const dir = runDir(cwd, runId);
        if (!fs.existsSync(dir))
            return [];
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => readClaimFile(path.join(dir, entry.name)))
            .filter((claim) => claim !== null);
    }
    catch {
        return [];
    }
}
function countRunClaimsForRole(cwd, runId, role) {
    const pending = listPendingClaims(cwd, runId).filter(({ claim }) => claim.role === role).length;
    const claimed = listClaimedAgents(cwd, runId).filter((claim) => claim.role === role).length;
    return pending + claimed;
}
function nextSpawnIndex(cwd, state, runId, role) {
    const stateIndex = (0, materialization_1.getSpawnIndex)(state, role);
    const diskIndex = countRunClaimsForRole(cwd, runId, role) + 1;
    return Math.max(stateIndex, diskIndex, 1);
}
function ensureRunAgentClaim(cwd, state, role, rawInput, metadata = {}) {
    if (!constants_1.VALID_AGENT_ROLES.has(role))
        return null;
    const source = (0, obj_1.obj)(state) ? { ...state } : {};
    const runId = typeof source.currentRunId === 'string' && source.currentRunId ? source.currentRunId : runIdNow();
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
        createdAt: (0, io_1.stateTimestamp)(),
        stackFingerprint: (0, materialization_1.stackFingerprint)(source),
        toolName: metadata.toolName || null,
        agentType: metadata.agentType || null,
        model: metadata.model || null,
    };
    fs.mkdirSync(pendingDir(cwd, runId), { recursive: true });
    (0, fsjson_1.writeJson)(path.join(pendingDir(cwd, runId), `${safePathSegment(claimId)}.json`), claim);
    source.currentRunId = runId;
    const existingSpawn = (0, obj_1.obj)(source.spawnIndex);
    source.spawnIndex = existingSpawn ? { ...existingSpawn, [role]: spawnIndex } : { [role]: spawnIndex };
    (0, normalize_1.writeState)(cwd, source);
    return claim;
}
function contextFromClaim(claim, source) {
    return {
        source,
        runId: claim.runId,
        role: claim.role,
        spawnIndex: typeof claim.spawnIndex === 'number' && Number.isInteger(claim.spawnIndex) && claim.spawnIndex > 0
            ? claim.spawnIndex
            : 1,
        sessionId: claim.sessionId || null,
        claimId: claim.claimId || null,
    };
}
function resolveRunAgentContext(cwd, state, rawInput, options = {}) {
    const identity = hookSessionIdentity(rawInput);
    const shouldClaimPending = options.claimPending !== false;
    const runIds = runIdsForLookup(cwd, state);
    // Exact claim match. threadId (from transcript_path) is the reliable Codex key —
    // a subagent's tool-call hook reports the parent's session_id, so try threadId
    // first, then session_id (the per-thread id on Claude).
    const exactKeys = [identity.threadId, identity.sessionId].filter((v) => Boolean(v));
    for (const runId of runIds) {
        for (const key of exactKeys) {
            const claim = readClaimFile(runAgentFile(cwd, runId, key));
            if (claim && claimAllowsState(state, claim)) {
                return contextFromClaim(claim, 'run-agent');
            }
        }
    }
    // Codex self-heal: a subagent thread (threadId differs from the parent session_id
    // Codex reports) with no claim yet — infer its role from its own transcript and
    // stake the claim now. This runs at the child's first gated write, by which point
    // the rollout carries the spawn assignment (SubagentStart can fire before it does).
    if (shouldClaimPending && identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId) {
        const role = inferRoleFromTranscript(identity.transcriptPath);
        if (role) {
            const ctx = claimThreadRole(cwd, state, identity.threadId, role, { parentSessionId: identity.sessionId });
            if (ctx)
                return ctx;
        }
    }
    if (shouldClaimPending && identity.isSubagent) {
        for (const runId of runIds) {
            const pending = listPendingClaims(cwd, runId).filter(({ claim }) => claimAllowsState(state, claim));
            const matched = pending.find(({ claim }) => (identity.parentSessionId && claim.parentSessionId && claim.parentSessionId === identity.parentSessionId)) || pending[0];
            if (!matched)
                continue;
            const sessionId = identity.sessionId || matched.claim.sessionId || matched.claim.claimId;
            const claimed = {
                ...matched.claim,
                status: 'claimed',
                sessionId,
                parentSessionId: identity.parentSessionId || matched.claim.parentSessionId || null,
                claimedAt: (0, io_1.stateTimestamp)(),
            };
            fs.mkdirSync(runDir(cwd, runId), { recursive: true });
            (0, fsjson_1.writeJson)(runAgentFile(cwd, runId, sessionId), claimed);
            try {
                fs.rmSync(matched.filePath, { force: true });
            }
            catch {
                // a leftover pending file is harmless; freshness expires it
            }
            return contextFromClaim(claimed, 'run-agent');
        }
    }
    return null;
}
// Create a claimed role context keyed by an explicit thread id. Used by the Codex
// SubagentStart hook: Codex fires no PreToolUse for spawns (so the agent-model gate
// never stakes a pending claim) and reports the parent's session_id on the child's
// later tool calls — the child is identifiable only by its transcript thread id
// (== the SubagentStart `agent_id`). We persist a claim under that id with the role
// inferred from the child's spawn prompt, so the child's write hook resolves its role
// by exact threadId match. Idempotent: an existing valid claim is returned as-is.
function claimThreadRole(cwd, state, threadId, role, options = {}) {
    if (!constants_1.VALID_AGENT_ROLES.has(role))
        return null;
    if (typeof threadId !== 'string' || !threadId.trim())
        return null;
    const id = threadId.trim();
    const source = (0, obj_1.obj)(state) ? { ...state } : {};
    const runId = typeof source.currentRunId === 'string' && source.currentRunId ? source.currentRunId : runIdNow();
    const existing = readClaimFile(runAgentFile(cwd, runId, id));
    if (existing && claimAllowsState(state, existing)) {
        return contextFromClaim(existing, 'subagent-start');
    }
    const spawnIndex = nextSpawnIndex(cwd, source, runId, role);
    const claim = {
        version: 1,
        runId,
        claimId: `${role}-${spawnIndex}-${id.slice(-8)}`,
        role,
        spawnIndex,
        status: 'claimed',
        sessionId: id,
        parentSessionId: firstString(options.parentSessionId),
        createdAt: (0, io_1.stateTimestamp)(),
        claimedAt: (0, io_1.stateTimestamp)(),
        stackFingerprint: (0, materialization_1.stackFingerprint)(source),
    };
    fs.mkdirSync(runDir(cwd, runId), { recursive: true });
    (0, fsjson_1.writeJson)(runAgentFile(cwd, runId, id), claim);
    // Deliberately NOT writeState() here. Parallel subagents self-heal their claims
    // near-simultaneously on their first writes, and writeState does a non-atomic
    // read-modify-rewrite of the shared .one.json — concurrent calls would clobber it.
    // The per-thread claim file written above is the source of truth, and
    // runIdsForLookup() scans the runs/ dir on disk, so resolution needs no
    // currentRunId/spawnIndex stamp (the orchestrator already stamps currentRunId
    // during onboarding; nextSpawnIndex counts claim files on disk).
    return contextFromClaim(claim, 'subagent-start');
}
function hasRunAgentState(cwd, state) {
    const s = (0, obj_1.obj)(state);
    const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId : null;
    if (!runId)
        return false;
    return fs.existsSync(runDir(cwd, runId));
}
function legacyRunAgentContext(state) {
    if (!(0, materialization_1.isSubagentSession)(state))
        return null;
    const role = (0, materialization_1.activeAgentRole)(state);
    if (!role)
        return null;
    const s = (0, obj_1.obj)(state) || {};
    return {
        source: 'legacy-state',
        runId: s.currentRunId,
        role,
        spawnIndex: (0, materialization_1.getSpawnIndex)(state, role) || 1,
        sessionId: null,
        claimId: null,
    };
}
