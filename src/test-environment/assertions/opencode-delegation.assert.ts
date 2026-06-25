// opencode-delegation: openCodeDelegationActive() reflects the case's intent.
// Delegation is double-gated (openCode.enabled AND a stamped toolchain version),
// so "on" requires both seeds; this asserts the gate computes the expected value.

import type { Assertion } from '../core/types';
import { openCodeDelegationActive } from '../../shared/performance';
import { effState, result } from './util';

export const assertion: Assertion = {
  id: 'opencode-delegation',
  title: 'OpenCode delegation gate matches selection',
  appliesTo: (c) => c.preSeed.openCode !== undefined,
  run: (ctx) => {
    const ps = ctx.testCase.preSeed;
    const expected = ps.openCode === true && ps.openCodeInstalled === true;
    const actual = openCodeDelegationActive(effState(ctx));
    if (expected === actual) {
      return result(ctx, 'PASS', `Delegation active=${actual} (enabled=${ps.openCode}, installed=${!!ps.openCodeInstalled}).`);
    }
    return result(ctx, 'FAIL', `Delegation active mismatch: expected ${expected}, got ${actual}.`, { expected, actual });
  },
};
