"use strict";
// src/shared/state/materialization.ts
// Stack fingerprinting, materialization-freshness, and subagent / fix-cycle
// signals. Ported 1:1 from scripts/hook-runtime/state/materialization.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.stackFingerprint = stackFingerprint;
exports.isMaterialized = isMaterialized;
exports.isSubagentSession = isSubagentSession;
exports.activeAgentRole = activeAgentRole;
exports.getSpawnIndex = getSpawnIndex;
exports.isFixCycleSession = isFixCycleSession;
const obj_1 = require("../obj");
const constants_1 = require("./constants");
function stackFingerprint(state) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return 'minimal|none|none|none';
    const mobile = (0, obj_1.obj)(s.mobile);
    return [
        s.stack || 'minimal',
        s.frontend || 'none',
        s.backend || 'none',
        (mobile && mobile.framework) || 'none',
    ].join('|');
}
function isMaterialized(state) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return false;
    if (!s.onboardingComplete)
        return true; // pre-onboarding: don't block
    if (!s.materializedStack)
        return false;
    return s.materializedStack === stackFingerprint(s);
}
function isSubagentSession(state) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return false;
    if (typeof s.currentRunId !== 'string' || !s.currentRunId)
        return false;
    if (!s.materializedStack)
        return false;
    if (s.materializedStack !== stackFingerprint(s))
        return false;
    if (typeof s.materializedAt === 'string') {
        const ageMs = Date.now() - Date.parse(s.materializedAt);
        if (Number.isFinite(ageMs) && ageMs > constants_1.SUBAGENT_STALE_MS)
            return false;
    }
    return true;
}
function activeAgentRole(state) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return null;
    const role = s.activeAgentRole;
    return typeof role === 'string' && constants_1.VALID_AGENT_ROLES.has(role) ? role : null;
}
function getSpawnIndex(state, role) {
    const s = (0, obj_1.obj)(state);
    if (!s)
        return 0;
    const map = (0, obj_1.obj)(s.spawnIndex);
    if (!map)
        return 0;
    const n = map[role];
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}
function isFixCycleSession(state) {
    if (!isSubagentSession(state))
        return false;
    const role = activeAgentRole(state);
    if (!role)
        return false;
    return getSpawnIndex(state, role) > 1;
}
