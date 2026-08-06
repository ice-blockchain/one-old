// consent-fence: the ask-first answer is on record and the write fence is OPEN
// for this project.
//
// The assertion that would have named the regression this file was added for.
// When the consent fence went default-closed, every case ran pre-consent and 104
// assertions reported a product failure — "materialization produced no rules",
// "state: expected new-project, got null", "no writes at all" — none of which
// names the cause. One un-answered question read as a broken product.
//
// It checks BOTH halves on purpose:
//   - the answer is on record, in the PER-CASE prefs file (a case that wrote the
//     maintainer's real ~/.traffic-one/projects/<hash> would be isolation
//     broken, not consent proven);
//   - the fence agrees, and a real round trip through the declared IO chokepoint
//     at a path inside `.traffic-one/` LANDED. The predicate alone would prove
//     the predicate; the round trip proves the chokepoint is still wired to it.

import { caseConsent } from '../core/consent';
import type { Assertion } from '../core/types';
import { readCaseConsent, rec, result, str } from './util';

export const assertion: Assertion = {
  id: 'consent-fence',
  title: 'The use-plugin answer is recorded and project writes are permitted',
  appliesTo: (c) => caseConsent(c.consent) === 'use',
  run: (ctx) => {
    const fact = readCaseConsent(ctx);
    if (!fact) {
      return result(ctx, 'FAIL', 'No consent record was persisted — the harness never answered the ask-first use-plugin question, so every write under `<project>/.traffic-one/**` is refused by the default-closed fence and nothing downstream can succeed.');
    }

    const recorded = rec(fact.recorded);
    if (recorded.enabled !== true) {
      return result(ctx, 'FAIL', `The use-plugin choice did not reach the per-user prefs: readPluginUseChoice reports ${JSON.stringify(fact.recorded)}. The runner's \`--use\` handler ran but nothing was recorded.`, {
        expected: { enabled: true },
        actual: fact.recorded,
      });
    }
    if (str(recorded.source) !== 'command') {
      return result(ctx, 'FAIL', `The choice was recorded with source \`${String(recorded.source)}\`, not \`command\` — it did not come through the onboarding runner's \`--use\` path.`, {
        expected: 'command',
        actual: recorded.source,
      });
    }

    if (fact.prefsIsolated !== true) {
      return result(ctx, 'FAIL', `The answer landed at ${str(fact.prefsPath) || '(unset)'}, which is not inside this case's folder. A case that records consent outside its own prefs file mutates the maintainer's machine.`, {
        expected: `${ctx.caseFolder}/state/preferences.json`,
        actual: fact.prefsPath,
      });
    }

    if (fact.writesPermitted !== true || fact.stateWriteAllowed !== true) {
      return result(ctx, 'FAIL', `Consent is on record but the fence still refuses this project: projectWritesPermitted=${String(fact.writesPermitted)}, projectStateWriteAllowed(.one.json)=${String(fact.stateWriteAllowed)}. A recorded yes that does not open the fence deadlocks every write under \`.traffic-one/\`.`, {
        expected: { writesPermitted: true, stateWriteAllowed: true },
        actual: { writesPermitted: fact.writesPermitted, stateWriteAllowed: fact.stateWriteAllowed },
      });
    }

    if (str(fact.probe) !== 'landed') {
      return result(ctx, 'FAIL', `The fence predicate says yes but a real write through shared/fsjson at a path inside \`.traffic-one/\` was REFUSED. The chokepoint and the predicate disagree.`, {
        expected: 'landed',
        actual: fact.probe,
      });
    }

    return result(ctx, 'PASS', `The use-plugin answer is recorded (enabled=true, source=command) in this case's isolated prefs, the fence permits project writes, and a probe write through shared/fsjson inside \`.traffic-one/\` landed.`);
  },
};
