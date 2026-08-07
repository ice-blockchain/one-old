// opencode-delegation: openCodeDelegationActive() reflects the case's intent.
// Delegation is TRIPLE-gated: openCode.enabled, a stamped toolchain version, AND
// a host that is not itself an OpenCode-compatible agent — delegating to OpenCode
// from OpenCode or Kilo is a worker spawning itself, so the product stands the
// whole feature down there (shared/performance.ts, via the `opencodeSelfHosted`
// capability flag; pinned directly in shared/__tests__/performance.test.ts).
//
// The expectation used to read the two seeds only. That was not merely incomplete:
// the two halves of this assertion disagreed about which host they were talking
// about. `actual` resolved the host from the ambient process env — which the case
// runner pins to the case target (core/env.ts buildCaseEnv) — while `expected`
// consulted no host at all. Every case that seeds openCode today is `pure-node`,
// which buildCaseEnv pins to claude, so the two happened to agree and the
// disagreement was invisible. The first delegation-ON case promoted to host-e2e on
// opencode or kilo would have expected true, got false, and reported the product's
// CORRECT self-delegation stand-down as a failure.
//
// The host set is named literally rather than re-derived from hostFlags(): an
// assertion that computes its expectation by calling the code under test cannot
// fail when that code is wrong.

import type { Assertion } from '../core/types';
import { detectHost } from '../../shared/host';
import { openCodeDelegationActive } from '../../shared/performance';
import { effState, result } from './util';

const OPENCODE_SELF_HOSTS: ReadonlySet<string> = new Set(['opencode', 'kilo']);

export const assertion: Assertion = {
  id: 'opencode-delegation',
  title: 'OpenCode delegation gate matches selection',
  appliesTo: (c) => c.preSeed.openCode !== undefined,
  run: (ctx) => {
    const ps = ctx.testCase.preSeed;
    // A pure-node case has no host target of its own; it runs under whichever host
    // buildCaseEnv pinned into the env, which is what detectHost() reads.
    const host = ctx.host === 'pure-node' ? detectHost() : ctx.host;
    const selfHosted = OPENCODE_SELF_HOSTS.has(host);
    const expected = ps.openCode === true && ps.openCodeInstalled === true && !selfHosted;
    const actual = openCodeDelegationActive(effState(ctx), host);
    if (expected === actual) {
      return result(ctx, 'PASS', `Delegation active=${actual} on ${host} (enabled=${ps.openCode}, installed=${!!ps.openCodeInstalled}${selfHosted ? ', stood down: OpenCode-compatible self host' : ''}).`);
    }
    return result(ctx, 'FAIL', `Delegation active mismatch on ${host}: expected ${expected}, got ${actual}.`, { expected, actual });
  },
};
