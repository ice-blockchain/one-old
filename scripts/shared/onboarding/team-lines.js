"use strict";
// src/shared/onboarding/team-lines.ts
// Renders the subagent role → tier → per-host model line-up for the Team
// Confirmation popup + chat fallback. Pure (config + model-tier lookups only).
// Ported 1:1 from resolveTeamTiers/renderTeamLines (agents-team-confirmation-prompt.cjs).
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTeamTiers = resolveTeamTiers;
exports.renderTeamLines = renderTeamLines;
const model_tiers_1 = require("../model-tiers");
const performance_config_1 = require("../performance-config");
// Effective tier map for a level after applying user overrides. Overrides that
// don't match a configured role, or aren't a canonical tier, are ignored.
function resolveTeamTiers(level, overrides) {
    const cfg = performance_config_1.PERFORMANCE_CONFIG[level];
    if (!cfg || !cfg.agents)
        return {};
    const ov = overrides && typeof overrides === 'object' ? overrides : null;
    const out = {};
    for (const [role, roleCfg] of Object.entries(cfg.agents)) {
        let tier = roleCfg.tier;
        if (ov) {
            const canonical = (0, model_tiers_1.canonicalTier)(ov[role]);
            if (canonical)
                tier = canonical;
        }
        out[role] = tier;
    }
    return out;
}
// Plain-text role lines, shared by the popup directive and the chat fallback so
// the wording stays in sync.
function renderTeamLines(level, overrides) {
    const tiers = resolveTeamTiers(level, overrides);
    const ov = overrides && typeof overrides === 'object' ? overrides : null;
    return Object.entries(tiers).map(([role, tier]) => {
        const t = (0, model_tiers_1.tierModelTable)(tier);
        const overridden = ov && ov[role] ? ' (override)' : '';
        const cols = t ? `${t.tier}${overridden} → claude:${t.claude} · codex:${t.codex} · cursor:${t.cursor}` : String(tier);
        return `  ${role}: ${cols}`;
    });
}
