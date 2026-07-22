// Stable provenance for Traffic One context serialized through Codex hooks.
// Codex currently records hook-provided context as generic developer messages,
// so the doctor cannot otherwise distinguish it from project instructions.

import type { CanonicalEvent } from '../core/types';

export type CodexHookEvent = Extract<CanonicalEvent,
  'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'SubagentStart'>;

const CODEX_HOOK_EVENTS = new Set<CodexHookEvent>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
]);

export function isCodexHookEvent(value: unknown): value is CodexHookEvent {
  return typeof value === 'string' && CODEX_HOOK_EVENTS.has(value as CodexHookEvent);
}

export function codexHookEvidenceMarker(event: CodexHookEvent): string {
  return `<!-- traffic-one-hook-context:v1 event=${event} -->`;
}

export function markCodexHookContext(event: CodexHookEvent, context: string): string {
  if (!context.trim()) return context;
  if (codexHookEvidenceEvent(context)) return context;
  const marker = codexHookEvidenceMarker(event);
  return `${marker}\n${context}`;
}

export function codexHookEvidenceEvent(text: string): CodexHookEvent | null {
  const match = text.trimStart().match(/^<!--[ \t]+traffic-one-hook-context:v1[ \t]+event=(SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|SubagentStart)[ \t]+-->/);
  return match && isCodexHookEvent(match[1]) ? match[1] : null;
}

export function hasCodexHookEvidenceMarker(text: string): boolean {
  return codexHookEvidenceEvent(text) !== null;
}
