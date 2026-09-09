// src/test-environment/core/run-sim/expect-deny.ts
// Shared predicate for expectDeny rows: a runtime crash or an unnamed handler
// must never read as correct enforcement. denyMatch (reason text) is a
// separate pin and lives at the assertion layer.

import type { WriteOutcome } from './types';

export const PIPELINE_HANDLER_CRASHED = 'pipeline-handler-crashed';

export type ExpectDenyFields = Pick<
  WriteOutcome,
  'denied' | 'denyId' | 'gateId' | 'path' | 'expectHandler'
>;

/**
 * Why this expected-deny outcome is not valid enforcement, or null when it is.
 * applyAll treats a non-null return as a failed row (same as an unexpected
 * allow). Assertions re-run the same questions against the persisted transcript.
 */
export function expectDenyGap(outcome: ExpectDenyFields): string | null {
  if (outcome.denied !== true) {
    return `a gate that must deny allowed ${outcome.path}`;
  }
  if (outcome.denyId === PIPELINE_HANDLER_CRASHED) {
    return `pipeline-handler-crashed on ${outcome.path} (handler ${outcome.gateId ?? 'unnamed'}) is a runtime crash, not enforcement`;
  }
  if (typeof outcome.gateId !== 'string' || !outcome.gateId) {
    return `deny of ${outcome.path} named no producing handler`;
  }
  const expected = outcome.expectHandler;
  if (typeof expected === 'string' && expected && outcome.gateId !== expected) {
    return `deny of ${outcome.path} came from ${outcome.gateId}, expected ${expected}`;
  }
  return null;
}
