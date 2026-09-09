// src/test-environment/core/case-selection.ts
// Which cases a given invocation of `npm run test:env` actually reaches, and
// which of those a given assertion is actually measured on.
//
// This exists because run.ts calls main() at module load, so nothing can import
// selectRuns() from a test without starting a real harness run. Every consumer
// that wanted the question therefore RESTATED the conditions, and a restatement
// drifts: the copy in config/cases/delegation-channel.test.ts carried two of the
// three and silently omitted `caseFilter`, so a committed `--case=` invocation
// would have deselected the case a coverage floor was measuring while the floor
// stayed green — the floor asking about a run nobody runs.
//
// run.ts's selectRuns() now calls caseSelectedByRun() rather than inlining it,
// so there is one implementation and a fourth condition added there reaches every
// floor built on it.

import { caseConsent } from './consent';
import { assertionSpecsForRun } from './case-runner';
import { ALL_CASES } from '../config/cases';
import type { Assertion, Case, HostId, RootTestConfig } from './types';

/**
 * The case-level half of run.ts's selectRuns(): does this invocation reach the
 * case at all? The host-level half (which targets it fans out to) stays in
 * selectRuns, because it is the part that produces the run rather than the part
 * that decides whether there is one.
 */
export function caseSelectedByRun(c: Case, config: RootTestConfig): boolean {
  if (!config.enabledCategories.includes(c.category)) return false;
  if (config.caseFilter && !config.caseFilter.includes(c.id)) return false;
  if (c.layer === 'host-e2e' && !config.includeHostE2E) return false;
  return true;
}

/**
 * Exit 2 when an invocation selected nothing — a usage error, not a green
 * empty run. Used by run.ts after selectRuns and after the execute loop.
 * `--reassert` does not go through this: a prior empty results.json is a
 * different question and must not be relabelled as "no cases selected".
 */
export function usageIfNoCases(planned: { length: number }): number | null {
  return planned.length === 0 ? 2 : null;
}

/**
 * Every case this invocation would actually RUN the given assertion against.
 *
 * Declining a case is not the same as excluding it: a declined case's whole
 * claim is that nothing was written, so it is never seeded, and an assertion
 * measured on one would be reading an unseeded project rather than an answer.
 * Callers that seed and measure need it gone; that is why the filter lives here
 * and not at each call site.
 */
export function casesRunningAssertion(
  assertion: Pick<Assertion, 'id' | 'appliesTo'>,
  config: RootTestConfig,
  target: HostId | 'pure-node' = 'pure-node',
): Case[] {
  return ALL_CASES.filter((c) => (
    caseSelectedByRun(c, config)
    && caseConsent(c.consent) === 'use'
    && assertionSpecsForRun(c, target).some((spec) => spec.id === assertion.id)
    && assertion.appliesTo(c)
  ));
}
