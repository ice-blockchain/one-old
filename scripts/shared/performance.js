"use strict";
// src/shared/performance.ts
// Performance-level → team-mode + per-role model resolution. Ported 1:1 from
// the resolver functions in scripts/hook-runtime/agents-performance-prompt.cjs.
// (The popup/chat PROSE lands in the agent-model module's skill.)
Object.defineProperty(exports, "__esModule", { value: true });
exports.teamModeForLevel = teamModeForLevel;
exports.autoLaunchesTeam = autoLaunchesTeam;
exports.effectiveTierForRole = effectiveTierForRole;
exports.modelForRole = modelForRole;
exports.modelForRoleHost = modelForRoleHost;
const model_tiers_1 = require("./model-tiers");
const performance_config_1 = require("./performance-config");
function teamModeForLevel(level) {
    const cfg = performance_config_1.PERFORMANCE_CONFIG[level];
    return cfg ? cfg.teamMode : 'main-agent';
}
function autoLaunchesTeam(level) {
    return level === 'balanced' || level === 'high';
}
// Effective tier for a role at a level, honoring user `team.overrides`. Null when
// the level has no subagents (low) or the role isn't configured.
function effectiveTierForRole(level, role, overrides) {
    const cfg = performance_config_1.PERFORMANCE_CONFIG[level];
    const agent = cfg ? cfg.agents[role] : undefined;
    if (!agent)
        return null;
    if (overrides && typeof overrides === 'object') {
        const override = (0, model_tiers_1.canonicalTier)(overrides[role]);
        if (override)
            return override;
    }
    return agent.tier;
}
function modelForRole(level, role, overrides) {
    const tier = effectiveTierForRole(level, role, overrides);
    return tier ? (0, model_tiers_1.tierModelTable)(tier) : null;
}
function modelForRoleHost(level, role, host, overrides) {
    const tier = effectiveTierForRole(level, role, overrides);
    return tier ? (0, model_tiers_1.resolveModel)(tier, host) : null;
}
