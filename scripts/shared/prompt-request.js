"use strict";
// src/shared/prompt-request.ts
// Host modal/popup-input request specs. Ported 1:1 from the prompt-request
// builders in scripts/hook-runtime/handlers/_helpers.cjs. Shared by the auth,
// onboarding, and agent-model gates.
Object.defineProperty(exports, "__esModule", { value: true });
exports.singleSelectPromptRequest = singleSelectPromptRequest;
exports.secureTextPromptRequest = secureTextPromptRequest;
exports.authChoicePromptRequest = authChoicePromptRequest;
exports.authApiKeyPromptRequest = authApiKeyPromptRequest;
exports.sessionExpiredPromptRequest = sessionExpiredPromptRequest;
exports.openCodePromptRequest = openCodePromptRequest;
exports.performancePromptRequest = performancePromptRequest;
exports.mobilePromptRequest = mobilePromptRequest;
exports.codeGraphPromptRequest = codeGraphPromptRequest;
exports.teamConfirmationPromptRequest = teamConfirmationPromptRequest;
exports.projectContextPromptRequest = projectContextPromptRequest;
function singleSelectPromptRequest(args) {
    return {
        id: args.id,
        kind: 'single_select',
        title: args.title,
        question: args.question,
        options: args.options,
        blocking: true,
        ...(args.fallbackText ? { fallbackText: args.fallbackText } : {}),
    };
}
function secureTextPromptRequest(args) {
    return {
        id: args.id,
        kind: 'secure_text',
        title: args.title,
        question: args.question,
        blocking: true,
        sensitive: true,
        ...(args.fallbackText ? { fallbackText: args.fallbackText } : {}),
    };
}
function authChoicePromptRequest(fallbackText) {
    return singleSelectPromptRequest({
        id: 'traffic-one.auth.choice',
        title: 'Traffic One',
        question: 'Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin?',
        options: [
            { id: 'authenticate', label: 'Authenticate Traffic One (Recommended)' },
            { id: 'continue_without', label: 'Continue without Traffic One' },
        ],
        ...(fallbackText ? { fallbackText } : {}),
    });
}
function authApiKeyPromptRequest(fallbackText) {
    return secureTextPromptRequest({
        id: 'traffic-one.auth.api-key',
        title: 'Traffic One API Key',
        question: 'Enter your Traffic One API key.',
        ...(fallbackText ? { fallbackText } : {}),
    });
}
function sessionExpiredPromptRequest(fallbackText) {
    return secureTextPromptRequest({
        id: 'traffic-one.auth.session-expired',
        title: 'Traffic One Session Expired',
        question: 'Your Traffic One session expired. Enter your Traffic One API key to re-authenticate.',
        ...(fallbackText ? { fallbackText } : {}),
    });
}
// ── New-project onboarding popup requests (ported 1:1 from _helpers.cjs) ──────
function openCodePromptRequest(fallbackText) {
    return singleSelectPromptRequest({
        id: 'traffic-one.onboarding.open-code',
        title: 'OpenCode',
        question: 'Save tokens with OpenCode and approve hook-owned CLI install/upgrade if needed?',
        options: [
            { id: 'enable', label: 'Enable OpenCode delegation' },
            { id: 'not_now', label: 'Not now' },
        ],
        ...(fallbackText ? { fallbackText } : {}),
    });
}
function performancePromptRequest(fallbackText) {
    return singleSelectPromptRequest({
        id: 'traffic-one.onboarding.performance',
        title: 'Performance',
        question: 'How do you want to run agents for this build?',
        options: [
            { id: 'high', label: 'High (Recommended)' },
            { id: 'balanced', label: 'Balanced' },
            { id: 'low', label: 'Low' },
        ],
        ...(fallbackText ? { fallbackText } : {}),
    });
}
function mobilePromptRequest(fallbackText) {
    return singleSelectPromptRequest({
        id: 'traffic-one.onboarding.mobile',
        title: 'Mobile App',
        question: 'Do you want a mobile app too?',
        options: [
            { id: 'web_only', label: 'Web only (Recommended)' },
            { id: 'ionic_capacitor', label: 'Ionic + Capacitor' },
            { id: 'react_native_expo', label: 'React Native / Expo' },
        ],
        ...(fallbackText ? { fallbackText } : {}),
    });
}
function codeGraphPromptRequest(fallbackText) {
    return singleSelectPromptRequest({
        id: 'traffic-one.onboarding.code-graph',
        title: 'Code Graph',
        question: 'Which provider should Traffic One use and install/upgrade for the codebase graph?',
        options: [
            { id: 'gitnexus', label: 'GitNexus' },
            { id: 'graphify', label: 'graphify' },
        ],
        ...(fallbackText ? { fallbackText } : {}),
    });
}
function teamConfirmationPromptRequest(level, fallbackText) {
    return singleSelectPromptRequest({
        id: 'traffic-one.onboarding.team-confirmation',
        title: 'Team',
        question: `Approve the ${level || 'selected'} team line-up above?`,
        options: [
            { id: 'approve', label: 'Approve' },
            { id: 'repick_performance', label: 'Re-pick performance' },
            { id: 'customise', label: 'Customise' },
        ],
        ...(fallbackText ? { fallbackText } : {}),
    });
}
function projectContextPromptRequest(fallbackText) {
    return {
        id: 'traffic-one.onboarding.project-context',
        kind: 'text',
        title: 'Project Context',
        question: 'Answer the MVP-context questions in one reply so the build plan is complete.',
        blocking: true,
        ...(fallbackText ? { fallbackText } : {}),
    };
}
