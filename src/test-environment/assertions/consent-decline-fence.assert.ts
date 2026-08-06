// consent-decline-fence: a user who says NO gets a project Traffic One never
// touches — and can still build in it.
//
// The other half of the fence, which no composed test covered. Every other case
// in this suite is an opted-in project, so the suite proved the fence OPENS and
// said nothing about it CLOSING. That asymmetry is why a fence hard-coded
// permissive would have kept the whole suite green.
//
// Four separate promises, each able to break on its own:
//   1. the answer is durable and negative (pluginUseDeclined);
//   2. the pre-answer runtime residue is swept
//      (removeDeclinedProjectArtifacts) — a decline that leaves an activity log
//      behind is not a decline;
//   3. `<project>/.traffic-one/**` is empty after every hook entry point AND the
//      real materialization have run against the freshly built plugin root;
//   4. ordinary development work is still ALLOWED. An opt-out that turns into a
//      lockout is the worse failure of the two, and nothing else here would
//      notice it.

import { caseConsent } from '../core/consent';
import type { Assertion } from '../core/types';
import { readDeclineProbe, rec, result, str } from './util';

export const assertion: Assertion = {
  id: 'consent-decline-fence',
  title: 'A declined project stays untouched and still builds',
  appliesTo: (c) => caseConsent(c.consent) === 'decline',
  run: (ctx) => {
    const probe = readDeclineProbe(ctx);
    if (!probe) return result(ctx, 'FAIL', 'No decline probe was persisted — the decline sequence never ran.');
    if (probe.ok !== true) {
      return result(ctx, 'FAIL', `The decline probe could not complete: ${str(probe.failure) || 'unknown failure'}`);
    }

    const consent = rec(probe.consent);
    const recorded = rec(consent.recorded);
    if (recorded.enabled !== false || consent.declined !== true) {
      return result(ctx, 'FAIL', `The decline is not on record: readPluginUseChoice=${JSON.stringify(consent.recorded)}, pluginUseDeclined=${String(consent.declined)}.`, {
        expected: { enabled: false, declined: true },
        actual: { recorded: consent.recorded, declined: consent.declined },
      });
    }
    const output = str(consent.declineOutput) ?? '';
    if (!output.includes('TRAFFIC_ONE_DISABLED')) {
      return result(ctx, 'FAIL', `The runner's \`--decline\` output no longer carries the TRAFFIC_ONE_DISABLED token the agent reads:\n\n${output.slice(0, 300)}`);
    }

    if (consent.writesPermitted !== false || consent.stateWriteAllowed !== false) {
      return result(ctx, 'FAIL', `A recorded NO left the fence open: projectWritesPermitted=${String(consent.writesPermitted)}, projectStateWriteAllowed(.one.json)=${String(consent.stateWriteAllowed)}.`, {
        expected: { writesPermitted: false, stateWriteAllowed: false },
        actual: { writesPermitted: consent.writesPermitted, stateWriteAllowed: consent.stateWriteAllowed },
      });
    }
    if (str(consent.probe) !== 'refused') {
      return result(ctx, 'FAIL', 'A write through shared/fsjson at a path inside `.traffic-one/` LANDED on a declined project — the chokepoint is not honouring the fence.', {
        expected: 'refused',
        actual: consent.probe,
      });
    }

    const surviving = Array.isArray(probe.residueSurviving) ? probe.residueSurviving.map(String) : [];
    if (surviving.length > 0) {
      return result(ctx, 'FAIL', `removeDeclinedProjectArtifacts left ${surviving.length} pre-decline runtime file(s) in place: ${surviving.join(', ')}. Keeping a project's answers is defensible; keeping a transcript of its activity after the user said no is not.`, {
        expected: [],
        actual: surviving,
      });
    }

    const entries = Array.isArray(probe.stateDirEntries) ? probe.stateDirEntries.map(String) : [];
    if (entries.length > 0) {
      return result(ctx, 'FAIL', `A declined project carries ${entries.length} path(s) under \`.traffic-one/\` after every hook entry point and the real materialization ran: ${entries.slice(0, 20).join(', ')}${entries.length > 20 ? ` (+${entries.length - 20} more)` : ''}.`, {
        expected: [],
        actual: entries,
      });
    }

    const materialization = rec(probe.materialization);
    if (Number(materialization.rules) > 0 || Number(materialization.skills) > 0) {
      return result(ctx, 'FAIL', `materializeProjectFromState produced ${String(materialization.rules)} rule(s) and ${String(materialization.skills)} skill(s) on a declined project (status ${String(materialization.status)}).`, {
        expected: { rules: 0, skills: 0 },
        actual: materialization,
      });
    }

    const ordinary = rec(probe.ordinaryWrite);
    if (ordinary.allowed !== true) {
      return result(ctx, 'FAIL', `Ordinary development work was DENIED on a declined project (${String(ordinary.path)}). The opt-out silences Traffic One; it must never block the user's own build:\n\n${str(ordinary.reason) || '(no reason recorded)'}`, {
        expected: 'allowed',
        actual: ordinary.reason,
      });
    }

    const calls = Array.isArray(probe.hookCalls) ? probe.hookCalls.map((row) => rec(row)) : [];
    const nonZero = calls.filter((row) => Number(row.exitCode) !== 0);
    if (calls.length === 0 || nonZero.length > 0) {
      return result(ctx, 'FAIL', `${calls.length === 0 ? 'No hook entry point was driven' : `${nonZero.length} hook entry point(s) did not exit 0`} — the always-exit-0 contract must hold on a declined project too.`, {
        expected: 'every entry point exits 0',
        actual: nonZero.map((row) => `${String(row.subcommand)}=${String(row.exitCode)}`),
      });
    }

    return result(ctx, 'PASS', `Decline is durable (pluginUseDeclined, TRAFFIC_ONE_DISABLED), ${(Array.isArray(probe.residuePlanted) ? probe.residuePlanted.length : 0)} pre-decline residue file(s) were swept, \`.traffic-one/\` is absent after ${calls.length} hook entry point(s) + materialization (status ${String(materialization.status)}, 0 rules), and an ordinary write to ${String(ordinary.path)} was allowed.`);
  },
};
