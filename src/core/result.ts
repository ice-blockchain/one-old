// src/core/result.ts
// Builders + merge for the canonical HookResult. Keeping construction here means
// handlers never assemble host-shaped output by hand.

import type { HookResult } from './types';

export const noop = (): HookResult => ({ kind: 'noop' });

export const context = (text: string): HookResult =>
  text && text.trim() ? { kind: 'context', context: text } : { kind: 'noop' };

export const deny = (reason: string, extraContext?: string): HookResult =>
  extraContext && extraContext.trim()
    ? { kind: 'deny', reason, context: extraContext }
    : { kind: 'deny', reason };

export function isDeny(
  result: HookResult,
): result is Extract<HookResult, { kind: 'deny' }> {
  return result.kind === 'deny';
}

// Merge results from multiple handlers: the first deny wins (short-circuit
// semantics — mirrors today's runBeforeShell). Otherwise concatenate every
// context string; if none, noop.
export function mergeResults(results: readonly HookResult[]): HookResult {
  for (const result of results) {
    if (isDeny(result)) return result;
  }
  const contexts = results.flatMap((result) =>
    result.kind === 'context' ? [result.context] : [],
  );
  return contexts.length > 0 ? { kind: 'context', context: contexts.join('\n\n') } : { kind: 'noop' };
}
