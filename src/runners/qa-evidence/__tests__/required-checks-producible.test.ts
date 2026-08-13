// The producible-check invariant.
//
// `requiredChecks` publishes ids onto the verification contract and
// `validateQaReportV2` then demands each one be `passed`, or be covered by a
// justification allowlist. The two lists were independent authorities that
// nobody cross-checked, and that produced BOTH failure directions at once:
//
//   - an id with no producer and no allowlist entry (`unit-or-component-tests`,
//     `axe-when-dom` on `nonvisual`) is UNSATISFIABLE — no action the agent can
//     take reaches a settled verdict, and `nonvisual` is the base impact of
//     every project with a web surface;
//   - an id with no producer that IS on the allowlist (`stack-performance`) is
//     UNFAILABLE — its only reachable outcome is the exemption, so it is
//     contract decoration on exactly the runs where someone declared a
//     performance risk.
//
// So the invariant is not "some producer answers for this id" — both
// `computeBrowserCheckStatuses`' `default:` arm and the old wholesale native
// mapping answered for every id in existence, which would make this file
// vacuous. It is: SOME PRODUCER HAS A PATH TO `status: 'passed'`. The passable
// sets below are therefore not lists; they are the ids left standing after each
// producer is EXECUTED against inputs it should pass on.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { JUSTIFIED_NO_STACK_COMMAND_CHECK_IDS } from '../../../shared/qa-report-v2';
import {
  browserRequired,
  requiredChecks,
  type UiImpact,
} from '../../../shared/verification-contract';
import {
  BROWSER_CHECK_IDS,
  NATIVE_ATTESTED_CHECK_IDS,
  computeBrowserCheckStatuses,
  nativeCheckStatuses,
} from '../report-publish';
import { SUBSTITUTED_STACK_CHECK_IDS } from '../run-context';
import {
  NODE_SCRIPT_BY_CHECK,
  STACK_COMMAND_CHECK_IDS,
  runStackChecks,
} from '../stack';
import { type RunnerArgs } from '../types';

// Every UiImpact, enumerated so the COMPILER fails when a new value appears
// without a decision here. A runtime list would silently skip the new impact,
// which is the same "nobody cross-checked the two lists" failure one level up.
const IMPACT_COVERAGE: Record<UiImpact, true> = {
  none: true,
  nonvisual: true,
  behavioral: true,
  visual: true,
  'native-ui': true,
};
const ALL_IMPACTS = Object.keys(IMPACT_COVERAGE) as UiImpact[];

let probeRoot: string | null = null;

after(() => {
  if (probeRoot) fs.rmSync(probeRoot, { recursive: true, force: true });
  probeRoot = null;
});

/**
 * A project that declares EVERY script `resolveStackCommand` knows how to ask
 * for, so a check that fails to reach `passed` here has no arm at all rather
 * than an undeclared project.
 */
function stackProbeProject(): string {
  if (probeRoot) return probeRoot;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-producible-'));
  const scripts: Record<string, string> = {};
  for (const names of Object.values(NODE_SCRIPT_BY_CHECK)) {
    for (const name of names) scripts[name] = 'node -e ""';
  }
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'producible-probe', private: true, scripts }, null, 2),
  );
  probeRoot = dir;
  return dir;
}

function passableIds(checks: ReadonlyArray<{ id: string; status: string }>): Set<string> {
  return new Set(checks.filter((check) => check.status === 'passed').map((check) => check.id));
}

async function stackPassable(ids: readonly string[] = STACK_COMMAND_CHECK_IDS): Promise<Set<string>> {
  const args = { projectRoot: stackProbeProject() } as unknown as RunnerArgs;
  return passableIds(await runStackChecks(args, ids));
}

function browserPassable(ids: readonly string[] = BROWSER_CHECK_IDS): Set<string> {
  return passableIds(computeBrowserCheckStatuses(ids, {
    routes: [{
      route: '/',
      viewports: [{
        width: 390,
        status: 'passed',
        domAssertionsPassed: true,
        actionsPassed: true,
        routingPassed: true,
        hydrationPassed: true,
        consoleErrors: [],
        networkErrors: [],
        artifactAt: '2026-07-30T00:00:00.000Z',
        screenshotPath: 'home-390.png',
      }],
    }],
    visual: true,
    playwrightOk: true,
    launchBlocker: null,
    servedOk: true,
  }));
}

function nativePassable(ids: readonly string[] = NATIVE_ATTESTED_CHECK_IDS): Set<string> {
  return passableIds(nativeCheckStatuses(ids, 'passed'));
}

// Which producer a contract of this impact actually gets, read from the product
// rather than restated: `browserRequired` is the same predicate the contract
// publishes and `loadStackRun` refuses on, and a native contract additionally
// carries the stack-command ids run-context substitutes with real results.
async function passableFor(impact: UiImpact): Promise<Set<string>> {
  const substituted = new Set(
    [...await stackPassable(SUBSTITUTED_STACK_CHECK_IDS)],
  );
  if (impact === 'native-ui') return new Set([...nativePassable(), ...substituted]);
  if (browserRequired(impact)) return new Set([...browserPassable(), ...substituted]);
  return stackPassable();
}

test('every required check is one some producer can emit as passed', async () => {
  const offenders: string[] = [];
  for (const impact of ALL_IMPACTS) {
    const passable = await passableFor(impact);
    for (const stackPerformanceRisk of [false, true]) {
      for (const id of requiredChecks(impact, stackPerformanceRisk)) {
        if (passable.has(id)) continue;
        offenders.push(
          `uiImpact=${impact}${stackPerformanceRisk ? ' stackPerformanceRisk=true' : ''}`
          + ` requires \`${id}\`, which no producer for that contract can emit as passed`,
        );
      }
    }
  }
  assert.deepEqual(offenders, [], `unproducible required check(s):\n  ${offenders.join('\n  ')}`);
});

// Without this the test above proves nothing: a passable set derived from a
// producer that passes everything, or from a registry naming ids the producer
// has no arm for, would satisfy any contract.
test('the passable sets come from arms that exist, and no producer passes an unknown id', async () => {
  const stack = await stackPassable();
  assert.deepEqual(
    STACK_COMMAND_CHECK_IDS.filter((id) => !stack.has(id)),
    [],
    'every id in STACK_COMMAND_CHECK_IDS must resolve to a command and pass for a project that declares it',
  );
  assert.deepEqual(
    BROWSER_CHECK_IDS.filter((id) => !browserPassable().has(id)),
    [],
    'every id in BROWSER_CHECK_IDS must be an explicit case of computeBrowserCheckStatuses',
  );
  assert.deepEqual(
    NATIVE_ATTESTED_CHECK_IDS.filter((id) => !nativePassable().has(id)),
    [],
    'every id in NATIVE_ATTESTED_CHECK_IDS must be stamped from a green adapter result',
  );

  const unknown = 'made-up-check';
  assert.equal(browserPassable([unknown]).has(unknown), false, 'the browser default arm must fail closed');
  assert.equal(nativePassable([unknown]).has(unknown), false, 'the native mapping must not be wholesale');
  assert.equal((await stackPassable([unknown])).has(unknown), false, 'the stack runner must never invent a command');
});

// The other direction. An allowlisted id with no path to `passed` is not an
// exemption, it is an unfailable check: `stack-performance` sat here for its
// whole life with no arm in `resolveStackCommand`, so every run that declared a
// performance risk got a required check that could only ever be excused.
test('every justification allowlist entry names a check that can also pass and can also be required', async () => {
  const anyPassable = new Set([
    ...await stackPassable(),
    ...browserPassable(),
    ...nativePassable(),
  ]);
  const everRequired = new Set(ALL_IMPACTS.flatMap((impact) => (
    [...requiredChecks(impact, false), ...requiredChecks(impact, true)]
  )));
  for (const id of JUSTIFIED_NO_STACK_COMMAND_CHECK_IDS) {
    assert.ok(anyPassable.has(id), `\`${id}\` is excused by the validator but no producer can pass it`);
    assert.ok(everRequired.has(id), `\`${id}\` is excused by the validator but no contract requires it`);
  }
});
