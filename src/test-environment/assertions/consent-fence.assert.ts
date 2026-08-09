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

// A WORKSPACE case answers per MEMBER, and this assertion follows it there. The
// fence is default-closed per project ROOT, so three members are three
// questions: a single record would let two members ride on a third's yes, and
// the two that never answered would have every `.traffic-one/**` write refused
// while this row reported green. The container of a bare workspace is
// deliberately NOT among the subjects — it is nobody's project, and answering
// for it would mint the very `.traffic-one/` the workspace rows assert is absent
// (see core/case-runner.ts rootIsProject).

import { caseConsent } from '../core/consent';
import type { Assertion, AssertionContext, AssertionResult } from '../core/types';
import type { Rec } from '../../shared/obj';
import { readCaseConsent, readMemberConsent, rec, result, str } from './util';

export const assertion: Assertion = {
  id: 'consent-fence',
  title: 'The use-plugin answer is recorded and project writes are permitted',
  appliesTo: (c) => caseConsent(c.consent) === 'use',
  run: (ctx) => {
    if (ctx.members.length > 0) {
      for (const member of ctx.members) {
        const failure = checkConsentFact(ctx, readMemberConsent(ctx, member.id), `workspace member \`${member.id}\`: `);
        if (failure) return failure;
      }
      // Deliberately does NOT claim the buckets are DISTINCT — this row's subject
      // is that each member ANSWERED and that no answer reached the maintainer's
      // machine. Whether three members got three buckets is
      // workspace-member-state's verdict, and claiming it here would report it
      // green from a row that never checked it.
      return result(ctx, 'PASS',
        `Every one of the ${ctx.members.length} workspace members (${ctx.members.map((m) => m.id).join(', ')}) recorded `
        + "its own use-plugin answer inside this case's isolated prefs, the fence permits project writes for each, and a "
        + "probe write through shared/fsjson inside each member's `.traffic-one/` landed.");
    }
    const failure = checkConsentFact(ctx, readCaseConsent(ctx), '');
    if (failure) return failure;
    return result(ctx, 'PASS', 'The use-plugin answer is recorded (enabled=true, source=command) in this case\'s isolated prefs, the fence permits project writes, and a probe write through shared/fsjson inside `.traffic-one/` landed.');
  },
};

/** The first thing wrong with one consent record, or null when it is sound. */
function checkConsentFact(ctx: AssertionContext, fact: Rec | null, subject: string): AssertionResult | null {
  if (!fact) {
    return result(ctx, 'FAIL', `${subject}No consent record was persisted — the harness never answered the ask-first use-plugin question, so every write under \`<project>/.traffic-one/**\` is refused by the default-closed fence and nothing downstream can succeed.`);
  }

  const recorded = rec(fact.recorded);
  if (recorded.enabled !== true) {
    return result(ctx, 'FAIL', `${subject}The use-plugin choice did not reach the per-user prefs: readPluginUseChoice reports ${JSON.stringify(fact.recorded)}. The runner's \`--use\` handler ran but nothing was recorded.`, {
      expected: { enabled: true },
      actual: fact.recorded,
    });
  }
  if (str(recorded.source) !== 'command') {
    return result(ctx, 'FAIL', `${subject}The choice was recorded with source \`${String(recorded.source)}\`, not \`command\` — it did not come through the onboarding runner's \`--use\` path.`, {
      expected: 'command',
      actual: recorded.source,
    });
  }

  if (fact.prefsIsolated !== true) {
    return result(ctx, 'FAIL', `${subject}The answer landed at ${str(fact.prefsPath) || '(unset)'}, which is not inside this case's folder. A case that records consent outside its own prefs file mutates the maintainer's machine.`, {
      expected: `a preferences bucket under ${ctx.caseFolder}`,
      actual: fact.prefsPath,
    });
  }

  if (fact.writesPermitted !== true || fact.stateWriteAllowed !== true) {
    return result(ctx, 'FAIL', `${subject}Consent is on record but the fence still refuses this project: projectWritesPermitted=${String(fact.writesPermitted)}, projectStateWriteAllowed(.one.json)=${String(fact.stateWriteAllowed)}. A recorded yes that does not open the fence deadlocks every write under \`.traffic-one/\`.`, {
      expected: { writesPermitted: true, stateWriteAllowed: true },
      actual: { writesPermitted: fact.writesPermitted, stateWriteAllowed: fact.stateWriteAllowed },
    });
  }

  if (str(fact.probe) !== 'landed') {
    return result(ctx, 'FAIL', `${subject}The fence predicate says yes but a real write through shared/fsjson at a path inside \`.traffic-one/\` was REFUSED. The chokepoint and the predicate disagree.`, {
      expected: 'landed',
      actual: fact.probe,
    });
  }

  return null;
}
