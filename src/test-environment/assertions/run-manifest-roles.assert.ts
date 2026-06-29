// run-manifest-roles: the run manifest records the roles the case's team would
// spawn (subagents for balanced/high). Host-e2e + subagent teams only; absent
// manifest is INCONCLUSIVE (headless spawning is not guaranteed).

import type { Assertion } from '../core/types';
import { readRunAssignmentsResilient } from '../../shared/state/run-agent';
import { rec, effState, latestRunId, result, hostProducedWork } from './util';

export const assertion: Assertion = {
  id: 'run-manifest-roles',
  title: 'Run manifest records expected roles',
  appliesTo: (c) => c.layer === 'host-e2e' && (c.preSeed.team?.mode ?? '') === 'subagents',
  run: (ctx) => {
    if (!hostProducedWork(ctx.hostResult.status)) {
      return result(ctx, 'SKIP', `Host run produced nothing to inspect (${ctx.hostResult.status}).`);
    }
    const runId = latestRunId(ctx.cwd, effState(ctx));
    if (!runId) return result(ctx, 'INCONCLUSIVE', 'No run id — no orchestrated run recorded.');

    const manifest = readRunAssignmentsResilient(ctx.cwd, runId);
    if (!manifest) {
      return result(ctx, 'INCONCLUSIVE', `No run manifest for ${runId} — subagents likely did not spawn headlessly.`);
    }
    const m = rec(manifest);
    const roles = Array.isArray(m.roles) ? (m.roles as unknown[]).filter((r) => typeof r === 'string') : [];
    const assignments = Array.isArray(m.assignments) ? m.assignments.length : 0;
    if (roles.length > 0 || assignments > 0) {
      return result(ctx, 'PASS', `Manifest ${runId}: roles=[${roles.join(', ')}], assignments=${assignments}.`);
    }
    return result(ctx, 'INCONCLUSIVE', `Manifest ${runId} present but empty (orchestrator=${String(m.orchestrator)}).`);
  },
};
