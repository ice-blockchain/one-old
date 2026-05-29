"use strict";
// src/shared/onboarding/perf-directives.ts
// Per-performance-level directives injected into SessionStart: LOW (main-agent
// role checklist), BALANCED + HIGH (subagent team line-ups). The prose lives in
// the onboarding-gate SKILL.md; the dynamic role checklist / agent line-up come
// from PERFORMANCE_CONFIG + renderTeamLines and are passed in as vars.
Object.defineProperty(exports, "__esModule", { value: true });
exports.lowModeDirective = lowModeDirective;
exports.balancedModeDirective = balancedModeDirective;
exports.highModeDirective = highModeDirective;
exports.performanceLevelDirective = performanceLevelDirective;
exports.performancePopupBlock = performancePopupBlock;
exports.teamConfirmationPopupBlock = teamConfirmationPopupBlock;
const performance_config_1 = require("../performance-config");
const team_lines_1 = require("./team-lines");
const DEFAULT_LOW_ROLES = ['senior-architect', 'senior-frontend', 'senior-backend', 'senior-reviewer', 'senior-tester'];
function lowModeDirective(block) {
    const config = performance_config_1.PERFORMANCE_CONFIG.low;
    const agents = (config && config.agents) || {};
    const roles = Object.keys(agents).length > 0 ? Object.keys(agents) : DEFAULT_LOW_ROLES;
    const checklist = roles.map((r) => `- [ ] ${r}`).join('\n');
    return block('perf-low', { CHECKLIST: checklist });
}
function balancedModeDirective(overrides, block) {
    const agentLines = (0, team_lines_1.renderTeamLines)('balanced', overrides).join('\n');
    return block('perf-balanced', { AGENT_LINES: agentLines });
}
function highModeDirective(overrides, block) {
    const agentLines = (0, team_lines_1.renderTeamLines)('high', overrides).join('\n');
    return block('perf-high', { AGENT_LINES: agentLines });
}
function performanceLevelDirective(level, overrides, block) {
    switch (level) {
        case 'low': return lowModeDirective(block);
        case 'balanced': return balancedModeDirective(overrides, block);
        case 'high': return highModeDirective(overrides, block);
        default: return '';
    }
}
// SessionStart "popup 1": the Performance preflight.
function performancePopupBlock(block) {
    return block('performance-popup', {});
}
// SessionStart "popup 2": the Team Confirmation preflight, with the canonical
// HIGH/BALANCED role line-up tables rendered from the config and passed as vars.
function teamConfirmationPopupBlock(block) {
    const highRows = (0, team_lines_1.renderTeamLines)('high').join('\n');
    const balancedRows = (0, team_lines_1.renderTeamLines)('balanced').join('\n');
    return block('team-confirmation-popup', { HIGH_ROWS: highRows, BALANCED_ROWS: balancedRows });
}
