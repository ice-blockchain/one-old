// src/shared/state/__tests__/lock-disarm-ci.test.ts
// A gate that stands itself down must say so somewhere a human will see it.
//
// The clock row in lock-identity-symlink.test.ts has one assertion it cannot make
// unconditionally — "a progressing iteration is FAST" is a lower bound on this
// machine's speed, and load removes speed — so it gates that half and COUNTS the
// disarm. The count is the whole justification for keeping the gated half at all:
// without it, "off on two runs in three" and "off on every run forever" are the
// same green.
//
// AND THE COUNT WENT NOWHERE. It was a `t.diagnostic` line and nothing else.
// `npm test` output is teed to `$RUNNER_TEMP/npm-test.log`, that log is not
// uploaded as an artifact, and no step in any workflow matched the phrase — so on
// the only machine whose disarm rate anybody would act on, the record was written
// into a file that is deleted with the runner. A self-mute one layer up from the
// one the row's own comment condemns.
//
// THIS REPO ALREADY SOLVED IT ONCE, for the latency budgets, and the solution has
// three pieces rather than one: the suite prints a marker, a workflow step greps
// the log for it and raises an annotation plus a job summary, and a TEST fails if
// a file that needs enforcing is not named by the enforcing job — so "off
// everywhere" is not a state the repo can drift into silently. See
// src/test-support/__tests__/latency-budget-ci.test.ts, which is the same shape
// at ten times the scale, and generate-check.yml's
// "Latency budget: surface an unanswerable measurement" step.
//
// THIS FILE IS THE THIRD PIECE, and the second one has now landed: the workflow
// step exists and `PENDING_CI_ENFORCEMENT` is empty. The registry stays because
// it is what made the debt unforgettable in BOTH directions — a pending entry
// reds this file the moment its step lands (the second assertion requires every
// pending entry to be genuinely UNNAMED), and a deleted entry reds it the moment
// the step is removed. That is the property an allowlist normally lacks, and it
// is worth keeping for the next marker rather than deleting now that it is spent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseWorkflowJobs, stepBody, type WorkflowStep } from '../../../test-support/__tests__/ci-workflow';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const WORKFLOW_PATH = '.github/workflows/generate-check.yml';

/**
 * The job that runs `npm test`. A marker printed by the suite can only be read
 * out of THAT job's log, so a reporting step anywhere else is reading a file that
 * does not exist there — green, and blind.
 */
const SUITE_JOB = 'generate-check';
/** The path the suite log is teed to, as the workflow spells it. */
const SUITE_LOG = 'npm-test.log';

interface DisarmMarker {
  /** The literal the suite prints and the workflow greps. Both sides are pinned. */
  readonly marker: string;
  /** Repo-relative path of the file that prints it. */
  readonly emittedBy: string;
  /** The name of the test in that file which prints it — RUN below, not read. */
  readonly printedByTest: string;
  /** What stands itself down, for the failure message. */
  readonly what: string;
}

const MARKERS: readonly DisarmMarker[] = [
  {
    marker: 'T1 LOCK CLOCK DISARM',
    emittedBy: 'src/shared/state/__tests__/lock-identity-symlink.test.ts',
    printedByTest: 'a re-planting adversary cannot keep the acquisition loop alive past its deadline',
    what: "the project-state-lock clock row's gated progressing-speed assertion",
  },
];

/**
 * Load-bearing execArgv and nothing else, for the grandchild below.
 *
 * `process.execArgv` inside a test child carries three dozen node defaults
 * (`--test-isolation`, `--inspect-port`, profiler intervals) alongside the two
 * `--import` pairs that are the only reason this repo's tests can load a `.ts`
 * file at all. Forwarding the lot would make the grandchild's behaviour depend on
 * runner internals; forwarding the LOADERS keeps the one property that has to
 * hold — the child resolves TypeScript and gets `test-preload.mjs`, which pins
 * TRAFFIC_ONE_PLUGIN_ROOT — and leaves everything else at the child's own
 * defaults. Duplicated specifiers (the runner passes each `--import` in both
 * spellings) collapse here rather than being imported twice.
 */
function loaderArgs(): string[] {
  const specifiers = new Set<string>();
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]!;
    if (arg.startsWith('--import=')) specifiers.add(arg.slice('--import='.length));
    else if (arg === '--import' && index + 1 < process.execArgv.length) {
      specifiers.add(process.execArgv[index + 1]!);
      index += 1;
    }
  }
  return [...specifiers].map((specifier) => `--import=${specifier}`);
}

/**
 * Markers whose reporting step has not been written yet.
 *
 * EMPTY, and it is the landed state rather than an unused hatch: the hunk this
 * list used to carry verbatim is now the `generate-check` job's "Lock clock:
 * surface a disarmed timing assertion" step, immediately after "Latency budget:
 * surface an unanswerable measurement", and the entry was deleted in the same
 * change that added it. From here the marker is enforced permanently — removing
 * the step reds the first assertion below, and re-adding an entry for a marker
 * the workflow already names reds the second.
 */
const PENDING_CI_ENFORCEMENT: readonly string[] = [];

const workflowText = fs.readFileSync(path.join(REPO_ROOT, WORKFLOW_PATH), 'utf8');

/**
 * Steps that could actually report a marker: in the job that owns the log, over
 * that log, able to fail, and not skipped on an ordinary run.
 *
 * `if: always()` is admitted because a report step must run after a red suite —
 * that is when the marker matters most — and every other condition is refused
 * rather than interpreted. A step this repo cannot evaluate is not a step it may
 * credit.
 */
function reportingSteps(): WorkflowStep[] {
  const job = parseWorkflowJobs(workflowText).find((candidate) => candidate.id === SUITE_JOB);
  assert.ok(job, `the \`${SUITE_JOB}\` job is gone from ${WORKFLOW_PATH}; nothing produces the suite log`);
  return job.steps.filter((step) => {
    if (step.continueOnError) return false;
    if (step.if !== null && step.if.trim() !== 'always()') return false;
    return stepBody(step).includes(SUITE_LOG);
  });
}

function markersNamedByCi(): Set<string> {
  const named = new Set<string>();
  const bodies = reportingSteps().map(stepBody);
  for (const { marker } of MARKERS) {
    if (bodies.some((body) => body.includes(marker))) named.add(marker);
  }
  return named;
}

/**
 * Everything the test that owns a marker actually PRINTED, by running it.
 *
 * THE ROW BELOW USED TO CLAIM THIS AND READ THE SOURCE INSTEAD, which is the
 * defect this file exists to close, one level up. It asserted that the literal
 * occurs exactly once in the emitting file and is bound to a named constant —
 * and both survive the constant being declared and never reaching stdout.
 * DEMONSTRATED: leave the constant declared and interpolated and lowercase only
 * the EMITTED string (`${CLOCK_DISARM_MARKER.toLowerCase()}`), and the suite
 * prints `t1 lock clock disarm` while CI's grep finds nothing — this file was
 * GREEN. A rule citing a fact it does not verify, inside the file built to close
 * that class.
 *
 * So the marker is observed rather than inferred, and the observable is the one
 * CI has: bytes on stdout. That is strictly stronger than requiring a bare
 * interpolation, which is another spelling test — it would pass the mutant above
 * if the mutant lowercased the CONSTANT instead of the use site.
 *
 * NEITHER THE CHILD'S EXIT STATUS NOR THE ROW'S OWN VERDICT IS READ, and the
 * first attempt at this row read both — which is the more interesting half of the
 * story, because the fix belongs in the EMITTER and a reader cannot patch it.
 *
 * The emitting row is a wall clock measurement whose gated half a loaded runner
 * reds, so requiring a PASS would couple this file to that. Requiring nothing
 * failed differently: the row had two phases with `assert.throws` of their own
 * BEFORE its diagnostic, so a loaded host could fail one and never print the
 * marker, and a run in that state is indistinguishable from a marker that stopped
 * being emitted. MEASURED: exactly that, inside a mutation campaign at load 88 —
 * the lowercasing mutant SURVIVED, because the phase failed first. Gating this
 * reader on "the row passed" would have made the survival permanent.
 *
 * So the emitting row was restructured to measure, report, then judge: its
 * diagnostic is now emitted before EVERY assertion in it, including the phases',
 * and the marker is unconditional for any run that reaches the row at all. That
 * makes the requirement here unconditional too, which is the only form that
 * catches a marker going quiet on a red run — the run where the disarm rate
 * matters most.
 *
 * The cost is real and is the reason it is one child rather than a suite: the
 * named row drives two full contended acquisitions, so it is seconds rather than
 * milliseconds. That is the price of testing the observable instead of the
 * spelling.
 */
function emitterOutput(marker: DisarmMarker): { output: string; ranTests: number } {
  // `NODE_TEST_CONTEXT` is how the runner tells a child process it is being
  // watched, and a child that sees it reports over a v8-serialized channel
  // instead of on stdout — which OVERRIDES `--test-reporter=tap` and makes this
  // grandchild print nothing this function can read. Inherited unnoticed, the
  // whole row reads as "the marker was never printed": measured exactly that way
  // before this line existed, with the same command green when run by hand.
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST_')) delete env[name];
  const child = spawnSync(
    process.execPath,
    [
      ...loaderArgs(),
      '--test',
      '--test-reporter=tap',
      `--test-name-pattern=${marker.printedByTest}`,
      path.join(REPO_ROOT, marker.emittedBy),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', env },
  );
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  // TESTS RUN, not tests PASSED, and that is the whole of what this function
  // asks about the child: did the row the registry names still exist and execute.
  // `# pass 0` with the marker printed on the line above was observed while
  // writing this, so reading `pass` would report a healthy emitter as a missing
  // one — and the marker matters most precisely on a red run.
  return { output, ranTests: Number(/^# tests (\d+)$/m.exec(output)?.[1] ?? 0) };
}

test('the disarm registry is not empty, and every marker in it really reaches stdout', () => {
  // Guards the guard, the same way latency-budget-ci.test.ts guards its own set:
  // an empty registry, or a marker whose emitting file stopped printing it,
  // certifies nothing forever while looking identical to full coverage.
  assert.ok(MARKERS.length > 0, 'no disarm markers are registered — if the instrument went, remove this file with it');
  for (const entry of MARKERS) {
    const { marker, emittedBy, printedByTest, what } = entry;
    const source = fs.readFileSync(path.join(REPO_ROOT, emittedBy), 'utf8');
    const occurrences = source.split(marker).length - 1;
    assert.equal(
      occurrences, 1,
      `${emittedBy} spells \`${marker}\` ${occurrences} times. It must appear exactly once — as the single `
      + `constant the diagnostic is built from — or the marker CI greps and the marker the suite prints can `
      + `drift apart while both look present. (${what})`,
    );

    // THE HALF THAT IS NOT A SPELLING TEST. Everything above is satisfied by a
    // declaration; this runs the row that owns the marker and reads its stdout.
    const { output, ranTests } = emitterOutput(entry);
    assert.ok(
      ranTests >= 1,
      `no test matching \`${printedByTest}\` ran in ${emittedBy}, so nothing could have printed `
      + `\`${marker}\`. The registry names the row that emits it; renaming that row without updating `
      + 'this entry makes the marker unobservable from here. Child output tail:\n'
      + `${output.slice(-600)}`,
    );
    assert.ok(
      output.includes(marker),
      `${emittedBy} ran \`${printedByTest}\` and did not print \`${marker}\` to stdout. The constant may `
      + 'still be declared and even interpolated — that is exactly the state this assertion exists for, '
      + `since CI's only handle on the disarm rate is a grep of the suite log. Whether that row PASSED is `
      + 'deliberately not consulted: it emits its diagnostic before any of its own assertions, so a red '
      + `run must print the marker too. (${what}) Child output tail:\n${output.slice(-600)}`,
    );
  }
});

test('every disarm marker is either reported by the CI step that can see it, or registered as pending', () => {
  const named = markersNamedByCi();
  const unenforced = MARKERS
    .filter(({ marker }) => !named.has(marker) && !PENDING_CI_ENFORCEMENT.includes(marker));
  assert.deepEqual(
    unenforced.map(({ marker }) => marker),
    [],
    `${unenforced.map(({ marker, emittedBy, what }) => (
      `\`${marker}\` (printed by ${emittedBy} for ${what}) is named by no step of the \`${SUITE_JOB}\` job in `
      + `${WORKFLOW_PATH} that reads ${SUITE_LOG}, can fail, and is not conditionally skipped`
    )).join('\n\n')}\n\nA disarm count printed into a log nothing greps is the same green as no count at all. `
    + 'Either restore the reporting step, or add the marker to PENDING_CI_ENFORCEMENT with the hunk that '
    + 'will land it.',
  );
});

test('a pending marker is a debt that expires: the registry may not name one CI already reports', () => {
  // THE HALF THAT MAKES THE REGISTRY SAFE. An allowlist normally rots — the entry
  // outlives its reason and nobody notices, which is the self-mute again one
  // level up. Here it cannot: the moment the workflow step lands, this row reds
  // until the entry is deleted, and after that deletion the marker is enforced by
  // the row above with no way back into pending that a reviewer does not read.
  const named = markersNamedByCi();
  const stale = PENDING_CI_ENFORCEMENT.filter((marker) => named.has(marker));
  assert.deepEqual(
    stale, [],
    `${stale.join(', ')} is listed in PENDING_CI_ENFORCEMENT and IS now named by the \`${SUITE_JOB}\` job. `
    + 'Delete the entry: while it is there the marker is exempt from the coverage row above, so removing the '
    + 'workflow step again would be invisible.',
  );
  const unknown = PENDING_CI_ENFORCEMENT.filter(
    (marker) => !MARKERS.some((registered) => registered.marker === marker),
  );
  assert.deepEqual(
    unknown, [],
    `${unknown.join(', ')} is pending enforcement for a marker no file is registered as printing`,
  );
});
