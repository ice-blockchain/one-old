// src/test-environment/core/case-runner.test.ts
// The seed half of runCase: what a case reports when the harness could not build
// the project the case describes. A flow-sim case's whole starting point is the
// mode written to `.traffic-one/.one.json`, and the write layer refuses that path
// when it is a symlink — so the refusal is reachable without a host, a CLI, or a
// consent question.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCase } from './case-runner';
import { defaultConfig } from '../config/test-config';
import type { Assertion, AssertionContext, Case } from './types';

const FLOW_SIM: Case = {
  id: 'seed-refusal-probe',
  category: 'feature-onboarding',
  layer: 'pure-node',
  fixture: 'empty',
  preSeed: { mode: 'new-project' },
  // One answer is enough to take the flow-sim branch (`scriptedAnswers.length > 0`);
  // the wizard is never reached in the refused direction, and in the baseline this
  // answer is a real step the state machine accepts.
  scriptedAnswers: [{ step: 'open-code', value: false }],
  assertions: [{ id: 'seeded-mode-on-disk' }],
};

// Two stubs so the baseline is unambiguously green: `consent-fence` is injected
// into every case by assertionSpecsForRun, and an unregistered spec is itself
// reported INCONCLUSIVE — which is the very status the refused direction asserts.
function stubAssertions(): Map<string, Assertion> {
  const probe: Assertion = {
    id: 'seeded-mode-on-disk',
    title: 'the seeded mode reached disk',
    appliesTo: () => true,
    run: (ctx: AssertionContext) => {
      const raw = fs.readFileSync(path.join(ctx.cwd, '.traffic-one', '.one.json'), 'utf8');
      return {
        id: 'seeded-mode-on-disk',
        title: 'the seeded mode reached disk',
        status: raw.includes('new-project') ? 'PASS' as const : 'FAIL' as const,
        detail: raw,
      };
    },
  };
  const consent: Assertion = {
    id: 'consent-fence',
    title: 'consent fence (stub)',
    appliesTo: () => true,
    run: () => ({ id: 'consent-fence', title: 'consent fence (stub)', status: 'PASS' as const, detail: 'stub' }),
  };
  return new Map([[probe.id, probe], [consent.id, consent]]);
}

function withRunDir(fn: (runDir: string) => Promise<void>): Promise<void> {
  // Outside the repo: runCase throws on a project dir inside the plugin authoring
  // root, because state writers no-op there.
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-case-runner-'));
  return fn(runDir).finally(() => fs.rmSync(runDir, { recursive: true, force: true }));
}

// `distRoot: ''` keeps buildCaseEnv from pinning TRAFFIC_ONE_PLUGIN_ROOT, which a
// pure-node case does not need — nothing here resolves a shipped asset.
const run = (runDir: string) => runCase(FLOW_SIM, 'pure-node', defaultConfig(), '', stubAssertions(), runDir);

test('runCase: a flow-sim seed the write fence refused is reported INCONCLUSIVE, never measured', async () => {
  await withRunDir(async (runDir) => {
    const result = await run(runDir);
    assert.deepEqual(
      result.assertions.map((a) => a.status),
      ['PASS', 'PASS'],
      'writable baseline: the seed lands and the case is measured normally',
    );
  });

  await withRunDir(async (runDir) => {
    // The project dir is derived from runDir + case id + target, so the fence can
    // be planted before runCase creates anything. A dangling link (not move-aside)
    // is right here and only here: the project is brand new, so there is no
    // content the seed reads back — `writeState` merges over an absent file either
    // way — and fsjson refuses a symlink at the destination whether or not it
    // resolves.
    const projectDir = path.join(runDir, 'projects', `${FLOW_SIM.id}__pure-node`, 'project');
    const statePath = path.join(projectDir, '.traffic-one', '.one.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.symlinkSync(path.join(runDir, 'elsewhere.json'), statePath);

    const result = await run(runDir);
    assert.ok(result.assertions.length > 0, 'the case still reports its specs');
    for (const a of result.assertions) {
      assert.equal(a.status, 'INCONCLUSIVE', `${a.id} is not a pass and not a verdict on the product`);
      assert.match(a.detail, /write fence refused the flow-sim seed/);
      assert.ok(a.detail.includes(statePath), 'the detail names the exact refused path');
    }
    assert.equal(fs.existsSync(path.join(runDir, 'elsewhere.json')), false,
      'and nothing was written through the link');
  });
});
