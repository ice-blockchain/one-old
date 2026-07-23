// digests-terminal: the senior-engineer team left a terminal verdict for the run
// (reviewer APPROVED + tester TESTS_GREEN, or a shipper digest). Host-e2e only.
// Headless multi-agent spawning is not guaranteed, so "no digests" / "ran but
// not terminal" are INCONCLUSIVE — only a present-and-contradictory state fails.

import * as fs from 'fs';
import * as path from 'path';

import type { Assertion } from '../core/types';
import { runReachedTerminalVerdict, anyRunProducedImplementerOutput } from '../../shared/state/run-agent';
import { effState, latestRunId, result, hostProducedWork } from './util';

export const assertion: Assertion = {
  id: 'digests-terminal',
  title: 'Subagent digests reached terminal verdict',
  appliesTo: (c) => c.layer === 'host-e2e',
  run: (ctx) => {
    if (!hostProducedWork(ctx.hostResult.status)) {
      return result(ctx, 'SKIP', `Host run produced nothing to inspect (${ctx.hostResult.status}).`);
    }
    const s = effState(ctx);
    const runId = latestRunId(ctx.cwd, s);
    const digestsRoot = path.join(ctx.cwd, '.traffic-one', 'digests');
    const hasDigests = fs.existsSync(digestsRoot) && fs.readdirSync(digestsRoot).length > 0;

    if (!runId && !hasDigests) {
      if (ctx.hostResult.status === 'COMPLETED' && ctx.hostConfig?.headlessSubagents === 'unsupported') {
        return result(ctx, 'UNSUPPORTED', 'This headless host entrypoint cannot expose subagent digests; runtime fingerprint coverage remains mandatory.');
      }
      return result(ctx, 'INCONCLUSIVE', 'No run/digests found — orchestration likely did not spawn subagents headlessly.');
    }
    if (!runId) {
      return result(ctx, 'INCONCLUSIVE', 'Digest artifacts exist without an activated run id.');
    }
    if (!hasDigests) {
      return result(ctx, 'INCONCLUSIVE', `Run ${runId} was activated but produced no digests.`);
    }
    const terminal = runReachedTerminalVerdict(ctx.cwd, runId);
    const produced = anyRunProducedImplementerOutput(ctx.cwd);
    if (terminal) {
      return result(ctx, 'PASS', `Run ${runId} reached a terminal verdict (implementerOutput=${produced}).`);
    }
    return result(ctx, 'INCONCLUSIVE', `Run ${runId} produced digests but no terminal verdict (implementerOutput=${produced}).`);
  },
};
