// src/shared/prompt-input.ts
// Extracts the user's prompt text from a UserPromptSubmit hook payload (host
// field-name variants). Ported 1:1 from promptTextFromSubmit (_helpers.cjs).

import { parseJson } from './fsjson';

export function promptTextFromSubmit(rawInput: unknown): string {
  const payload = typeof rawInput === 'string' ? parseJson<Record<string, unknown>>(rawInput, {}) : (rawInput as Record<string, unknown>) || {};
  const candidates = [payload.prompt, payload.user_prompt, payload.userPrompt, payload.message, payload.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}
