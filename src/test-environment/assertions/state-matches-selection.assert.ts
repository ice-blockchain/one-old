// state-matches-selection: the persisted .one.json + preferences.json reflect
// exactly the onboarding selection the case declared. Regression guard on the
// state writer/normalizer/splitter.

import type { Assertion } from '../core/types';
import { currentLocalPreferenceTarget } from '../../shared/onboarding/local-prefs';
import { detectHost } from '../../shared/host';
import { effState, rec, str, result } from './util';

export const assertion: Assertion = {
  id: 'state-matches-selection',
  title: 'State matches onboarding selection',
  appliesTo: () => true,
  run: (ctx) => {
    const ps = ctx.testCase.preSeed;
    const s = effState(ctx);
    const mismatches: string[] = [];

    const check = (label: string, expected: unknown, actual: unknown) => {
      if (expected !== undefined && expected !== actual) {
        mismatches.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    };

    check('mode', ps.mode, str(s.mode));
    if (ps.stack) check('stack', ps.stack, str(s.stack));
    if (ps.frontend) check('frontend', ps.frontend, str(s.frontend));
    if (ps.backend) check('backend', ps.backend, str(s.backend));
    if (ps.mobile) check('mobile.framework', ps.mobile.framework, str(rec(s.mobile).framework));
    if (ps.performance) check('performance.level', ps.performance, str(rec(s.performance).level));
    if (ps.team?.mode) check('team.mode', ps.team.mode, str(rec(s.team).mode));
    if (ps.openCode !== undefined) check('openCode.enabled', ps.openCode, rec(s.openCode).enabled === true);
    if (ps.codeGraphProvider) check('codeGraphProvider', ps.codeGraphProvider, str(s.codeGraphProvider));
    if (ps.team?.overrides) {
      const got = rec(rec(s.team).overrides);
      for (const [role, tier] of Object.entries(ps.team.overrides)) {
        check(`team.overrides.${role}`, tier, str(got[role]));
      }
    }
    if (ps.performance) {
      const host = ctx.host === 'pure-node' ? detectHost(ctx.env) : ctx.host;
      const expected = currentLocalPreferenceTarget(host, ctx.env);
      const target = rec(rec(s.performance).target);
      check('performance.target.plan', expected.plan, str(target.plan));
      check('performance.target.appliedFingerprint', expected.appliedFingerprint, str(target.appliedFingerprint));
      check('performance.target.configVersion', expected.configVersion, target.configVersion);
    }

    if (mismatches.length === 0) {
      return result(ctx, 'PASS', 'All declared selections persisted correctly.');
    }
    return result(ctx, 'FAIL', `Mismatches:\n - ${mismatches.join('\n - ')}`, {
      expected: ps,
      actual: { stack: s.stack, frontend: s.frontend, backend: s.backend, mobile: s.mobile, performance: s.performance, team: s.team, openCode: s.openCode, codeGraphProvider: s.codeGraphProvider },
    });
  },
};
