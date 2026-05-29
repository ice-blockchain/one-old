"use strict";
// src/shared/state/validate.ts
// Validators for onboarding-critical state sub-objects. Ported 1:1 from
// scripts/hook-runtime/state/validate.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasValidPerformanceState = hasValidPerformanceState;
exports.hasResolvedOpenCodeState = hasResolvedOpenCodeState;
exports.hasValidTeamState = hasValidTeamState;
exports.hasValidProjectContext = hasValidProjectContext;
exports.isTeamApproved = isTeamApproved;
exports.hasTechnologyArrays = hasTechnologyArrays;
exports.hasValidMobileState = hasValidMobileState;
exports.hasResolvedNewProjectMobileState = hasResolvedNewProjectMobileState;
exports.trafficOneStateValidationIssues = trafficOneStateValidationIssues;
const config_1 = require("../config");
const performance_1 = require("../performance");
const constants_1 = require("./constants");
const toolchain_1 = require("./toolchain");
function asObject(value) {
    return value && typeof value === 'object' ? value : null;
}
function inSet(set, value) {
    return typeof value === 'string' && set.has(value);
}
function hasValidPerformanceState(performance) {
    const p = asObject(performance);
    return Boolean(p && inSet(constants_1.PERFORMANCE_LEVEL_IDS, p.level) && inSet(constants_1.PERFORMANCE_SOURCE_IDS, p.source));
}
// "Resolved" once the user answered either way: strict-boolean `enabled` + a
// known `source`. "Not now" resolves with enabled:false.
function hasResolvedOpenCodeState(openCode) {
    const o = openCode && typeof openCode === 'object' && !Array.isArray(openCode)
        ? openCode
        : null;
    return Boolean(o && typeof o.enabled === 'boolean' && inSet(constants_1.OPEN_CODE_SOURCE_IDS, o.source));
}
function hasValidTeamState(team) {
    const t = asObject(team);
    return Boolean(t && inSet(constants_1.TEAM_MODE_IDS, t.mode) && inSet(constants_1.TEAM_SOURCE_IDS, t.source));
}
function hasValidProjectContext(projectContext) {
    const c = projectContext && typeof projectContext === 'object' && !Array.isArray(projectContext)
        ? projectContext
        : null;
    if (!c)
        return false;
    const answers = c.answers;
    return Boolean(typeof c.source === 'string' && c.source.trim() !== ''
        && typeof c.originalPrompt === 'string'
        && typeof c.summary === 'string' && c.summary.trim() !== ''
        && answers && typeof answers === 'object' && !Array.isArray(answers)
        && typeof c.collectedAt === 'string' && c.collectedAt.trim() !== '');
}
// team.approved === true means the user explicitly Approved the line-up — the
// spawn gate enforces this so the model can't bypass confirmation.
function isTeamApproved(team) {
    const t = asObject(team);
    return Boolean(t && t.approved === true);
}
function hasTechnologyArrays(technologies) {
    const t = asObject(technologies);
    return Boolean(t && Array.isArray(t.frontend) && Array.isArray(t.backend) && Array.isArray(t.mobile));
}
function hasValidMobileState(mobile) {
    const m = asObject(mobile);
    return Boolean(m
        && typeof m.enabled === 'boolean'
        && inSet(constants_1.MOBILE_FRAMEWORK_IDS, m.framework)
        && inSet(constants_1.MOBILE_SOURCE_IDS, m.source));
}
// "Resolved" for a new project: a valid mobile object whose source is not "none"
// (i.e. the Mobile App prompt was actually answered).
function hasResolvedNewProjectMobileState(mobile) {
    const m = asObject(mobile);
    return hasValidMobileState(mobile) && Boolean(m && m.source !== 'none');
}
function formatStateValue(value) {
    return typeof value === 'string' ? `"${value}"` : String(value);
}
function idList(set) {
    return [...set].map((id) => `\`${id}\``).join(' · ');
}
// Full new-project readiness validator. Returns a list of human-readable issues
// (empty array == ready to materialize). Ported 1:1 from _helpers.cjs.
function trafficOneStateValidationIssues(state, validCodeGraphProviders = ['gitnexus', 'graphify']) {
    const issues = [];
    const s = asObject(state);
    if (!s)
        return ['`.traffic-one/.one.json` must contain a JSON object.'];
    if (!s.stack) {
        issues.push('`stack` is missing.');
    }
    else if (typeof s.stack !== 'string' || !config_1.STACK_IDS.has(s.stack)) {
        issues.push(`\`stack\` is ${formatStateValue(s.stack)}; valid values: ${idList(config_1.STACK_IDS)}.`);
    }
    if (!s.frontend) {
        issues.push('`frontend` is missing.');
    }
    else if (typeof s.frontend !== 'string' || !constants_1.FRONTEND_IDS.has(s.frontend)) {
        issues.push(`\`frontend\` is ${formatStateValue(s.frontend)}; valid values: ${idList(constants_1.FRONTEND_IDS)}.`);
    }
    if (!s.backend) {
        issues.push('`backend` is missing.');
    }
    else if (typeof s.backend !== 'string' || !constants_1.BACKEND_IDS.has(s.backend)) {
        issues.push(`\`backend\` is ${formatStateValue(s.backend)}; valid values: ${idList(constants_1.BACKEND_IDS)}.`);
    }
    const mobile = asObject(s.mobile);
    if (!mobile) {
        issues.push('`mobile` must be an object with `enabled`, `framework`, and `source`.');
    }
    else {
        if (typeof mobile.enabled !== 'boolean') {
            issues.push(`\`mobile.enabled\` is ${formatStateValue(mobile.enabled)}; expected boolean.`);
        }
        if (typeof mobile.framework !== 'string' || !constants_1.MOBILE_FRAMEWORK_IDS.has(mobile.framework)) {
            issues.push(`\`mobile.framework\` is ${formatStateValue(mobile.framework)}; valid values: ${idList(constants_1.MOBILE_FRAMEWORK_IDS)}.`);
        }
        if (typeof mobile.source !== 'string' || !constants_1.MOBILE_SOURCE_IDS.has(mobile.source)) {
            issues.push(`\`mobile.source\` is ${formatStateValue(mobile.source)}; valid values: ${idList(constants_1.MOBILE_SOURCE_IDS)}.`);
        }
        else if (s.mode === 'new-project' && mobile.source === 'none') {
            issues.push('`mobile.source` must be `prompted` or `explicit` after the Mobile App prompt for new-project onboarding.');
        }
    }
    if (!hasTechnologyArrays(s.technologies)) {
        issues.push('`technologies` must contain `frontend`, `backend`, and `mobile` arrays.');
    }
    if (s.mode === 'new-project' && !hasValidProjectContext(s.projectContext)) {
        issues.push('`projectContext` must be an object with `source`, `originalPrompt`, `summary`, `answers`, and `collectedAt`.');
    }
    if (s.mode === 'new-project' && !hasValidTeamState(s.team)) {
        issues.push(`\`team\` must be an object with valid \`mode\` (${idList(constants_1.TEAM_MODE_IDS)}) and \`source\` (${idList(constants_1.TEAM_SOURCE_IDS)}).`);
    }
    if (s.mode === 'new-project' && !hasValidPerformanceState(s.performance)) {
        issues.push(`\`performance\` must be an object with valid \`level\` (${idList(constants_1.PERFORMANCE_LEVEL_IDS)}) and \`source\` (\`prompted\` · \`explicit\`).`);
    }
    if (s.mode === 'new-project' && hasValidPerformanceState(s.performance) && hasValidTeamState(s.team)) {
        const perf = asObject(s.performance);
        const team = asObject(s.team);
        const expectedTeamMode = (0, performance_1.teamModeForLevel)(perf ? String(perf.level) : '');
        if (team && team.mode !== expectedTeamMode) {
            issues.push(`\`team.mode\` is ${formatStateValue(team.mode)} but performance.level=${formatStateValue(perf?.level)} requires ${formatStateValue(expectedTeamMode)}.`);
        }
        if (expectedTeamMode === 'subagents' && !isTeamApproved(s.team)) {
            issues.push('`team.approved` must be true after Team Confirmation before balanced/high subagents can run.');
        }
    }
    const cgProvider = typeof s.codeGraphProvider === 'string' ? s.codeGraphProvider : '';
    if (!cgProvider) {
        issues.push('`codeGraphProvider` is missing.');
    }
    else if (!validCodeGraphProviders.includes(cgProvider)) {
        issues.push(`\`codeGraphProvider\` is ${formatStateValue(cgProvider)}; valid values: ${validCodeGraphProviders.map((id) => `\`${id}\``).join(' · ')}.`);
    }
    if (!(0, toolchain_1.hasInitializedToolchain)(s.toolchain)) {
        issues.push('`toolchain` must include initialized entries for every tracked tool.');
    }
    if (s.confirmed !== true) {
        issues.push('`confirmed` must be true.');
    }
    if (s.onboardingComplete !== true) {
        issues.push('`onboardingComplete` must be true.');
    }
    if (typeof s.confirmedAt !== 'string' || s.confirmedAt.trim() === '') {
        issues.push('`confirmedAt` must be a non-empty ISO-8601 string.');
    }
    return issues;
}
