"use strict";
// src/shared/prompt-request.ts
// Host modal/popup-input request specs. Shared by the auth + agent-model gates.
// The new-project onboarding popups were removed when onboarding moved into the
// local wizard server — the wizard owns those questions now.
Object.defineProperty(exports, "__esModule", { value: true });
exports.singleSelectPromptRequest = singleSelectPromptRequest;
exports.secureTextPromptRequest = secureTextPromptRequest;
exports.authChoicePromptRequest = authChoicePromptRequest;
exports.authApiKeyPromptRequest = authApiKeyPromptRequest;
exports.sessionExpiredPromptRequest = sessionExpiredPromptRequest;
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
