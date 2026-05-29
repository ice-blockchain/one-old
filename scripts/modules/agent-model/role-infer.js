"use strict";
// src/modules/agent-model/role-infer.ts
// Infer the Traffic One senior-* role from a spawn tool input. Ported 1:1 from
// inferTrafficOneSpawnRole / normalizeSubagentRole in gates.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeSubagentRole = normalizeSubagentRole;
exports.inferTrafficOneSpawnRole = inferTrafficOneSpawnRole;
const state_1 = require("../../shared/state");
function normalizeSubagentRole(subagentType) {
    if (typeof subagentType !== 'string' || !subagentType)
        return null;
    const role = subagentType.includes(':') ? subagentType.split(':').pop() : subagentType;
    return state_1.VALID_AGENT_ROLES.has(role) ? role : null;
}
function inferTrafficOneSpawnRole(toolInput) {
    const direct = normalizeSubagentRole(toolInput.subagent_type || toolInput.subagentType || toolInput.agent || toolInput.role || toolInput.type);
    if (direct)
        return direct;
    const message = [toolInput.message, toolInput.prompt, toolInput.instructions, toolInput.description]
        .filter((value) => typeof value === 'string')
        .join('\n');
    if (!/\bTraffic One\b/i.test(message))
        return null;
    const matches = Array.from(state_1.VALID_AGENT_ROLES).filter((role) => new RegExp(`\\b${role}\\b`, 'i').test(message));
    return matches.length === 1 ? matches[0] : null;
}
