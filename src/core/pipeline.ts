// src/core/pipeline.ts
// Chain-of-responsibility gate/handler pipeline. Replaces the 5 separate
// PreToolUse processes + the 750-line gates.cjs: handlers matching the input's
// (event, tool class) run in ascending-priority order, a deny short-circuits the
// rest, and the surviving context results are merged.

import type { Ctx, Handler, HookResult } from './types';
import { handlerMatches } from './events';
import { deny, isDeny, mergeResults } from './result';

export function selectHandlers(handlers: readonly Handler[], ctx: Ctx): Handler[] {
  return handlers
    .filter((handler) => handlerMatches(handler, ctx.input))
    .sort((a, b) => a.priority - b.priority);
}

export async function runPipeline(handlers: readonly Handler[], ctx: Ctx): Promise<HookResult> {
  const collected: HookResult[] = [];
  for (const handler of selectHandlers(handlers, ctx)) {
    let result: HookResult;
    try {
      result = await handler.run(ctx);
    } catch (error) {
      // Every host adapter knows how to serialize a canonical deny, but several
      // host entry wrappers historically converted a thrown hook into an empty
      // success response. Never allow a tool merely because a gate crashed.
      if (ctx.input.event === 'PreToolUse') {
        const code = error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string'
          ? ` (${String((error as NodeJS.ErrnoException).code)})`
          : '';
        return deny(`Traffic One ${handler.id} gate failed${code}; this tool call is blocked fail-closed. Retry after resolving the Traffic One setup/plugin error.`);
      }
      throw error;
    }
    if (isDeny(result)) return result; // short-circuit
    collected.push(result);
  }
  return mergeResults(collected);
}
