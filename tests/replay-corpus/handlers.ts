// tests/replay-corpus/handlers.ts
// Loads the REAL runtime handlers the same way core/dispatch.ts does — no
// synthetic gates, no central map — so the corpus exercises exactly what a
// live hook invocation would. Loaded once and reused by every case (module
// discovery + require() is not free, and every case is otherwise cheap).

import { collectHandlers, defaultModulesDir, loadModules } from '../../src/core/registry';
import type { Handler } from '../../src/core/types';

let cached: Handler[] | null = null;

export function replayHandlers(): Handler[] {
  if (!cached) {
    const modules = loadModules(defaultModulesDir(), { strict: true });
    cached = collectHandlers(modules);
  }
  return cached;
}

/**
 * Handler ids whose `run` was actually INVOKED, accumulated across every replay
 * in this process.
 *
 * The snapshot can only ever name the handler that produced the WINNING verdict,
 * so "how many handlers does the corpus reach?" is not answerable from it: a
 * gate that ran and returned noop is indistinguishable from one the dispatcher
 * filtered out by tool class. The coverage meter needs the difference — a
 * handler nothing invokes is protected by nothing, whether or not it denies —
 * so instrumentedHandlers() wraps each real handler's `run` and records the id.
 *
 * The wrapper is applied ONLY by the coverage test, never by the snapshot run:
 * it returns a fresh array of fresh objects, and the snapshot must run the
 * handler objects the registry produced, untouched.
 */
export function instrumentedHandlers(seen: Set<string>): Handler[] {
  return replayHandlers().map((h) => ({
    ...h,
    run: (ctx: Parameters<Handler['run']>[0]) => {
      seen.add(h.id);
      return h.run(ctx);
    },
  }));
}
