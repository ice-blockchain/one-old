// host-triage-rubric: the maintenance routing rubric actually reached the
// session.
//
// Headless hosts (`claude -p`, CI) fire no UserPromptSubmit, so the
// prompt-boundary triage directive never lands there; the onboarding-gate
// completion path compensates by riding the first mutating/spawn call
// (maintenanceTriageFallbackDirective). Both delivery paths burn the SAME
// `maintenance-triage` once-marker under `.traffic-one/runs/.once/`, so the
// marker on disk is delivery evidence that survives the session — asserting on
// transcript text would instead depend on each host's stream format.
//
// This is the regression fence for the observed ep-text-edit failure: a
// headless session that received NO routing guidance improvised, spawned
// quick-fix without bounded scope, and silently gave up.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';
import { producedWork, result } from './util';

export const assertion: Assertion = {
  id: 'host-triage-rubric',
  title: 'The maintenance triage rubric reached the session',
  appliesTo: (c) => c.layer === 'host-e2e' && c.preSeed.mode.startsWith('existing'),
  run: (ctx) => {
    if (!producedWork(ctx)) {
      return result(ctx, 'SKIP', `Host run produced nothing to inspect (${ctx.hostResult.status}).`);
    }
    const onceDir = path.join(ctx.cwd, '.traffic-one', 'runs', '.once');
    let markers: string[] = [];
    try {
      markers = fs.readdirSync(onceDir).filter((name) => name.startsWith('maintenance-triage-'));
    } catch {
      // no .once dir → no marker
    }
    if (markers.length === 0) {
      return result(ctx, 'FAIL', 'No `maintenance-triage` once-marker exists under .traffic-one/runs/.once/ — neither the prompt-boundary directive nor the first-mutating-call fallback delivered the routing rubric, so the session worked blind (the ep-text-edit failure mode).', {
        expected: 'a maintenance-triage-<session> marker',
        actual: [],
      });
    }
    return result(ctx, 'PASS', `The maintenance routing rubric was delivered (${markers.length} marker(s): ${markers.join(', ')}).`);
  },
};
