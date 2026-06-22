// src/core/result.ts
// Builders + merge for the canonical HookResult (now carrying optional
// systemMessage / promptRequest). Handlers never assemble host-shaped output.

import type { HookResult, ResultMeta } from './types';

export const noop = (): HookResult => ({ kind: 'noop' });

export function context(text: string, meta: ResultMeta = {}): HookResult {
  const hasText = Boolean(text && text.trim());
  if (!hasText && meta.systemMessage === undefined && meta.promptRequest === undefined) {
    return { kind: 'noop' };
  }
  return { kind: 'context', context: text || '', ...meta };
}

export function deny(reason: string, opts: { context?: string } & ResultMeta = {}): HookResult {
  const { context: extraContext, ...meta } = opts;
  return {
    kind: 'deny',
    reason,
    ...(extraContext && extraContext.trim() ? { context: extraContext } : {}),
    ...meta,
  };
}

export function isDeny(result: HookResult): result is Extract<HookResult, { kind: 'deny' }> {
  return result.kind === 'deny';
}

// A Cursor user APPROVE/REJECT prompt (the only hook-driven user prompt Cursor supports — via
// `permission:"ask"` on beforeShellExecution). Reuses the `deny` kind so merge/short-circuit
// semantics are unchanged (an unanswered ask blocks, like a deny); the Cursor adapter maps
// `askUser` → `permission:"ask"` on PreToolUse. On Claude/Codex it serializes as a plain deny —
// inert, because the only command it gates is Cursor-only.
export function askUser(question: string, agentMessage: string): HookResult {
  return { kind: 'deny', reason: question, askUser: true, agentMessage };
}

// Merge results: the first deny wins (short-circuit). Otherwise concatenate
// context strings and keep the first systemMessage / promptRequest seen.
export function mergeResults(results: readonly HookResult[]): HookResult {
  for (const result of results) {
    if (isDeny(result)) return result;
  }
  const contexts: string[] = [];
  let systemMessage: string | undefined;
  let promptRequest: unknown;
  for (const result of results) {
    if (result.kind !== 'context') continue;
    if (result.context && result.context.trim()) contexts.push(result.context);
    if (systemMessage === undefined && result.systemMessage !== undefined) systemMessage = result.systemMessage;
    if (promptRequest === undefined && result.promptRequest !== undefined) promptRequest = result.promptRequest;
  }
  if (contexts.length === 0 && systemMessage === undefined && promptRequest === undefined) {
    return { kind: 'noop' };
  }
  return {
    kind: 'context',
    context: contexts.join('\n\n'),
    ...(systemMessage !== undefined ? { systemMessage } : {}),
    ...(promptRequest !== undefined ? { promptRequest } : {}),
  };
}
