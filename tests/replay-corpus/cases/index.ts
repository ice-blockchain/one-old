// tests/replay-corpus/cases/index.ts
// Aggregates every themed case file into one ordered corpus. Adding a new
// case file means adding one import + one spread here — nothing else in the
// harness changes.

import type { CaseSpec } from '../run-case';
import { SESSION_GUARD_CASES } from './session-guards.cases';
import { CONSENT_FENCE_CASES } from './consent-fence.cases';
import { HANDLER_ORDER_CASES } from './handler-order.cases';
import { ONBOARDING_CASES } from './onboarding.cases';
import { ONE_MCP_CASES, MODEL_CHOICE_CASES } from './one-mcp-and-model-choice.cases';
import { PLAN_GUARD_CASES } from './plan-guard.cases';
import { PLAN_STATIC_CASES } from './plan-static.cases';
import { AGENT_MODEL_CASES } from './agent-model.cases';
import { LIFECYCLE_EVENT_CASES } from './lifecycle-events.cases';
import { HOST_COVERAGE_CASES } from './host-coverage.cases';

export const ALL_CASES: CaseSpec[] = [
  ...SESSION_GUARD_CASES,
  ...CONSENT_FENCE_CASES,
  ...HANDLER_ORDER_CASES,
  ...ONBOARDING_CASES,
  ...ONE_MCP_CASES,
  ...MODEL_CHOICE_CASES,
  ...PLAN_GUARD_CASES,
  ...PLAN_STATIC_CASES,
  ...AGENT_MODEL_CASES,
  ...LIFECYCLE_EVENT_CASES,
  ...HOST_COVERAGE_CASES,
];

export function assertUniqueCaseIds(cases: readonly CaseSpec[]): void {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.id)) throw new Error(`replay-corpus: duplicate case id "${c.id}"`);
    seen.add(c.id);
  }
}
