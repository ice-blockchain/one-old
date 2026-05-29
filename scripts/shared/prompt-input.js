"use strict";
// src/shared/prompt-input.ts
// Extracts the user's prompt text from a UserPromptSubmit hook payload (host
// field-name variants). Ported 1:1 from promptTextFromSubmit (_helpers.cjs).
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptTextFromSubmit = promptTextFromSubmit;
const fsjson_1 = require("./fsjson");
function promptTextFromSubmit(rawInput) {
    const payload = typeof rawInput === 'string' ? (0, fsjson_1.parseJson)(rawInput, {}) : rawInput || {};
    const candidates = [payload.prompt, payload.user_prompt, payload.userPrompt, payload.message, payload.text];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim())
            return candidate;
    }
    return '';
}
