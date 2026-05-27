// src/core/pipeline.ts
// Chain-of-responsibility gate/handler pipeline. Replaces the 5 separate
// PreToolUse processes + the 750-line gates.cjs: handlers matching the input's
// (event, tool class) run in ascending-priority order, a deny short-circuits the
// rest, and the surviving context results are merged.

import type { Ctx, Handler, HookResult } from './types';
import { handlerMatches } from './events';
import { isDeny, mergeResults } from './result';

export function selectHandlers(handlers: readonly Handler[], ctx: Ctx): Handler[] {
  return handlers
    .filter((handler) => handlerMatches(handler, ctx.input))
    .sort((a, b) => a.priority - b.priority);
}

export async function runPipeline(handlers: readonly Handler[], ctx: Ctx): Promise<HookResult> {
  const collected: HookResult[] = [];
  for (const handler of selectHandlers(handlers, ctx)) {
    const result = await handler.run(ctx);
    if (isDeny(result)) return result; // short-circuit
    collected.push(result);
  }
  return mergeResults(collected);
}
