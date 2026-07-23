// run-manifest-roles: the run manifest records the roles the case's team would
// spawn (subagents for balanced/high). Host-e2e + subagent teams only; absent
// manifest is INCONCLUSIVE (headless spawning is not guaranteed).

import type { Assertion } from '../core/types';
import { readRunAssignments } from '../../shared/state/run-agent';
import { effState, latestRunId, result, hostProducedWork } from './util';

function expectedImplementerRoles(ctx: Parameters<Assertion['run']>[0]): string[] {
  const expected: string[] = [];
  const seed = ctx.testCase.preSeed;
  if (seed.frontend && seed.frontend !== 'none') expected.push('senior-frontend');
  if (seed.backend && seed.backend !== 'none') expected.push('senior-backend');
  return expected;
}

export const assertion: Assertion = {
  id: 'run-manifest-roles',
  title: 'Run manifest records expected roles',
  appliesTo: (c) => c.layer === 'host-e2e' && (c.preSeed.team?.mode ?? '') === 'subagents',
  run: (ctx) => {
    if (!hostProducedWork(ctx.hostResult.status)) {
      return result(ctx, 'SKIP', `Host run produced nothing to inspect (${ctx.hostResult.status}).`);
    }
    const runId = latestRunId(ctx.cwd, effState(ctx));
    if (!runId) {
      if (ctx.hostResult.status === 'COMPLETED' && ctx.hostConfig?.headlessSubagents === 'unsupported') {
        return result(ctx, 'UNSUPPORTED', 'This headless host entrypoint cannot expose a subagent run manifest; runtime fingerprint coverage remains mandatory.');
      }
      return result(ctx, 'INCONCLUSIVE', 'No run id — no orchestrated run recorded.');
    }

    // Release evidence must belong to the activated run exactly. Runtime gates
    // may recover from a stray-id manifest, but a stale neighboring run cannot
    // satisfy production proof for this one.
    const manifest = readRunAssignments(ctx.cwd, runId);
    if (!manifest) {
      return result(ctx, 'INCONCLUSIVE', `Run ${runId} was activated but has no valid assignments manifest.`);
    }
    const expected = expectedImplementerRoles(ctx);
    if (expected.length === 0) {
      return result(ctx, 'INCONCLUSIVE', `Manifest ${runId} exists, but the seeded case declares no frontend/backend implementer roles to validate.`);
    }
    const actual = [...new Set(manifest.assignments.map((assignment) => assignment.role))].sort();
    const missing = expected.filter((role) => !actual.includes(role));
    if (missing.length > 0) {
      return result(ctx, 'FAIL', `Manifest ${manifest.runId} is partial for the seeded team: missing [${missing.join(', ')}], actual [${actual.join(', ')}].`, {
        expected,
        actual,
      });
    }
    return result(ctx, 'PASS', `Manifest ${manifest.runId} covers seeded implementers [${expected.join(', ')}] with ${manifest.assignments.length} assignment(s).`);
  },
};
