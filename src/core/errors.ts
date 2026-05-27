// src/core/errors.ts
// Fail-closed wrapper preserving today's "always exit 0" contract: a hook throw
// must never propagate to the host. SessionStart additionally gets a safe
// fallback (the auth/detect-project guidance) so a crashed session-start still
// emits useful context instead of nothing.

import type { CanonicalEvent, HookResult } from './types';

export async function failClosed(
  event: CanonicalEvent,
  run: () => Promise<HookResult> | HookResult,
  onError: (event: CanonicalEvent, error: unknown) => HookResult,
): Promise<HookResult> {
  try {
    return await run();
  } catch (error) {
    try {
      return onError(event, error);
    } catch {
      return { kind: 'noop' };
    }
  }
}
