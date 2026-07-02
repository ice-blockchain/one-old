// onboarding-complete: the gate would clear — for new-project the predicate
// reports complete; for existing the local prefs are done. Reuses the real
// predicate so it tracks the plugin's own definition of "onboarded".

import type { Assertion } from '../core/types';
import { isNewProjectOnboardingIncomplete } from '../../shared/onboarding/predicates';
import { effState, result } from './util';

export const assertion: Assertion = {
  id: 'onboarding-complete',
  title: 'Onboarding is complete',
  appliesTo: () => true,
  run: (ctx) => {
    const s = effState(ctx);
    const confirmed = s.confirmed === true;
    const complete = s.onboardingComplete === true;

    if (ctx.testCase.preSeed.mode === 'new-project') {
      const incomplete = isNewProjectOnboardingIncomplete(s);
      if (!incomplete && confirmed && complete) {
        return result(ctx, 'PASS', 'New-project onboarding reports complete (predicate + flags).');
      }
      return result(ctx, 'FAIL', `Onboarding not complete: incompletePredicate=${incomplete}, confirmed=${confirmed}, onboardingComplete=${complete}`);
    }

    if (confirmed && complete) {
      return result(ctx, 'PASS', 'Existing-codebase onboarding reports complete.');
    }
    return result(ctx, 'FAIL', `Onboarding not complete: confirmed=${confirmed}, onboardingComplete=${complete}`);
  },
};
