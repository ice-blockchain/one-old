// src/test-environment/config/cases/delegation-channel.test.ts
// The FLOOR under the OpenCode-delegation coverage channel.
//
// Exactly one row in the whole corpus seeds delegation on
// (`onb-high-mobile-rn-opencode`: `openCode: true, openCodeInstalled: true`), and
// that row is the only place the composed suite ever exercises preseed.ts's
// consent-seeding branch — the branch that had to be rewritten when
// state/local-prefs/prefs-split.ts stopped carrying OpenCode consent out of the
// committed, agent-writable `.one.json`. Delete the row, flip either flag, or
// drop `{ id: 'opencode-delegation' }` from its assertion list, and the rewrite
// loses its detection channel with every test still green.
//
// This is the same shape the repo has closed twice before — the never-overridable
// deny-id guard that ITERATED the list (so an absent id was never examined) and
// the refusal scanner that learned writers by NAME (so a renamed writer silently
// left the denominator). Both were fixed the same way: MAKE THE ABSENCE A
// FAILURE.
//
// Why the floor sits here rather than on a run's results.json: it does not wait
// for a run. Each qualifying case is seeded into a real isolated project through
// the harness's own buildCaseEnv/withCaseEnv and preseed, and then judged by the
// REAL `opencode-delegation` assertion plus the REAL predicate — so this fires in
// `npm test`, in the same command as the edit that broke it, and it covers the
// assertion-side question ("did anything record an ACTIVE row?") without
// depending on `test:env` having been run. It is deliberately not a count
// compared to a magic number: the two directions below are each derived by
// running the product, and each names its own cause.
//
// SCOPE: this floor is keyed to the DEFAULT run. A committed workflow that
// narrows `--category=` or `--case=` could deselect the very case measured here
// and leave this file green, so the complement — every committed CI invocation
// still reaches this population — lives in ci-strict-invocation.test.ts, which is
// the file that reads workflow command lines instead of restating them. Both ask
// casesRunningAssertion(), so the two cannot disagree about what "reachable"
// means.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openCodeDelegationActive } from '../../../shared/performance';
import { readEffectiveState } from '../../../shared/state';
import { assertion as delegationAssertion } from '../../assertions/opencode-delegation.assert';
import { casesRunningAssertion } from '../../core/case-selection';
import { buildCaseEnv, withCaseEnv } from '../../core/env';
import { preseed } from '../../core/preseed';
import type { AssertionContext, AssertionResult, AssertionStatus, Case, RootTestConfig } from '../../core/types';
import { defaultConfig } from '../test-config';

interface Measured {
  caseId: string;
  /** What openCodeDelegationActive() — the predicate the spawn gate and the
   *  OpenCode-first triage clause ask — answers for the seeded project. */
  active: boolean;
  /** What the real assertion reported about it. */
  status: AssertionStatus;
  detail: string;
}

// Seed one case's project for real and ask both questions of it. The fixture is
// deliberately not materialized: the delegation gate reads state and preferences
// only, so an empty project root is the whole world it needs.
function measure(c: Case, config: RootTestConfig): Measured {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-delegation-floor-'));
  try {
    const caseFolder = path.join(runDir, c.id);
    const project = path.join(caseFolder, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(caseFolder, 'state'), { recursive: true });
    const env = buildCaseEnv(config, caseFolder, '', 'pure-node');

    return withCaseEnv(env, () => {
      assert.equal(preseed(project, c.preSeed), true,
        `${c.id}: the seed did not land, so nothing below is a measurement of the delegation channel`);
      const ctx: AssertionContext = {
        cwd: project,
        caseFolder,
        env,
        host: 'pure-node',
        testCase: c,
        spec: { id: delegationAssertion.id },
        hostResult: { status: 'COMPLETED', exitCode: 0, durationMs: 1 },
      };
      // Synchronous by construction: the assertion only reads effective state.
      const result = delegationAssertion.run(ctx) as AssertionResult;
      return {
        caseId: c.id,
        active: openCodeDelegationActive(readEffectiveState(project, env)),
        status: result.status,
        detail: result.detail,
      };
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

// Every case the `opencode-delegation` assertion would actually be RUN against
// on a default `npm run test:env`, each one seeded and measured for real.
function inventory(): Measured[] {
  const config = defaultConfig();
  return casesRunningAssertion(delegationAssertion, config).map((c) => measure(c, config));
}

function roll(measured: Measured[]): string {
  if (measured.length === 0) return '  (no case in the corpus runs this assertion at all)';
  return measured
    .map((m) => `  ${m.caseId}: delegation ${m.active ? 'ACTIVE' : 'inactive'}, assertion ${m.status} — ${m.detail}`)
    .join('\n');
}

// The floor itself. Both directions are required, and each says why it went red
// so the next reader goes after the missing row rather than after this file.
test('the corpus still exercises OpenCode delegation ON, measured by the real assertion', () => {
  const measured = inventory();

  // First, so a PRODUCT regression is reported as one. Without this the floors
  // below would fire on a corpus that is perfectly intact and send the reader
  // after a missing row that is right where it always was.
  assert.deepEqual(
    measured.filter((m) => m.status !== 'PASS').map((m) => `${m.caseId}: ${m.status} — ${m.detail}`),
    [],
    'The `opencode-delegation` assertion is red on a freshly seeded project, so nothing below is a statement about\n'
    + 'the CASE LIST.\n'
    + `Measured:\n${roll(measured)}\n`
    + 'CAUSE: this is the product. preseed() no longer produces the delegation state its case declares — the most\n'
    + 'likely reason being the consent write into the per-user preference store (state/local-prefs), which is the\n'
    + 'only route left since prefs-split.ts stopped carrying OpenCode consent out of the committed `.one.json`.',
  );

  assert.ok(
    measured.some((m) => m.active && m.status === 'PASS'),
    'The OpenCode-delegation ON channel is gone.\n'
    + 'No case reachable by a default `npm run test:env` run both declares the `opencode-delegation` assertion and,\n'
    + 'seeded through the real preseed(), makes openCodeDelegationActive(readEffectiveState(project)) answer true.\n'
    + `What the corpus does contain:\n${roll(measured)}\n`
    + 'CAUSE: a case that seeded `openCode: true, openCodeInstalled: true` was removed, flipped, or stripped of its\n'
    + "`{ id: 'opencode-delegation' }` assertion. That single row (it was `onb-high-mobile-rn-opencode` in\n"
    + 'features-onboarding.cases.ts) is the ONLY corpus coverage of preseed.ts\'s consent-seeding branch — the branch\n'
    + 'rewritten when state/local-prefs/prefs-split.ts stopped carrying OpenCode consent out of the committed,\n'
    + 'agent-writable `.one.json`. Without it that rewrite can break with the entire suite green.\n'
    + 'FIX: restore a delegation-ON case. Do not relax this floor.',
  );

  assert.ok(
    measured.some((m) => !m.active && m.status === 'PASS'),
    'The OpenCode-delegation OFF channel is gone.\n'
    + 'Every case that runs the `opencode-delegation` assertion now seeds delegation ON, so the assertion only ever\n'
    + 'sees one answer and a gate stuck permanently open would satisfy it.\n'
    + `What the corpus does contain:\n${roll(measured)}\n`
    + 'CAUSE: the delegation-OFF case that ran this assertion (it was `onb-low-webonly-noopencode`) was removed or\n'
    + 'flipped on. FIX: restore a case that seeds `openCode: false` AND lists the assertion — an assertion with only\n'
    + 'one direction on record proves nothing about the gate.',
  );
});
