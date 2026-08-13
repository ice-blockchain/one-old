// Every file that asserts a latency budget must be run by the CI job that can
// actually enforce one — and that job must be able to fail.
//
// WHY. The budget instrument is three-valued, and node:test has no third state,
// so INCONCLUSIVE is encoded as a SKIP. Inside `npm test` — 291 files as
// parallel processes, on a 2-vCPU hosted runner — that verdict is reached by
// construction, which is why the workflow step over the suite log emits a
// WARNING rather than failing. That warning is the correct call there and a
// self-mute everywhere else: a budget whose only CI home is a step that cannot
// fail is enforced by nothing, and it goes green forever with no one noticing.
//
// Measured instance, and the reason this file exists rather than a comment:
// src/modules/session/__tests__/session-updates-surface.test.ts asserted three
// 15 ms budgets that ran ONLY in the parallel suite. They were warned about and
// never once enforced. Nothing was wrong with the budgets; nothing was in place
// to notice where they ran.
//
// AND THE REASON THIS FILE IS NOW WRITTEN AGAINST A PARSER. The first version of
// this check had the defect it exists to close. It asked substring questions of
// the whole file, and a substring cannot say WHERE it was answered: deleting
// both session-start steps outright, while leaving the filename in one comment
// inside the serial job and one `echo` inside the parallel job, left it fully
// green over a job that ran one fewer measurement. The adversarial section at
// the bottom is that workflow and every other defeat found since, and it
// requires this check to go RED on every one of them. A checker that has never
// been shown failing on a hollow workflow is not a checker — it is a second copy
// of the claim it was supposed to test.
//
// The number of those cases is deliberately NOT written here. It was ("eight
// more like it"), it was wrong by four the moment cases were added, and a prose
// count of something in the same file is a claim with no reason to be true —
// HOLLOW_WORKFLOWS.length is asserted below instead, where adding a case moves
// it and deleting one is visible.

import { test, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  auditCheckerJob,
  auditEnforcingJob,
  auditWorkflowTriggers,
  parseWorkflowJobs,
  parseWorkflowTriggers,
  shellCommands,
  stepBody,
  stepsPipingWithoutPipefail,
  stepsWithMaskedStatus,
  testFilesInvokedBy,
  testFilesNamedBy,
  workflowRefusal,
  type WorkflowStep,
} from './ci-workflow';
import { wallClockClaimsIn, type WallClockClaim } from './budget-census';
import {
  classifyLatency,
  latencyStatsLine,
  latencyVerdictLine,
  selfCheckCorridorMiss,
  SELF_CHECK_BUDGET_MS,
  SELF_CHECK_LABEL,
  SELF_CHECK_MEASUREMENT_MARKER,
  SELF_CHECK_WAIT_MS,
  settle,
  settleSelfCheck,
  STRICT_ENV,
  STRICT_FAILURE_MARKER,
  strictModeEngaged,
} from './latency-budget';
import { trackedTempDirs } from './temp-dirs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');
const WORKFLOW_PATH = '.github/workflows/generate-check.yml';
/** The one job in this repo where a latency budget can be enforced. */
const ENFORCING_JOB = 'latency-budget';

/** The exported entry points that ASSERT a budget, as opposed to measuring one. */
const ASSERTING_ENTRY_POINTS = ['assertLatencyBudget', 'assertLatencyBudgetAsync'];

/**
 * Every TypeScript source under `dir`, in every extension this repo compiles.
 *
 * `.mts` and `.cts` are here because `.ts` alone is a discovery rule that can
 * be stepped around by renaming a file. The population this walk feeds is the
 * set of files that BIND an asserting entry point and must therefore be run by
 * a job that can enforce one, so a file the walk cannot see is a budget the
 * coverage claim silently stops covering. This repo already has one such file
 * (src/runners/lighthouse/index.mts), tsconfig.json includes `src/**\/*.ts`
 * with `allowImportingTsExtensions` off, and node --test resolves all three, so
 * the extension is a spelling and not a category.
 */
const TS_EXTENSIONS = ['.ts', '.mts', '.cts'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.tmp') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (TS_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

/**
 * Does this source text BIND one of the asserting entry points?
 *
 * Binding, not calling, and that is the fix for a fail-open the call-shaped
 * version had. `import { assertLatencyBudget as budget }` followed by `budget(`
 * matches neither `assertLatencyBudget\s*\(` nor anything else the old regex
 * looked for, so an aliased import made the file INVISIBLE — it asserted a
 * budget, this check did not know it existed, and the coverage claim passed by
 * being unable to see its own counterexample. So what is matched is the
 * imported NAME on the left of an `as`, under any local name, plus the
 * namespace form.
 *
 * WHAT THIS IS NOT, corrected: it used to say an import is "the one thing a
 * caller cannot rename away", and that sentence was false in the direction that
 * matters. This is a text match, and it used to require the SPECIFIER to
 * contain `latency-budget` — so a one-line re-export barrel renamed the path
 * and the file dropped out of the set (measured). The specifier requirement is
 * gone, which closes the plain barrel; what remains open is a barrel that
 * re-exports under a NEW name (`export { assertLatencyBudget as budget }`,
 * imported as `budget`), because following that needs a resolver rather than a
 * regex. Such a file does not ESCAPE — the census below finds it by shape, and
 * the workflow's own report steps go red when a measurement stops appearing —
 * but the message a maintainer gets then blames the workflow for a cause that
 * is an import path, so this is written down rather than implied.
 *
 * The direction of the remaining error is deliberate. A file that imports an
 * asserting entry point and never calls it is counted anyway and must then be
 * named by the serial job — a false positive whose fix is one line, versus a
 * false negative that silently un-enforces a budget.
 */
function bindsAnAssertingEntryPoint(text: string): boolean {
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const specifier of match[1]!.split(',')) {
      const imported = specifier.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (imported && ASSERTING_ENTRY_POINTS.includes(imported)) return true;
    }
  }
  for (const match of text.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*['"][^'"]+['"]/g)) {
    const namespace = match[1]!;
    if (ASSERTING_ENTRY_POINTS.some((fn) => new RegExp(`\\b${namespace}\\.${fn}\\b`).test(text))) return true;
  }
  return false;
}

/**
 * Files that assert a budget, computed ONCE.
 *
 * It used to be a function called five times per run, so every assertion below
 * re-walked src/ and tests/ and re-read every .ts file in them. Nothing about
 * the answer changes between calls.
 */
const filesAssertingABudget: string[] = (() => {
  const found: string[] = [];
  for (const file of [...sourceFiles(path.join(REPO_ROOT, 'src')), ...sourceFiles(path.join(REPO_ROOT, 'tests'))]) {
    // This file itself is excluded, and it is the fail-closed rule above doing
    // its job rather than an exception to it: the aliased-import cases below
    // are real import statements in string literals, so the detector finds them
    // and counts the checker as a caller of the thing it checks. Excluded by
    // identity, not by pattern — a pattern loose enough to skip these would be
    // loose enough to skip a genuine caller that quoted an import in a comment.
    if (file === __filename) continue;
    if (bindsAnAssertingEntryPoint(fs.readFileSync(file, 'utf8'))) {
      found.push(path.relative(REPO_ROOT, file).split(path.sep).join('/'));
    }
  }
  return found.sort();
})();

/**
 * Files the serial job must run that no import can point at.
 *
 * ONE ENTRY, and it is the row that measures the INSTRUMENT: latency-budget.test.ts
 * drives `measureLatencyBudget` over a real filesystem made to wait, and it
 * binds no asserting entry point, so the rule above cannot see it. Its verdict
 * is three-valued like every other, and until now its only CI home was the
 * 291-file parallel suite — where its corridor exit was measured leaving one
 * run in three, with the departing run's underlying verdict a `fail`. A skip
 * there converts a failing measurement into no measurement, in the most
 * contended job in this repository, so the file is listed here and the audit
 * demands the same things of its step as of any other: an invocation, a log, a
 * report step that can fail, and (through `requiredStepEnv` below) the strict
 * switch that makes its third value fatal on the idle runner.
 */
const ALSO_MEASURED_SERIALLY = ['src/test-support/__tests__/latency-budget.test.ts'];

/** Every file the serial job has to run, whichever way it earned its place. */
const budgetFiles: string[] = [...new Set([...filesAssertingABudget, ...ALSO_MEASURED_SERIALLY])].sort();

/**
 * The env a measurement step must carry, with the NAME taken from the
 * instrument rather than retyped here. `T1_LATENCY_BUDGET_STRICT` spent three
 * rounds appearing only in its own definition, the branch that reads it, and
 * one line of prose — an escape hatch that could not be taken — and a
 * hand-typed copy of the name in a workflow is the same hatch one rename away.
 */
const REQUIRED_STEP_ENV = [
  { file: 'src/test-support/__tests__/latency-budget.test.ts', name: STRICT_ENV, value: '1' },
];

const committedWorkflow = fs.readFileSync(path.join(WORKFLOWS, 'generate-check.yml'), 'utf8');

/** Every workflow file in the repo, because the pipefail rule is not about one of them. */
const ALL_WORKFLOWS: readonly { readonly name: string; readonly text: string }[] = fs
  .readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()
  .map((name) => ({ name, text: fs.readFileSync(path.join(WORKFLOWS, name), 'utf8') }));

/**
 * Everything this repo requires of the committed workflow, as one list.
 *
 * The trigger audit is folded in here rather than left to a row of its own so
 * that every adversarial case below is driven against BOTH halves: a case that
 * silences the enforcing job by rewriting the file's triggers is the same class
 * of defeat as one that silences it from inside, and it would be green against
 * a job-only audit.
 *
 * AND THE CHECKER'S OWN JOB IS IN THE LIST, which is where the recursion used
 * to terminate silently. Something runs this file, and until now nothing said
 * anything about it beyond asserting that the job NAME exists: two unquoted,
 * one-line, fully green defeats followed — `continue-on-error: true` on
 * `generate-check` (the suite reds, the job reds, the run is green) and a
 * job-level `if:` restricting it to manual dispatch. See `auditCheckerJob` for
 * which of those this closes completely, which only partly, and why no rule in
 * this repository can close the second one at the moment it is introduced.
 */
const CHECKER_JOB = 'generate-check';
/** The package script whose run is this file's only execution. */
const SUITE_SCRIPT = 'test';

function auditCommitted(workflow: string, files: readonly string[] = budgetFiles): string[] {
  return [
    ...auditWorkflowTriggers({ workflow, workflowPath: WORKFLOW_PATH, jobId: ENFORCING_JOB }),
    ...auditCheckerJob({
      workflow,
      workflowPath: WORKFLOW_PATH,
      jobId: CHECKER_JOB,
      suiteScript: SUITE_SCRIPT,
    }),
    ...auditEnforcingJob({
      workflow,
      workflowPath: WORKFLOW_PATH,
      jobId: ENFORCING_JOB,
      budgetFiles: files,
      requiredStepEnv: REQUIRED_STEP_ENV,
    }),
  ];
}

test('the set of files asserting a latency budget is not empty', () => {
  // Guards the guard. If the instrument were renamed or removed, every check
  // below would certify an empty set forever, which is the exact shape of the
  // failure they exist to catch.
  assert.ok(
    filesAssertingABudget.length > 0,
    `no file imports ${ASSERTING_ENTRY_POINTS.join('/')} — if the instrument was renamed, rename it here too;`
    + ' if it was removed, remove this check with it',
  );
});

test('the serial latency job runs every budget file, in a step that can fail, with a report step of its own', () => {
  const findings = auditCommitted(committedWorkflow);
  assert.deepEqual(
    findings,
    [],
    `the \`${ENFORCING_JOB}\` job in ${WORKFLOW_PATH} does not enforce what it is credited with:\n\n`
    + findings.map((finding) => `  - ${finding}`).join('\n\n'),
  );
});

test('no step in any job of any workflow pipes a command into tee without pipefail first', () => {
  // Not confined to the enforcing job, and worst outside it: the parallel
  // `npm test 2>&1 | tee "$log"` exits 0 on a red suite without this line, and
  // every report step downstream only checks that the expected test NAMES
  // appeared — which a failing test prints exactly as a passing one does.
  //
  // EVERY workflow file, not the one this file happens to be about. The rule
  // was only ever run over generate-check.yml while a second file sat beside it
  // unchecked; it sets `set -euo pipefail` today, so what is closed here is the
  // exposure rather than a live defect — and a third file added tomorrow is
  // covered without anyone remembering this test exists.
  const offenders = ALL_WORKFLOWS.flatMap(({ name, text }) => (
    stepsPipingWithoutPipefail(text).map((step) => `${name}: ${step}`)
  ));
  assert.deepEqual(
    offenders,
    [],
    'these steps report the exit status of `tee` rather than of the command whose output it is copying,'
    + ` so a failure exits 0 and the job ticks:\n${offenders.map((step) => `  - ${step}`).join('\n')}`,
  );
  // And the sweep really did read every file rather than reporting a clean
  // sheet over an empty list.
  assert.ok(ALL_WORKFLOWS.length >= 2, `only ${ALL_WORKFLOWS.length} workflow file(s) were read`);
  const unreadable = ALL_WORKFLOWS.filter(({ text }) => parseWorkflowJobs(text).length === 0);
  assert.deepEqual(
    unreadable.map(({ name }) => name),
    [],
    'a workflow file parsed with no jobs at all, so the rule above swept nothing in it',
  );
  // And the reader really is finding pipelines to check, rather than reporting
  // a clean sheet because it found none.
  //
  // PAIRED PER STEP, NOT COUNTED, and the count is exactly why. This was
  // `piping.length >= 4` while the file had five such steps, so ONE of them
  // could be made invisible to the reader — by a `run: |2` header it could not
  // parse, say — and the slack absorbed it: the step stopped being an offender
  // of the rule AND stopped being a member of the population the rule was
  // checked against, in the same move. A set comparison has no slack to absorb
  // anything: a step that stops being read is a missing NAME here, and a step
  // that starts masking a status is an extra one.
  assert.deepEqual(stepsWithMaskedStatus(committedWorkflow), [
    'generate-check / "Tests"',
    'generate-check / "Compiled-runtime smoke (bare-node dispatch)"',
    'latency-budget / "Write pre-tool p95 budget (one file, alone, nothing else running)"',
    'latency-budget / "Session-start p95 budgets (one file, alone, nothing else running)"',
    'latency-budget / "Hot structural analysis p95 budget (one file, alone, nothing else running)"',
    'latency-budget / "Latency instrument self-check (one file, alone, corridor enforced)"',
    'latency-budget / "Per-event hook timing (one file, alone, process leg enabled)"',
  ], 'the set of steps whose exit status a pipeline masks moved: every one of them needs `set -o pipefail`'
    + ' ahead of the pipe, and a step that DROPPED OFF this list is the dangerous direction — it means the'
    + ' reader stopped seeing a pipeline that is still there');
});

// ── the checker, driven against workflows built to defeat it ────────────────
// Each case starts from the COMMITTED workflow and breaks exactly one thing, so
// a case that stops being a counterexample (because the real file moved out
// from under its anchor) fails on the anchor rather than passing vacuously.

/** Line span of one job, so a step NAME that occurs in three jobs can be aimed at one of them. */
function jobSpan(lines: readonly string[], jobId: string): { from: number; to: number } {
  const from = lines.indexOf(`  ${jobId}:`);
  assert.notEqual(from, -1, `anchor lost: no job \`${jobId}\` in ${WORKFLOW_PATH}`);
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]!)) { to = i; break; }
  }
  return { from, to };
}

/**
 * Line span of a step, from its `- name:` line to the line before the next step or job.
 *
 * `inJob` is not optional decoration: three jobs in this file have a step named
 * "Install dependencies", and an unscoped search found the FIRST — so a case
 * meaning to edit the enforcing job's install step silently edited another
 * job's, and the audit then reddened for a true but unrelated reason. Scoping
 * is what makes each case a counterexample to the rule it names.
 */
function stepSpan(lines: readonly string[], nameFragment: string, inJob?: string): { from: number; to: number } {
  const scope = inJob ? jobSpan(lines, inJob) : { from: 0, to: lines.length };
  const from = lines.findIndex((line, index) => (
    index >= scope.from && index < scope.to && /^ {6}- name:/.test(line) && line.includes(nameFragment)
  ));
  assert.notEqual(
    from,
    -1,
    `anchor lost: no step named like "${nameFragment}"${inJob ? ` in job \`${inJob}\`` : ''} in ${WORKFLOW_PATH}`,
  );
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i += 1) {
    if (/^ {6}- (name|uses):/.test(lines[i]!) || /^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]!)) { to = i; break; }
  }
  return { from, to };
}

function withoutStep(workflow: string, nameFragment: string): string {
  const lines = workflow.split('\n');
  const { from, to } = stepSpan(lines, nameFragment);
  return [...lines.slice(0, from), ...lines.slice(to)].join('\n');
}

/** Rewrite the lines of one step through `edit`. */
function editStep(workflow: string, nameFragment: string, edit: (line: string) => string, inJob?: string): string {
  const lines = workflow.split('\n');
  const { from, to } = stepSpan(lines, nameFragment, inJob);
  const before = lines.slice(from, to).join('\n');
  const after = lines.slice(from, to).map(edit).join('\n');
  assert.notEqual(after, before, `anchor lost: editing "${nameFragment}" changed nothing`);
  return [...lines.slice(0, from), ...after.split('\n'), ...lines.slice(to)].join('\n');
}

/** Insert lines immediately after the step whose name contains `nameFragment`. */
function afterStep(workflow: string, nameFragment: string, inserted: readonly string[]): string {
  const lines = workflow.split('\n');
  const { to } = stepSpan(lines, nameFragment);
  return [...lines.slice(0, to), ...inserted, ...lines.slice(to)].join('\n');
}

/** Add a JOB-level key immediately under a job's header (the enforcing job by default). */
function withJobKey(workflow: string, keyLine: string, jobId: string = ENFORCING_JOB): string {
  const header = `\n  ${jobId}:\n`;
  assert.ok(workflow.includes(header), `anchor lost: the \`${jobId}\` job header moved`);
  return workflow.replace(header, `${header}${keyLine}\n`);
}

/** Move `mover` to sit immediately BEFORE `target`, which must currently precede it. */
function moveStepBefore(workflow: string, mover: string, target: string, inJob?: string): string {
  const lines = workflow.split('\n');
  const from = stepSpan(lines, mover, inJob);
  const to = stepSpan(lines, target, inJob);
  assert.ok(to.from < from.from, `anchor lost: "${target}" no longer precedes "${mover}"`);
  const moved = lines.slice(from.from, from.to);
  const rest = [...lines.slice(0, from.from), ...lines.slice(from.to)];
  return [...rest.slice(0, to.from), ...moved, ...rest.slice(to.from)].join('\n');
}

const SESSION_FILE = 'src/modules/session/__tests__/session-updates-surface.test.ts';

/**
 * Every case: a name, the workflow it produces, and the substring its finding
 * must carry.
 *
 * The workflow is a THUNK rather than a string, and that is a fix for a
 * misattribution rather than style. Every case anchors itself in the committed
 * file, and an anchor that stops matching throws — so with the workflows built
 * eagerly, one moved anchor killed this file at MODULE LOAD, before a single
 * test ran, with a message about the anchor. The case worth the example is the
 * one that strips the numeric requirement out of a report step by literal
 * replacement: weaken the numeric shape in the workflow and the replacement
 * matches nothing, so what the maintainer was told is "anchor lost" when what
 * happened is that the numeric requirement moved. Built lazily, that is one
 * named row failing, and the row's name says which property is at stake.
 */
const HOLLOW_WORKFLOWS: readonly {
  readonly name: string;
  readonly workflow: () => string;
  readonly names: string;
}[] = [
  {
    // THE ONE THAT MOTIVATED ALL OF THIS. Both session-start steps deleted; the
    // filename survives in a comment inside the serial job and on an `echo`
    // inside the PARALLEL job. Under the substring checker this was green.
    name: 'the enforcing job runs nothing, and the filename survives only in a comment and in another job',
    workflow: () => (() => {
      let workflow = withoutStep(committedWorkflow, 'Report the session-start verdicts');
      workflow = withoutStep(workflow, 'Session-start p95 budgets');
      workflow = editStep(workflow, 'Per-event hook timing', (line) => (
        /^ {6}- name:/.test(line) ? `      # was: ${SESSION_FILE}\n${line}` : line
      ));
      return editStep(workflow, 'Compiled-runtime smoke', (line) => (
        line.includes('npm run smoke 2>&1')
          ? `          echo "see ${SESSION_FILE}"\n${line}`
          : line
      ));
    })(),
    names: SESSION_FILE,
  },
  {
    // THE DEFEAT THAT WAS STILL GREEN LAST ROUND, and the reason this module
    // detects an INVOCATION rather than a mention. The measurement step keeps
    // its name, its `if:`, its `set -o pipefail`, its pipe and its log — every
    // property the audit checks about a measurement step — and runs an `echo`
    // where the test runner was. The file is named on a genuine `run:` line,
    // inside the ENFORCING job, so "is the file named in this job's steps" says
    // yes; the step measures nothing. Its log is then a file the step wrote by
    // hand, which is the other half of the same defeat and is refused at
    // runtime by the report step's own shell — see the faked-log rows below.
    name: 'the measurement step echoes the file instead of running it, keeping its log and its pipefail',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => {
      if (line.includes('node --import')) {
        return `          echo "temporarily skipping ${SESSION_FILE}" | tee "$RUNNER_TEMP/session-latency.log"`;
      }
      return line.includes(SESSION_FILE) || line.includes('| tee') ? '' : line;
    }),
    names: 'but not as an argument to a test runner',
  },
  {
    name: 'the measurement is commented out in place',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      line.trimStart().startsWith('node --import') || line.includes(SESSION_FILE) || line.includes('| tee')
        ? `          # ${line.trim()}`
        : line
    )),
    names: SESSION_FILE,
  },
  {
    name: 'the file is named by a LATER job instead, which is what the job slice used to reach into',
    workflow: () => (() => {
      const workflow = withoutStep(
        withoutStep(committedWorkflow, 'Report the session-start verdicts'),
        'Session-start p95 budgets',
      );
      return editStep(workflow, 'Full test-environment composition proof', (line) => (
        line.includes('npm run test:env')
          ? `        run: echo ${SESSION_FILE} && npm run test:env -- --strict --host=claude,codex`
          : line
      ));
    })(),
    names: SESSION_FILE,
  },
  {
    name: 'the enforcing job is renamed, which the old "job is gone" guard could not see',
    workflow: () => committedWorkflow.replace('\n  latency-budget:\n', '\n  latency-budget-renamed:\n'),
    names: `no job \`${ENFORCING_JOB}\``,
  },
  {
    // M2, exactly: the report step for ONE measurement is deleted. A count of
    // `did not run::` markers across the job still clears, because the hook
    // timing report step alone carries three.
    name: 'one measurement loses its report step while another step still carries three guards',
    workflow: () => withoutStep(committedWorkflow, 'Report the session-start verdicts'),
    names: 'no report step of its own',
  },
  {
    // Without `always()` a step defaults to `success()`, so the report is
    // skipped on exactly the runs where an earlier step went red — and those
    // are the runs where "did this measurement actually happen" is a live
    // question rather than a formality.
    name: 'a report step loses if: always() and so stops running when it is most needed',
    workflow: () => editStep(committedWorkflow, 'Report the session-start verdicts', (line) => (
      line.trim() === 'if: always()' ? '' : line
    )),
    names: 'no report step of its own',
  },
  {
    name: 'a report step stops being able to fail',
    workflow: () => editStep(committedWorkflow, 'Report the session-start verdicts', (line) => (
      line.trim() === '[ "$fail" = 0 ] || exit 1' ? '          [ "$fail" = 0 ] || true' : line
    )),
    names: 'no report step of its own',
  },
  {
    name: 'pipefail is dropped, so a failing budget exits 0 through tee',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      line.trim() === 'set -o pipefail' ? '' : line
    )),
    names: 'set -o pipefail',
  },
  {
    // `set -o pipefail` affects pipelines that run AFTER it. Present-anywhere
    // is therefore not the property; present-first is.
    name: 'pipefail is present but set after the pipeline it was supposed to protect',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      line.trim() === 'set -o pipefail' ? '          # moved below\n' : (
        line.includes('| tee "$RUNNER_TEMP/session-latency.log"') ? `${line}\n          set -o pipefail` : line
      )
    )),
    names: 'set -o pipefail',
  },
  {
    name: 'a measurement step is told to continue on error',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      /^ {6}- name:/.test(line) ? `${line}\n        continue-on-error: true` : line
    )),
    names: 'continue-on-error',
  },
  {
    name: 'a measurement loses its !cancelled() condition, so an earlier breach skips it',
    workflow: () => editStep(committedWorkflow, 'Per-event hook timing', (line) => (
      line.trim().startsWith('if: ${{ !cancelled()') ? '' : line
    )),
    names: '!cancelled()',
  },
  // ── the four report-step properties, one case each ────────────────────────
  // Found by mutation testing, and every one of them was a hole: deleting the
  // numeric requirement, the verdict requirement, the annotation marker or the
  // `|| true` check from the audit broke NO test in this file, which means the
  // static half of the blocker's proof was resting on the same "the code looks
  // right" argument this whole module exists to replace.
  {
    // The numeric requirement, which is the blocker. A report step that greps
    // for the instrument's verdict PHRASE and not for its numbers is satisfied
    // by an `echo "LATENCY BUDGET PASS · <label>"`, which is a string the hollow
    // step can print. Numbers are what a measurement produces.
    name: 'a report step asks for the verdict phrase but not for the numbers under it',
    workflow: () => editStep(committedWorkflow, 'Report the session-start verdicts', (line) => (
      line
        .replace(
          '[[:space:]]+n=[[:space:]]*[1-9][0-9]*  wall p50/p95/max'
          + ' [0-9]+\\.[0-9]{2}/[0-9]+\\.[0-9]{2}/[0-9]+\\.[0-9]{2} ms',
          '',
        )
        .replace(' · wall p95 [0-9]+\\.[0-9]{2} ms >= [0-9.]+ ms', '')
    )),
    names: 'no report step of its own',
  },
  {
    // The other half of the pair: numbers demanded, but not tied to the
    // instrument's own verdict line, so any log with a `wall p50/p95/max` in it
    // anywhere satisfies the step.
    name: 'a report step asks for numbers but not for the instrument that produced them',
    workflow: () => editStep(committedWorkflow, 'Report the session-start verdicts', (line) => (
      line.replace(/LATENCY BUDGET/g, 'MEASUREMENT')
    )),
    names: 'no report step of its own',
  },
  {
    // The annotation marker. `did not run::` is what makes the failure findable
    // in a GitHub run — an `exit 1` with no annotation is a red step with no
    // sentence attached to it, which is how a maintainer concludes the check is
    // noise and deletes it.
    name: 'a report step exits 1 without the annotation that says what did not run',
    workflow: () => editStep(committedWorkflow, 'Report the session-start verdicts', (line) => (
      line.replace(/did not run::/g, 'something happened::')
    )),
    names: 'no report step of its own',
  },
  {
    // `|| true` as a COMMAND. Its own case because the step that used to cover
    // it also broke three other properties at once, so the swallow check could
    // be deleted with the case still green.
    name: 'a step in the enforcing job swallows its failure with || true',
    workflow: () => afterStep(committedWorkflow, 'Report the session-start verdicts', [
      '      - name: "Tidy up (and swallow whatever it says)"',
      '        if: always()',
      '        shell: bash',
      '        run: node --version || true',
    ]),
    names: '|| true',
  },
  {
    // A measurement with no log at all. Nothing downstream can then check that
    // the measurement it names happened, and the audit has to say so — the
    // pairing check never runs, so this is the one finding standing between an
    // unverifiable measurement and a green job.
    name: 'a measurement invokes the file but tees its output nowhere',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      line.includes('| tee "$RUNNER_TEMP/session-latency.log"')
        ? line.replace(' 2>&1 \\', '').replace(/\| tee "\$RUNNER_TEMP\/session-latency\.log"/, '')
        : line.replace(' 2>&1 \\', '')
    )),
    names: 'tees to no log',
  },
  // ── the three JOB-LEVEL self-mutes ────────────────────────────────────────
  // Every case above edits a STEP, and so did every attack this file had been
  // driven with, which is why all three of these were green while defeating the
  // whole audit. GitHub evaluates a job-level `continue-on-error:` and a
  // job-level `if:` above everything a step can say, and the reader used to
  // discard every key at that indent.
  {
    // The strongest of the three: no step changes at all. Each step runs, each
    // report step still exits 1, and the workflow is green because a job that
    // continues on error does not fail the run.
    name: 'the whole job is told to continue on error, and no step is touched',
    workflow: () => withJobKey(committedWorkflow, '    continue-on-error: true'),
    names: 'JOB-LEVEL `continue-on-error',
  },
  {
    // The runtime half cannot cover for this one: no step runs, so no report
    // step reads a log, so nothing is there to notice.
    name: 'the job is restricted to manual dispatch, so no step runs on a push',
    workflow: () => withJobKey(committedWorkflow, "    if: github.event_name == 'workflow_dispatch'"),
    names: 'JOB-LEVEL `if:',
  },
  {
    name: 'the job carries a condition that is simply never true',
    workflow: () => withJobKey(committedWorkflow, '    if: false'),
    names: 'JOB-LEVEL `if:',
  },
  {
    // The third spelling of "this job does not run": a matrix with nothing in
    // it. `include: []` is valid YAML and valid Actions, and it produces zero
    // job instances.
    name: 'the job is put behind a matrix with an empty include list',
    workflow: () => withJobKey(committedWorkflow, '    strategy:\n      matrix:\n        include: []'),
    names: 'declares a `strategy:`',
  },
  {
    // The step-level twin, which the boolean form of the reader missed: only
    // the literal `true` was recognised, so an expression — evaluating to
    // whatever the maintainer likes — read as clean.
    name: 'a measurement continues on error through an expression rather than a literal',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      /^ {6}- name:/.test(line) ? `${line}\n        continue-on-error: \${{ github.event_name == 'push' }}` : line
    )),
    names: 'continue-on-error',
  },
  {
    // `!cancelled()` was checked as a SUBSTRING, so a condition keeping the
    // token and adding a term that is never true kept the step in the file and
    // out of the run.
    name: 'a measurement keeps its !cancelled() token and adds a term that is never true',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      line.trim().startsWith('if: ${{ !cancelled()') ? '        if: ${{ !cancelled() && false }}' : line
    )),
    names: 'exact conditions',
  },
  {
    // The shell a step declares decides what its body DOES — `shell: bash` is
    // `bash --noprofile --norc -eo pipefail {0}`, `sh` is another shell
    // entirely — and the reader did not record the key at all.
    name: 'a report step is switched to a different shell than the one its proof runs',
    workflow: () => editStep(committedWorkflow, 'Report the session-start verdicts', (line) => (
      line.trim() === 'shell: bash' ? '        shell: sh' : line
    )),
    names: 'does not declare `shell: bash`',
  },
  {
    // And the measurement side of the same key. `set -o pipefail` on the first
    // line of the body is a bash builtin; under `shell: sh` on ubuntu (dash)
    // the option exists, but the step is no longer the thing anything here was
    // measured against.
    name: 'a measurement is switched to a different shell than its `set -o pipefail` assumes',
    workflow: () => editStep(committedWorkflow, 'Session-start p95 budgets', (line) => (
      line.trim() === 'shell: bash' ? '        shell: sh' : line
    )),
    names: 'does not declare `shell: bash`',
  },
  {
    // ORDER. Steps run top to bottom, so a report step above its measurement
    // reads a log that does not exist yet — and its own `[ -f "$log" ] || exit 0`
    // makes it a silent no-op. The audit's `after` slice is what refuses this,
    // and nothing exercised it, so the slice could be widened to the whole step
    // list with every other case still green.
    name: 'a report step is moved above the measurement it reports on',
    workflow: () => moveStepBefore(committedWorkflow, 'Report the session-start verdicts', 'Session-start p95 budgets'),
    names: 'no report step of its own',
  },
  // ── the fourth key at job level, and the reason the rule is now inverted ───
  // Both of these were green through three rounds of naming the key that
  // defeated the round before. Neither is refused BY NAME now: the job may
  // carry only the keys ALLOWED_JOB_KEYS lists, so the next unconsidered key —
  // whatever it is — reds without anybody having met it first.
  {
    // A skipped dependency skips this job, and a skipped job does not fail a
    // run. Two lines, no step touched, every budget unenforced, green.
    name: 'the job is made to depend on a job that never runs',
    workflow: () => withJobKey(
      committedWorkflow.replace('\njobs:\n', '\njobs:\n  gate:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n'),
      '    needs: gate',
    ),
    names: 'job-level `needs:`',
  },
  {
    // And the shape that needs no new job at all: depend on the fast path, and
    // every budget goes unenforced on exactly the runs where something is
    // already wrong — while the runner this job wanted to be idle has just
    // finished a 3409-test suite anyway.
    name: 'the job is made to depend on the fast job, so a red there unenforces every budget',
    workflow: () => withJobKey(committedWorkflow, '    needs: generate-check'),
    names: 'job-level `needs:`',
  },
  // ── the triggers, which the job-level `if:` refusal rests on ──────────────
  {
    name: 'the push and pull_request triggers are replaced with a manual one',
    workflow: () => committedWorkflow.replace('\non:\n  push:\n  pull_request:\n', '\non:\n  workflow_dispatch:\n'),
    names: 'rather than on exactly',
  },
  {
    name: 'a path filter is attached to both triggers, so the job runs only on the pushes somebody chose',
    workflow: () => committedWorkflow.replace(
      '\non:\n  push:\n  pull_request:\n',
      "\non:\n  push:\n    paths:\n      - 'src/**'\n  pull_request:\n    paths:\n      - 'src/**'\n",
    ),
    names: 'attaches `push.paths`',
  },
  // ── the step identity the admitted condition names ────────────────────────
  // Three edits, each one line, each leaving every rule above untouched and
  // every measurement skipped. The allowlist fixes the condition's SPELLING;
  // these are about the state it reads.
  {
    name: 'the install step loses the id its conditions name, so every measurement resolves to null and skips',
    workflow: () => editStep(committedWorkflow, 'Install dependencies', (line) => (
      line.trim() === 'id: install' ? '' : line
    ), ENFORCING_JOB),
    names: 'NO step in this job declares `id: install`',
  },
  {
    name: 'the install step is given a condition that never holds, so its outcome is `skipped`',
    workflow: () => editStep(committedWorkflow, 'Install dependencies', (line) => (
      line.trim() === 'id: install' ? `${line}\n        if: false` : line
    ), ENFORCING_JOB),
    names: 'itself carries `if:',
  },
  {
    name: 'the step the conditions name is moved below the measurements that read its outcome',
    workflow: () => moveStepBefore(
      committedWorkflow,
      'Write pre-tool p95 budget',
      'Install dependencies',
      ENFORCING_JOB,
    ),
    names: 'runs AFTER it',
  },
  // ── the report step's own condition, allowlisted for the same reason ──────
  {
    // `always()` was a substring test, so this kept the token and never ran —
    // and a report step that never runs is the hollow green it exists to refuse.
    name: 'a report step keeps its always() token and adds a term that is never true',
    workflow: () => editStep(committedWorkflow, 'Report the session-start verdicts', (line) => (
      line.trim() === 'if: always()' ? '        if: ${{ always() && false }}' : line
    )),
    names: 'no report step of its own',
  },
  // ── the switch that makes a three-valued row fatal somewhere ──────────────
  {
    name: 'the instrument self-check keeps its step and loses the strict switch that makes its skip fatal',
    workflow: () => editStep(committedWorkflow, 'Latency instrument self-check', (line) => (
      line.trim() === `${STRICT_ENV}: '1'` ? '' : line
    )),
    names: `without \`${STRICT_ENV}: '1'\``,
  },
  // ── the machine the measurements are taken on ─────────────────────────────
  // `runs-on:` was on the allowlist with its value unread, defended by an
  // argument about a label that does not EXIST. Both of these are labels that
  // do, and both were green.
  {
    name: 'the enforcing job is moved to a shared self-hosted runner, where four of five budgets go inconclusive',
    workflow: () => committedWorkflow.replace(
      '  latency-budget:\n    name: "Latency budget (serial)"\n    runs-on: ubuntu-latest\n',
      '  latency-budget:\n    name: "Latency budget (serial)"\n    runs-on: [self-hosted, linux, shared]\n',
    ),
    names: 'rather than on `ubuntu-latest`',
  },
  {
    name: 'the enforcing job loses its runs-on entirely',
    workflow: () => committedWorkflow.replace(
      '  latency-budget:\n    name: "Latency budget (serial)"\n    runs-on: ubuntu-latest\n',
      '  latency-budget:\n    name: "Latency budget (serial)"\n',
    ),
    names: 'declares no `runs-on:`',
  },
  // ── the job that runs this checker, which nothing audited ─────────────────
  // The recursion used to terminate on an unaudited job: `auditEnforcingJob`
  // was only ever called for `latency-budget`, and the row naming the checker's
  // own job asserted the job NAMES and nothing they carry. Each of these was 96
  // pass / 0 fail before `auditCheckerJob` existed.
  {
    // The strongest: the suite still runs, still reds, the job still reds — and
    // the RUN is green, so every rule in this file is evaluated with nothing
    // riding on the answer.
    name: 'the job that runs this checker is told to continue on error',
    workflow: () => withJobKey(committedWorkflow, '    continue-on-error: true', CHECKER_JOB),
    names: 'JOB-LEVEL `continue-on-error',
  },
  {
    name: 'the job that runs this checker is restricted to manual dispatch',
    workflow: () => withJobKey(committedWorkflow, "    if: github.event_name == 'workflow_dispatch'", CHECKER_JOB),
    names: 'JOB-LEVEL `if:',
  },
  {
    name: 'the job that runs this checker is made to depend on the job it is supposed to check',
    workflow: () => withJobKey(committedWorkflow, `    needs: ${ENFORCING_JOB}`, CHECKER_JOB),
    names: `job \`${CHECKER_JOB}\` carries a job-level \`needs:\``,
  },
  {
    name: 'the checker job keeps its matrix and empties it, so the suite runs zero times',
    workflow: () => committedWorkflow.replace(
      '    strategy:\n      fail-fast: false\n      matrix:\n        os: [ubuntu-latest, macos-latest]\n',
      '    strategy:\n      fail-fast: false\n      matrix:\n        include: []\n',
    ),
    names: 'no non-empty matrix dimension',
  },
  {
    name: 'the step that runs the suite echoes it instead, so this file is never executed',
    workflow: () => editStep(committedWorkflow, 'Tests', (line) => (
      line.includes('npm test 2>&1') ? '          echo "npm test 2>&1" | tee "$RUNNER_TEMP/npm-test.log"' : line
    ), CHECKER_JOB),
    names: 'no step that reachably runs `npm test`',
  },
  // ── the STEP axis on the checker job, which is where the defeat moved ─────
  // Job-level coverage became exhaustive last round and the boundary was drawn
  // around it, so these four went in one level down and stayed green: each is
  // ONE line against the committed file, each leaves every job-level rule
  // satisfied, and each leaves the suite — this file — unexecuted. The first
  // two are the job-level condition attack at step scope; the second two do not
  // touch a condition at all and silence the runner from inside.
  {
    name: 'the step that runs the suite is switched off by a step-level condition',
    workflow: () => editStep(committedWorkflow, 'Tests', (line) => (
      line.trim() === 'shell: bash' ? '        if: false\n        shell: bash' : line
    ), CHECKER_JOB),
    names: 'carries `if: false`',
  },
  {
    name: 'the step that runs the suite is restricted to manual dispatch, one level below the job',
    workflow: () => editStep(committedWorkflow, 'Tests', (line) => (
      line.trim() === 'shell: bash'
        ? "        if: ${{ github.event_name == 'workflow_dispatch' }}\n        shell: bash"
        : line
    ), CHECKER_JOB),
    names: "carries `if: ${{ github.event_name == 'workflow_dispatch' }}`",
  },
  {
    // Not a condition and not a deletion: the command runs, exits 0, and the
    // log reads green. Measured on Node 26.5.0 over a file holding one FAILING
    // test — `tests 1 / pass 1 / fail 0`.
    name: 'the suite is invoked with a name filter that matches nothing, so it runs and reports nothing',
    workflow: () => editStep(committedWorkflow, 'Tests', (line) => (
      line.includes('npm test 2>&1')
        ? line.replace('npm test 2>&1', "npm test -- --test-name-pattern='zzzz-no-such-test' 2>&1")
        : line
    ), CHECKER_JOB),
    names: 'passes `-- --test-name-pattern=zzzz-no-such-test` to `npm test`',
  },
  {
    // The same defeat in fewer characters, and the one that needs no invented
    // pattern: `--test-only` runs the tests marked `only` and this repo marks
    // none.
    name: 'the suite is invoked in only-mode, and nothing in the repo is marked only',
    workflow: () => editStep(committedWorkflow, 'Tests', (line) => (
      line.includes('npm test 2>&1') ? line.replace('npm test 2>&1', 'npm test -- --test-only 2>&1') : line
    ), CHECKER_JOB),
    names: 'passes `-- --test-only` to `npm test`',
  },
  // ── and the same defeat arriving where no workflow rule can see it ────────
  // A filter in the `test` script, in NODE_OPTIONS, or in an .npmrc produces
  // the identical silent green with the `run:` line above untouched. The only
  // thing that can see it is the runner's own count, so the step that reads it
  // is required rather than recommended — and these two are what "required"
  // means: remove the floor comparison, or remove the log it reads.
  {
    name: 'the step that holds the suite to a minimum count keeps its shape and loses the comparison',
    workflow: () => editStep(committedWorkflow, 'Refuse a suite that ran (almost) nothing', (line) => (
      line.includes('-lt "$floor"') ? line.replace('-lt "$floor"', '-gt 0') : line
    ), CHECKER_JOB),
    names: 'MINIMUM COUNT',
  },
  {
    name: 'the suite step stops teeing its output, so no count can be read from it',
    workflow: () => editStep(committedWorkflow, 'Tests', (line) => (
      line.includes('npm test 2>&1') ? '          npm test' : line
    ), CHECKER_JOB),
    names: 'without teeing it to a log',
  },
  {
    name: 'the enforcing job is emptied of steps entirely',
    workflow: () => (() => {
      const lines = committedWorkflow.split('\n');
      const from = lines.findIndex((line) => line === '  latency-budget:');
      assert.notEqual(from, -1, 'anchor lost: the latency-budget job header moved');
      let to = lines.length;
      for (let i = from + 1; i < lines.length; i += 1) {
        if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]!)) { to = i; break; }
      }
      return [...lines.slice(0, from), '  latency-budget:', ...lines.slice(to)].join('\n');
    })(),
    names: 'zero steps',
  },
];

test('every adversarial case is distinct, and there are as many as this file thinks', () => {
  // A count in code rather than in prose. It exists to make a DELETION visible:
  // a case that stops being a counterexample is normally removed rather than
  // fixed, and a suite that silently shrinks by one is how the defeat this file
  // was written for came back.
  assert.equal(HOLLOW_WORKFLOWS.length, 49, 'add or remove a case and update this number in the same commit');
  const built = HOLLOW_WORKFLOWS.map((scenario) => {
    try {
      return scenario.workflow();
    } catch (error) {
      // Named, because the whole reason these are thunks is that an anchor
      // failure used to arrive as a file-wide death with no case attached.
      return assert.fail(`case "${scenario.name}" could not be built against the committed workflow: ${error}`);
    }
  });
  assert.equal(
    new Set(built).size,
    HOLLOW_WORKFLOWS.length,
    'two cases produce the SAME workflow, so one of them proves nothing it does not already prove',
  );
  // And none of them is the committed file: a case whose edit silently stopped
  // applying would otherwise assert that the real workflow fails the audit.
  assert.ok(
    !built.some((workflow) => workflow === committedWorkflow),
    'a case produced the committed workflow unchanged, so its anchor is gone',
  );
});

for (const scenario of HOLLOW_WORKFLOWS) {
  test(`the checker goes red when ${scenario.name}`, () => {
    const findings = auditCommitted(scenario.workflow());
    assert.notDeepEqual(findings, [], 'the checker certified a workflow that does not enforce the budget');
    assert.ok(
      findings.some((finding) => finding.includes(scenario.names)),
      `the checker went red for the wrong reason. Expected a finding mentioning ${JSON.stringify(scenario.names)},`
      + ` got:\n${findings.map((finding) => `  - ${finding}`).join('\n')}`,
    );
  });
}

test('the pipefail check goes red when the full-suite step loses it', () => {
  // The parallel job, which the enforcing-job audit above does not look at, and
  // the single highest-value instance: without this line a completely red
  // `npm test` exits 0.
  const hollow = editStep(committedWorkflow, 'Tests', (line) => (
    line.trim() === 'set -o pipefail' ? '' : line
  ));
  const offenders = stepsPipingWithoutPipefail(hollow);
  assert.notDeepEqual(offenders, [], 'a suite that cannot fail its own step was certified');
  assert.ok(offenders.some((step) => step.startsWith('generate-check / "Tests"')), offenders.join(', '));

  // And ordering, not mere presence: a `set -o pipefail` below the pipeline it
  // was meant to protect is the same hole with the line still in the diff.
  const reordered = editStep(committedWorkflow, 'Tests', (line) => (
    line.trim() === 'set -o pipefail' ? '' : (
      line.includes('| tee "$RUNNER_TEMP/npm-test.log"') ? `${line}\n          set -o pipefail` : line
    )
  ));
  assert.ok(
    stepsPipingWithoutPipefail(reordered).some((step) => step.startsWith('generate-check / "Tests"')),
    'pipefail set after the pipeline was accepted',
  );
});

test('an aliased import is still a file that asserts a budget', () => {
  // The fail-open this replaced: the call-shaped regexes matched neither the
  // import nor the call site, so the file vanished from the coverage set and
  // the check passed by not knowing about it.
  for (const source of [
    "import { assertLatencyBudget as budget } from '../../test-support/__tests__/latency-budget';\nbudget(t, {});",
    "import {\n  assertLatencyBudgetAsync as timed,\n} from '../latency-budget';\nawait timed(t, {});",
    "import * as lb from '../latency-budget';\nlb.assertLatencyBudget(t, {});",
    "import { assertLatencyBudget } from '../latency-budget';\nassertLatencyBudget(t, {});",
  ]) {
    assert.ok(bindsAnAssertingEntryPoint(source), `not detected:\n${source}`);
  }
  for (const source of [
    "import { classifyLatency } from './latency-budget';\nclassifyLatency(a, b);",
    "import { measureLatencyBudget } from './latency-budget';",
    "// assertLatencyBudget is mentioned in prose only",
    "const ASSERTING_ENTRY_POINTS = ['assertLatencyBudget'];",
  ]) {
    assert.ok(!bindsAnAssertingEntryPoint(source), `false positive:\n${source}`);
  }
});

// ── the reader's own grammar, driven directly ───────────────────────────────
// Every case above goes through the committed workflow, which exercises exactly
// the spellings this repo happens to use today. The failure mode that motivated
// the reader is a spelling it does NOT use: an unreadable job header does not
// drop a job, it MERGES it into the one before, so the audit reads the next
// job's steps as the enforcing job's and reports that measurements it never
// runs are fine. That is a fail-open reached by a maintainer adding a comment.

/** A two-job workflow whose first job header is spelled `header`. */
function twoJobs(header: string): string {
  return [
    'name: x',
    'jobs:',
    header,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: measure',
    '        run: node --test a.test.ts',
    '  other:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: something else entirely',
    '        run: node --test b.test.ts',
    '',
  ].join('\n');
}

test('every ordinary spelling of a job header is read as a job, so no job absorbs the next one', () => {
  for (const header of [
    '  budget:',
    '  budget:  # the enforcing job',
    '  "budget":',
    "  'budget':",
    '  budget :',
    '  budget:\t',
    '  budget:  ',
  ]) {
    const jobs = parseWorkflowJobs(twoJobs(header));
    assert.deepEqual(
      jobs.map((job) => job.id),
      ['budget', 'other'],
      `header ${JSON.stringify(header)} was not read as a job header, so the job after it was merged into it`,
    );
    // The consequence, stated rather than implied: a merged job hands the audit
    // the NEXT job's steps, and `b.test.ts` is what it would then believe the
    // enforcing job invokes.
    const invoked = jobs[0]!.steps.flatMap((step) => testFilesInvokedBy(step));
    assert.deepEqual(invoked, ['a.test.ts'], `header ${JSON.stringify(header)} leaked the next job's steps`);
  }
});

// ── the reader's own fidelity, differentially ───────────────────────────────
// THE CHECK THAT WAS MISSING WHILE 96 OTHERS PASSED. Every rule in
// ci-workflow.ts cites one fact — what I see is what GitHub sees — and until
// now the component that produces that view was the only one here with no test
// of its own. Five one-line, fully green defeats came out of that gap at once,
// all of them ordinary YAML the indentation grammar could not spell: a quoted
// key at job level (`"needs": generate-check` — the exact key round 5 inverted
// the rule to catch), a quoted `continue-on-error:` on a step, and a step whose
// first key is quoted, which merged into the step BEFORE it.
//
// The grammar is gone; the document is parsed by `yaml`. What is left of this
// module's own is the PROJECTION onto jobs, steps and keys, and every one of
// those defeats was a projection defect: a key dropped, a step attached to its
// neighbour. So the projection is compared, key for key, against an INDEPENDENT
// traversal of the same document — `yaml`'s plain-value API, which shares no
// code with the projection's document-API walk.
//
// WHAT THIS IS NOT. `yaml` is not GitHub, which parses workflows with its own
// implementation, so this is agreement with a widely used YAML 1.2 parser and
// not proof about the runner. That residual is stated rather than closed. What
// it replaces was a grammar that could be defeated by a quotation mark.

/** Job ids, each job's key names, and each step's key names — straight from `yaml`. */
function oracleShape(text: string): Record<string, { keys: string[]; steps: string[][] }> {
  const document = parseYaml(text, { logLevel: 'silent' }) as unknown;
  const shape: Record<string, { keys: string[]; steps: string[][] }> = {};
  if (typeof document !== 'object' || document === null) return shape;
  const jobs = (document as Record<string, unknown>)['jobs'];
  if (typeof jobs !== 'object' || jobs === null) return shape;
  for (const [id, body] of Object.entries(jobs as Record<string, unknown>)) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      shape[id] = { keys: [], steps: [] };
      continue;
    }
    const steps = (body as Record<string, unknown>)['steps'];
    shape[id] = {
      keys: Object.keys(body as Record<string, unknown>),
      steps: Array.isArray(steps)
        ? steps
          .filter((step) => typeof step === 'object' && step !== null && !Array.isArray(step))
          .map((step) => Object.keys(step as Record<string, unknown>))
        : [],
    };
  }
  return shape;
}

/** The same shape, as the audit's reader sees it. */
function readerShape(text: string): Record<string, { keys: string[]; steps: string[][] }> {
  const shape: Record<string, { keys: string[]; steps: string[][] }> = {};
  for (const job of parseWorkflowJobs(text)) {
    shape[job.id] = {
      keys: job.keys.map((key) => key.name),
      steps: job.steps.map((step) => stepKeyNames(step)),
    };
  }
  return shape;
}

/**
 * The key names one step declares, reconstructed from what the reader kept.
 *
 * The reader does not store a step's raw key list — it stores the eight
 * properties the rules ask about — so this is the inverse of that projection,
 * and writing it out is what makes the comparison meaningful: a key that is
 * present in the document and reaches none of these fields shows up here as a
 * missing name.
 */
function stepKeyNames(step: WorkflowStep): string[] {
  const names: string[] = [];
  if (step.uses !== null) names.push('uses');
  if (step.name !== '' && step.name !== step.uses) names.push('name');
  if (step.if !== null) names.push('if');
  if (step.continueOnError) names.push('continue-on-error');
  if (step.shell !== null) names.push('shell');
  if (step.id !== null) names.push('id');
  if (step.env.size > 0) names.push('env');
  if (step.run.length > 0) names.push('run');
  return names.sort();
}

/** The oracle's step keys, reduced to the ones the reader is supposed to carry. */
function projectedOracleStepKeys(keys: readonly string[]): string[] {
  const carried = new Set(['uses', 'name', 'if', 'continue-on-error', 'shell', 'id', 'env', 'run']);
  return keys.filter((key) => carried.has(key)).sort();
}

/**
 * One adversarial document, and what this module owes it.
 *
 * `agree` means the reader's job-key sets and per-step key sets must equal the
 * oracle's. `refuse` means the reader must report NO JOBS — the fail-closed
 * answer, which reddens the audit — because the document is one GitHub will not
 * run either.
 */
const READER_CORPUS: readonly {
  readonly name: string;
  readonly text: string;
  readonly expect: 'agree' | 'refuse';
}[] = [
  {
    name: 'a double-quoted key at job level, which the grammar could not spell',
    expect: 'agree',
    text: 'jobs:\n  budget:\n    "continue-on-error": true\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n',
  },
  {
    name: 'a single-quoted key at job level',
    expect: 'agree',
    text: "jobs:\n  budget:\n    'if': false\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n",
  },
  {
    name: 'a quoted FIRST key on a step, which used to merge the step into the one before it',
    expect: 'agree',
    text: 'jobs:\n  budget:\n    steps:\n      - name: first\n        run: node --test a.test.ts\n      - "name": second\n        run: node --test b.test.ts\n',
  },
  {
    name: 'a quoted key in the middle of a step',
    expect: 'agree',
    text: 'jobs:\n  budget:\n    steps:\n      - name: one\n        "continue-on-error": true\n        run: npm ci\n',
  },
  {
    name: 'a step written as a flow mapping',
    expect: 'agree',
    text: 'jobs:\n  budget:\n    steps:\n      - { name: one, run: node --test a.test.ts }\n',
  },
  {
    name: 'a whole job written as a flow mapping',
    expect: 'agree',
    text: 'jobs:\n  budget: { runs-on: ubuntu-latest, needs: other, steps: [ { run: npm ci } ] }\n',
  },
  {
    name: 'a job id that is quoted and carries a colon',
    expect: 'agree',
    text: 'jobs:\n  "a:b":\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n',
  },
  {
    name: 'comments in every position a comment can take',
    expect: 'agree',
    text: [
      '# leading',
      'jobs:  # after the jobs key',
      '  # between',
      '  budget:  # after the job header',
      '    runs-on: ubuntu-latest  # after a value',
      '    steps:',
      '      # before a step',
      '      - name: one  # after a step key',
      '        run: |  # after a block header',
      '          # a shell comment, which is prose too',
      '          node --test a.test.ts',
      '# trailing',
      '',
    ].join('\n'),
  },
  {
    name: 'a literal block scalar with a chomping and an indentation indicator',
    expect: 'agree',
    text: 'jobs:\n  budget:\n    steps:\n      - name: one\n        run: |2-\n          node --test a.test.ts\n',
  },
  {
    name: 'an empty job body',
    expect: 'agree',
    text: 'jobs:\n  budget:\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n',
  },
  {
    name: 'a `steps:` that is a scalar rather than a sequence',
    expect: 'agree',
    text: 'jobs:\n  budget:\n    steps: NOT A STEP\n',
  },
  {
    // REFUSED FOR A ROUND, ON A FALSE CITATION. "GitHub Actions does not
    // support anchors or aliases" was true for years and stopped being true on
    // 2025-09-18; GitHub's own documentation for the feature reuses an entire
    // job configuration, which is this row. The refusal cost was not
    // theoretical — it turned a documented DRY refactor of the five duplicated
    // report steps into three findings claiming present jobs were missing.
    name: 'an anchor and an alias, which GitHub Actions has supported since 2025-09-18',
    expect: 'agree',
    text: 'jobs:\n  budget: &base\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n  other: *base\n',
  },
  {
    // The shape GitHub's worked example uses, one level down: a step reused
    // across jobs. Agreement here is what says the aliases are RESOLVED rather
    // than tolerated — a reader that merely stopped refusing them would read
    // this second job as having one step with no keys.
    name: 'an alias to a single step, reused in another job',
    expect: 'agree',
    text: 'jobs:\n  a:\n    steps:\n      - &s\n        name: one\n        run: node --test a.test.ts\n'
      + '  b:\n    steps:\n      - *s\n',
  },
  {
    name: 'an anchor with no alias anywhere, which is inert',
    expect: 'agree',
    text: 'jobs:\n  budget: &unused\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n',
  },
  {
    name: 'an alias naming an anchor the file never declares',
    expect: 'refuse',
    text: 'jobs:\n  budget: *nowhere\n',
  },
  {
    name: 'an anchor that resolves through itself, which has no finite reading',
    expect: 'refuse',
    text: 'jobs:\n  budget: &loop\n    steps:\n      - run: npm ci\n    self: *loop\n',
  },
  {
    name: 'a merge key, which is a separate feature GitHub does not support',
    expect: 'refuse',
    text: 'defaults: &d\n  runs-on: ubuntu-latest\njobs:\n  budget:\n    <<: *d\n    steps:\n      - run: npm ci\n',
  },
  {
    name: 'more than one document in the file',
    expect: 'refuse',
    text: 'jobs:\n  budget:\n    steps:\n      - run: npm ci\n---\njobs:\n  other:\n    steps:\n      - run: npm ci\n',
  },
  {
    // MEASURED AS A DISAGREEMENT BETWEEN THIS READER AND ITS OWN ORACLE: the
    // reader counted two documents and refused, `parse()` read one with all
    // its jobs. A `---` or `...` an editor leaves behind is not a second
    // document, it is an empty one.
    name: 'a trailing document-start marker with nothing after it',
    expect: 'agree',
    text: 'jobs:\n  budget:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n---\n',
  },
  {
    name: 'a leading `---` and a `...` end marker',
    expect: 'agree',
    text: '---\njobs:\n  budget:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n...\n',
  },
  {
    name: 'a duplicate key, where GitHub and a reader can disagree about which one wins',
    expect: 'refuse',
    text: 'jobs:\n  budget:\n    runs-on: ubuntu-latest\n    runs-on: self-hosted\n    steps:\n      - run: npm ci\n',
  },
  {
    name: 'a tab used as indentation, which is not YAML at all',
    expect: 'refuse',
    text: 'jobs:\n  budget:\n\t\truns-on: ubuntu-latest\n',
  },
];

test('the reader agrees with a real YAML parser about every workflow in this repo', () => {
  for (const { name, text } of ALL_WORKFLOWS) {
    const oracle = oracleShape(text);
    const reader = readerShape(text);
    assert.deepEqual(
      Object.keys(reader).sort(),
      Object.keys(oracle).sort(),
      `${name}: the reader and a real YAML parser disagree about which jobs this file declares`,
    );
    for (const [id, expected] of Object.entries(oracle)) {
      assert.deepEqual(
        reader[id]!.keys,
        expected.keys,
        `${name}: job \`${id}\` declares keys the reader does not record — a key it cannot see is a key no rule`
        + ' can refuse',
      );
      assert.equal(
        reader[id]!.steps.length,
        expected.steps.length,
        `${name}: job \`${id}\` has ${expected.steps.length} steps and the reader found ${reader[id]!.steps.length}`,
      );
      expected.steps.forEach((keys, index) => {
        assert.deepEqual(
          reader[id]!.steps[index],
          projectedOracleStepKeys(keys),
          `${name}: job \`${id}\` step ${index} carries keys the reader did not project`,
        );
      });
    }
  }
  // And the sweep really read something: a differential over an empty set is
  // the same clean sheet the checks above this one are written to refuse.
  const stepCount = ALL_WORKFLOWS
    .flatMap(({ text }) => Object.values(oracleShape(text)))
    .reduce((total, job) => total + job.steps.length, 0);
  assert.ok(stepCount >= 20, `the differential compared only ${stepCount} steps`);
});

test('the reader agrees with a real YAML parser, or refuses to read, on every adversarial spelling', () => {
  assert.equal(READER_CORPUS.length, 22, 'add or remove a corpus entry and update this number in the same commit');
  for (const entry of READER_CORPUS) {
    const reader = readerShape(entry.text);
    if (entry.expect === 'refuse') {
      assert.deepEqual(
        Object.keys(reader),
        [],
        `${entry.name}: the reader produced jobs for a document it cannot honestly read. A file GitHub will not`
        + ' load must yield no jobs, which fails the audit — inventing structure for it is the fail-OPEN half of'
        + ' every defeat this module has had.',
      );
      // And it SAYS SO. Yielding no jobs is the fail-closed half; a refusal
      // that cannot be told from an empty file is the half that gets the check
      // deleted, because every audit then reports absences instead of a cause.
      assert.ok(
        workflowRefusal(entry.text),
        `${entry.name}: the reader refused this document silently, so the audit can only report the jobs it did`
        + ' not look for as missing',
      );
      continue;
    }
    assert.equal(
      workflowRefusal(entry.text),
      null,
      `${entry.name}: the reader refused a document it is supposed to agree with`,
    );
    const oracle = oracleShape(entry.text);
    assert.deepEqual(
      Object.keys(reader).sort(),
      Object.keys(oracle).sort(),
      `${entry.name}: the reader and the parser disagree about which jobs this document declares`,
    );
    for (const [id, expected] of Object.entries(oracle)) {
      assert.deepEqual(reader[id]!.keys, expected.keys, `${entry.name}: job \`${id}\` keys`);
      assert.equal(reader[id]!.steps.length, expected.steps.length, `${entry.name}: job \`${id}\` step count`);
      expected.steps.forEach((keys, index) => {
        assert.deepEqual(reader[id]!.steps[index], projectedOracleStepKeys(keys), `${entry.name}: step ${index}`);
      });
    }
  }
});

test('a REFUSED file is reported as refused, with the parser\'s own code, and not as a file missing its jobs', () => {
  // THE BLOCKER THIS CLOSES, measured against the committed file. On every
  // refusal the audit emitted three findings — `declares no \`on:\` block this
  // reader can find`, `has no job \`generate-check\``, `has no job
  // \`latency-budget\`` — while the `on:` block and both jobs sat in the file
  // untouched. "REFUSAL IS A FINDING, NOT A GAP" was true of the COUNT and
  // false of the MESSAGE, and the message is what a maintainer acts on: three
  // sentences sending them to inspect things that are fine, on a file whose
  // only sin was a duplicated key or a stray tab. That is how a check becomes
  // noise and gets deleted, and the round that introduced it had just demoted
  // another rule for citing something it did not verify.
  const refusals: readonly { readonly name: string; readonly workflow: string; readonly code: RegExp }[] = [
    {
      name: 'a duplicate key',
      workflow: committedWorkflow.replace('\n  latency-budget:\n', '\n  latency-budget:\n    timeout-minutes: 15\n'),
      code: /DUPLICATE_KEY/,
    },
    {
      name: 'a tab used as indentation',
      workflow: committedWorkflow.replace('\n    runs-on: ubuntu-latest\n', '\n\truns-on: ubuntu-latest\n'),
      code: /TAB_AS_INDENT|BAD_INDENT|MISSING_CHAR/,
    },
    {
      name: 'a merge key',
      workflow: committedWorkflow.replace('\n  latency-budget:\n', '\n  latency-budget:\n    <<: *nothing\n'),
      code: /merge key/,
    },
    {
      name: 'a second document',
      workflow: `${committedWorkflow}---\njobs:\n  other:\n    steps:\n      - run: npm ci\n`,
      code: /2 YAML documents/,
    },
  ];
  for (const { name, workflow, code } of refusals) {
    const findings = auditCommitted(workflow);
    assert.notDeepEqual(findings, [], `${name}: a file this reader cannot read audited clean`);
    for (const finding of findings) {
      assert.match(
        finding,
        /was REFUSED by this checker, not audited/,
        `${name}: the audit reported something OTHER than the refusal, which is a claim about a file it never`
        + ` read:\n${findings.join('\n\n')}`,
      );
      assert.doesNotMatch(
        finding,
        /has no job|declares no `on:`/,
        `${name}: the audit told the maintainer a job that IS in the file is missing:\n${finding}`,
      );
    }
    assert.ok(findings.some((finding) => code.test(finding)), `${name}: no finding names the cause:\n${findings}`);
    // The line, so the invisible cases are findable: a tab on an otherwise
    // blank line inside a `run:` body is whitespace no editor shows.
    assert.ok(
      findings.some((finding) => /line \d+/.test(finding)),
      `${name}: the refusal names no line:\n${findings.join('\n')}`,
    );
  }

  // A tab inside a `run:` body's CONTENT is not indentation and is not refused;
  // a tab on an otherwise blank line in the same body is (`yaml` treats it as a
  // less-indented non-empty line). Both are recorded here because the second is
  // the one a maintainer cannot see, and its message is now the only thing that
  // makes it findable.
  const tabInContent = committedWorkflow.replace('          set -o pipefail\n', '          set -o pipefail\n          \techo tabbed\n');
  assert.equal(workflowRefusal(tabInContent), null, 'a tab inside scalar content was read as indentation');
});

test('the DRY refactor GitHub documents leaves the committed file auditing clean', () => {
  // THE COST DIRECTION, driven against the real file rather than argued. The
  // enforcing job repeats one measurement condition four times and one report
  // condition five; anchoring them is the obvious edit, and GitHub has
  // supported it since 2025-09-18. Under the previous reader this produced
  // three findings saying the file's `on:` block and both its jobs were
  // missing. A false red on ordinary, documented work is how a checker gets
  // deleted, so this is a row and not a paragraph.
  const anchored = committedWorkflow
    .replace(
      "        if: ${{ !cancelled() && steps.install.outcome == 'success' }}\n",
      "        if: &measurement ${{ !cancelled() && steps.install.outcome == 'success' }}\n",
    )
    .replace(/^ {8}if: \$\{\{ !cancelled\(\) && steps\.install\.outcome == 'success' \}\}$/gm, '        if: *measurement');
  assert.notEqual(anchored, committedWorkflow, 'anchor lost: the measurement condition moved');
  assert.ok(anchored.includes('*measurement'), 'anchor lost: nothing was aliased');
  assert.equal(workflowRefusal(anchored), null, 'an anchored measurement condition was refused');
  assert.deepEqual(
    auditCommitted(anchored),
    [],
    'DRY-ing the repeated measurement condition with a YAML anchor reddened the audit. The refusal it used to'
    + ' hit cited "GitHub Actions does not support anchors", which stopped being true on 2025-09-18.',
  );
  // And the alias is RESOLVED, not skipped: the audit demands that exact
  // condition on every measurement step, so a reader that dropped the aliased
  // value would have reddened above rather than passed.
  const job = parseWorkflowJobs(anchored).find((candidate) => candidate.id === ENFORCING_JOB)!;
  const conditions = new Set(job.steps.map((step) => step.if).filter((value) => value !== null));
  assert.ok(
    conditions.has("${{ !cancelled() && steps.install.outcome == 'success' }}"),
    `the aliased condition was not resolved to its value: ${[...conditions].join(' | ')}`,
  );
});

test('the reader refuses a non-string input instead of throwing out of the audit', () => {
  // The mutant round 6 disclosed as equivalent, killed. It is not an
  // equivalence: `parseAllDocuments` throws on exactly one class of input —
  // non-string — and every other malformation measured (BOM, lone surrogates,
  // NUL, C1 bytes, 8 MiB scalars, 100k nesting levels, reserved indicators,
  // unclosed flow, `%YAML 1.3`) arrives through `doc.errors` instead. That
  // makes the `catch` a zero-execution branch rather than a semantic no-op, and
  // a zero-execution branch is an ABSENT FIXTURE. This is the fixture: a
  // well-typed caller cannot produce one, so the cast is the test. Delete the
  // catch and this row throws instead of reporting.
  const notAString = 42 as unknown as string;
  assert.deepEqual(parseWorkflowJobs(notAString), []);
  assert.match(workflowRefusal(notAString) ?? '', /`yaml` threw/);
  assert.match(
    auditCheckerJob({ workflow: notAString, workflowPath: WORKFLOW_PATH, jobId: CHECKER_JOB, suiteScript: SUITE_SCRIPT })[0] ?? '',
    /was REFUSED by this checker/,
  );
});

test('a key the reader cannot see is a key the job-key allowlist cannot refuse', () => {
  // The differential above states the property; this states the CONSEQUENCE, in
  // the shape the five green defeats had. Each row is one job-level key in a
  // spelling the indentation grammar could not read, and each of them was 96
  // pass / 0 fail against the committed suite before the parser landed.
  for (const keyLine of [
    '    "continue-on-error": true',
    "    'continue-on-error': true",
    '    "if": false',
    "    'if': false",
    '    "needs": generate-check',
    "    'needs': generate-check",
    '    "strategy":\n      matrix:\n        include: []',
  ]) {
    const findings = auditCommitted(withJobKey(committedWorkflow, keyLine));
    assert.notDeepEqual(findings, [], `a quoted job-level key was invisible to the audit: ${keyLine.trim()}`);
  }
  // And the step-level twin, on the two steps where it matters most: the
  // measurement, and the install step every measurement's condition names —
  // `npm ci` failing under a masked status skips every measurement while every
  // report step exits 0 by design.
  for (const step of ['Session-start p95 budgets', 'Install dependencies']) {
    const hollow = editStep(committedWorkflow, step, (line) => (
      /^ {6}- name:/.test(line) ? `${line}\n        "continue-on-error": true` : line
    ), ENFORCING_JOB);
    const findings = auditCommitted(hollow);
    assert.ok(
      findings.some((finding) => finding.includes('continue-on-error')),
      `a quoted step-level continue-on-error on "${step}" was invisible:\n${findings.join('\n')}`,
    );
  }
});

test('the reader\'s not-a-scalar branches are reached, and every one of them fails closed', () => {
  // FIVE BRANCHES WITH ZERO EXECUTIONS, each written for a shape YAML permits
  // and GitHub does not, and each previously defended only by the fact that
  // nobody had typed one. A branch no test reaches is a branch a mutation
  // survives in, so "fails closed" was an intention rather than a property:
  // deleting any of the five `is…` guards below left the suite green.
  //
  // The direction they all fail in is the same one the rest of this module
  // takes: an unreadable shape produces LESS structure (no key, no step, no
  // invocation), which reddens the audit, never fewer findings.

  // 1. A key that is not a scalar. `? [a, b]` is a complex mapping key, and the
  //    reader has to name a key with a string or leave it out entirely.
  const complexKey = 'jobs:\n  budget:\n    ? [a, b]\n    : value\n    runs-on: ubuntu-latest\n';
  const withComplexKey = parseWorkflowJobs(complexKey)[0]!;
  assert.deepEqual(
    withComplexKey.keys.map((key) => key.name),
    ['runs-on'],
    'a complex mapping key was given a name it does not have',
  );

  // 2. A `run:` that is a sequence. A list of commands is a shape people expect
  //    to work; it does not, and crediting it with the invocations it lists
  //    would mean certifying a step GitHub refuses to start.
  const seqRun = parseWorkflowJobs(
    'jobs:\n  budget:\n    steps:\n      - name: one\n        run:\n          - node --test a.test.ts\n',
  )[0]!.steps[0]!;
  assert.deepEqual(seqRun.run, [], 'a sequence `run:` was read as a command body');
  assert.deepEqual(testFilesInvokedBy(seqRun), [], 'a sequence `run:` was credited with an invocation');

  // 3. An `env:` that is not a mapping, in both spellings a maintainer reaches
  //    for. The strict switch is checked by reading this map, so an `env:` that
  //    invented an entry would be a switch the audit believes is set on a step
  //    that sets nothing — and the sequence form is the one that survives a
  //    guard widened from `isMap` to `isMap || isSeq`, which is why both are
  //    here rather than the scalar alone.
  for (const env of ['env: T1_LATENCY_BUDGET_STRICT=1', 'env:\n          - T1_LATENCY_BUDGET_STRICT=1']) {
    const step = parseWorkflowJobs(
      `jobs:\n  budget:\n    steps:\n      - name: one\n        ${env}\n        run: npm ci\n`,
    )[0]!.steps[0]!;
    assert.equal(step.env.size, 0, `a non-mapping \`${env.split('\n')[0]}\` produced environment entries`);
  }

  // 4. A `steps:` sequence carrying something that is not a mapping.
  const looseItem = parseWorkflowJobs(
    'jobs:\n  budget:\n    steps:\n      - npm ci\n      - name: real\n        run: node --test a.test.ts\n',
  )[0]!;
  assert.equal(looseItem.declaresSteps, true);
  assert.deepEqual(looseItem.steps.map((step) => step.name), ['real'], 'a bare scalar became a step');

  // 5. Documents the parser reports errors for rather than structure. The
  //    audit's fail-closed contract is that an unreadable file yields NO jobs,
  //    so each of these has to red the audit instead of yielding a partial read
  //    that looks compliant.
  for (const unreadable of [
    'jobs:\n  budget:\n    runs-on: [unclosed\n',
    'jobs:\n  budget: @reserved\n',
    'jobs:\n  a: 1\n b: 2\n',
  ]) {
    assert.deepEqual(parseWorkflowJobs(unreadable), [], `a malformed document produced jobs:\n${unreadable}`);
    assert.deepEqual(parseWorkflowTriggers(unreadable).events, []);
  }
});

test('a budget file is recognised in every TypeScript extension node --test resolves', () => {
  // `.test.ts` alone made the extension a CATEGORY. This repo already ships an
  // `.mts` source, so renaming a budget file to one is an ordinary edit — and
  // it used to drop the file out of the invoked set while the coverage rule
  // went on demanding a job run it, i.e. an unexplainable red for a legitimate
  // rename, and an invocation the audit could no longer see.
  for (const extension of ['ts', 'mts', 'cts']) {
    const file = `src/probe.test.${extension}`;
    const step = parseWorkflowJobs(
      `jobs:\n  budget:\n    steps:\n      - name: one\n        run: node --test ${file}\n`,
    )[0]!.steps[0]!;
    assert.deepEqual(testFilesInvokedBy(step), [file], `a \`.${extension}\` budget file was not seen as invoked`);
    assert.deepEqual(testFilesNamedBy(step), [file], `a \`.${extension}\` budget file was not seen as named`);
  }
  // And the file walk that builds the population sees them too, so a budget
  // asserted from an `.mts` file cannot be invisible to the coverage rule.
  assert.deepEqual(TS_EXTENSIONS, ['.ts', '.mts', '.cts']);
  assert.ok(
    sourceFiles(path.join(REPO_ROOT, 'src')).some((file) => file.endsWith('.mts')),
    'the source walk found no .mts file in a repo that has one, so its extension list is not being applied',
  );
});

test('a `run:` block scalar is read whatever indicator and content indent it carries', () => {
  // `run: |2` is ordinary YAML, and the grammar that did not match it dropped
  // the body of the step piping this repo's ENTIRE suite through tee — which
  // removed that step from the pipefail rule and from the population the rule
  // was checked against, in one move.
  const bodyOf = (scalar: string): WorkflowStep => {
    const workflow = [
      'jobs:',
      '  budget:',
      '    steps:',
      `      - run: ${scalar}`,
      '          set -o pipefail',
      '          node --test a.test.ts 2>&1 | tee log',
      '',
    ].join('\n');
    const step = parseWorkflowJobs(workflow)[0]?.steps[0];
    assert.ok(step, `scalar ${JSON.stringify(scalar)} produced no step`);
    return step;
  };

  // LITERAL scalars keep their line breaks, so the body is a list of commands
  // and the invocation is in it. An indentation indicator is relative to the
  // parent node, and this `run:` sits at indent 8, so `2` names the body's own
  // indent and the rest auto-detect.
  for (const scalar of ['|', '|-', '|+', '|2', '|-2', '|2-', '| # why', '|  # why']) {
    assert.deepEqual(
      testFilesInvokedBy(bodyOf(scalar)),
      ['a.test.ts'],
      `scalar ${JSON.stringify(scalar)} lost its body`,
    );
  }

  // FOLDED scalars do not, and this is a divergence the indentation grammar
  // had: it matched `>` with the same pattern as `|` and then kept the lines
  // apart, so a folded body read as two commands when GitHub hands the shell
  // ONE — `set -o pipefail node --test a.test.ts 2>&1 | tee log`, whose head
  // is `set` and which runs no test at all. The old reader credited that step
  // with a measurement it does not take. Reading the fold is the fail-closed
  // direction as well as the accurate one: the audit now says the file is not
  // invoked, which is a red with a one-line fix.
  for (const scalar of ['>', '>-', '>2']) {
    const step = bodyOf(scalar);
    assert.equal(step.run.length, 1, `folded scalar ${JSON.stringify(scalar)} was read as more than one line`);
    assert.deepEqual(
      testFilesInvokedBy(step),
      [],
      `folded scalar ${JSON.stringify(scalar)} was read as if it were literal, crediting an invocation GitHub`
      + ' would not perform',
    );
  }
});

test('the stricter combined spelling of pipefail is recognised as protection', () => {
  // `set -euo pipefail` is the SAFER line. Reading it as unprotected told
  // maintainers to fix the one step that was already right, which is how a
  // checker earns the reputation that gets it deleted.
  for (const setting of ['set -o pipefail', 'set -eo pipefail', 'set -euo pipefail', 'set -e -o pipefail']) {
    const workflow = [
      'jobs:', '  budget:', '    steps:', '      - run: |',
      `          ${setting}`,
      '          npm test 2>&1 | tee log',
      '',
    ].join('\n');
    assert.deepEqual(
      stepsPipingWithoutPipefail(workflow),
      [],
      `${JSON.stringify(setting)} was read as leaving the pipeline unprotected`,
    );
  }
  // And the word inside an `echo` is not the command. This is the tokenizer
  // defect that let a step SAY it was protected. Both spellings: quoted, where
  // the option is one token of the echo, and UNQUOTED, where `set`, `-o` and
  // `pipefail` are three separate words of a command whose head is `echo`. Only
  // the second distinguishes "the head of this command is `set`" from "the word
  // `set` appears in this command", and without it that distinction could be
  // deleted with every case here still green.
  for (const spelling of ['echo "set -o pipefail"', 'echo set -o pipefail', 'echo Remember to set -o pipefail']) {
    const echoed = [
      'jobs:', '  budget:', '    steps:', '      - name: hollow', '        run: |',
      `          ${spelling}`,
      '          npm test 2>&1 | tee log',
      '',
    ].join('\n');
    assert.equal(
      stepsPipingWithoutPipefail(echoed).length,
      1,
      `an echoed pipefail was accepted as protection: ${spelling}`,
    );
  }
});

test('naming a test file is not running it, in every spelling that names one', () => {
  const invoked = (body: string): string[] => testFilesInvokedBy(
    { name: '', line: 1, if: null, continueOnError: false, shell: null, id: null, env: new Map(), uses: null, run: body.split('\n') },
  );
  // Runs it.
  for (const body of [
    'node --test a.test.ts',
    'node --import ./p.mjs --import tsx --test a.test.ts',
    'node --test --test-reporter spec a.test.ts',
    'if ! node --test a.test.ts; then exit 1; fi',
    'env FOO=1 node --test a.test.ts',
    'npx tsx --test a.test.ts',
    'node --test ./a.test.ts',
    'node --test a.test.ts 2>&1 | tee log',
  ]) assert.deepEqual(invoked(body), ['a.test.ts'], `not seen as an invocation: ${body}`);
  // Names it and runs nothing.
  for (const body of [
    'echo "temporarily skipping a.test.ts"',
    '# node --test a.test.ts',
    'FILE=a.test.ts',
    'false && node --test a.test.ts',
    'node a.test.ts',
    'echo a.test.ts > list',
    'grep -q a.test.ts manifest',
  ]) {
    assert.deepEqual(invoked(body), [], `counted as an invocation: ${body}`);
    assert.ok(
      testFilesNamedBy({
        name: '', line: 1, if: null, continueOnError: false, shell: null, id: null, env: new Map(), uses: null, run: body.split('\n'),
      })
        .includes('a.test.ts')
      || body.startsWith('#'),
      `the message half cannot see the name either, so the maintainer gets the wrong sentence: ${body}`,
    );
  }
  // A redirection target is not an argument, so a log named `*.test.ts` is not
  // a measurement — and `2>&1` is one word, not a separator.
  assert.deepEqual(invoked('node --test a.test.ts > b.test.ts'), ['a.test.ts']);
  assert.equal(shellCommands('npm test 2>&1 | tee log').filter((c) => c.indexInPipeline === 0)[0]!.head, 'npm');
});

test('a longer pipeline is read as ONE hidden status, teed to the log tee actually writes', () => {
  // Two mutation survivors, and they survive only because every pipeline in the
  // committed file is exactly `<runner> 2>&1 | tee <log>` — one element wide, so
  // "the first downstream element" and "the tee" are the same command and "every
  // element" and "the head" report the same count. Neither holds on a pipeline
  // with a filter in the middle, which is the next thing a maintainer writes.
  const withFilter = (body: readonly string[]): string => [
    'jobs:', '  budget:', '    runs-on: ubuntu-latest', '    steps:',
    // The step the measurement's condition names. It is here because the audit
    // now requires it to be — see the id/reachability rules — and a fixture
    // that omitted it would be testing the pipeline reader against a finding
    // about something else.
    '      - name: Install dependencies',
    '        id: install',
    '        run: npm ci',
    '      - name: measure',
    "        if: ${{ !cancelled() && steps.install.outcome == 'success' }}",
    '        shell: bash',
    '        run: |',
    ...body,
    '      - name: "Report the verdict"',
    '        if: always()',
    '        shell: bash',
    '        run: |',
    '          if ! grep -Eq "LATENCY BUDGET PASS · x  n= 1  wall p50/p95/max 1.00/1.00/1.00 ms" "$T/a.log"; then',
    '            echo "::error title=did not run::no verdict line"',
    '            exit 1',
    '          fi',
    '',
  ].join('\n');
  const pipeline = '          node --import ./p.mjs --test a.test.ts 2>&1 | node ./filter.js -v noise | tee "$T/a.log"';

  // The log is the TEE target. Reading it off the first downstream element
  // instead returns `./filter.js`, no later step reads that, and the audit
  // reports a measurement with no report step — over a workflow that has one.
  assert.deepEqual(
    auditEnforcingJob({
      workflow: withFilter(['          set -o pipefail', pipeline]),
      workflowPath: WORKFLOW_PATH,
      jobId: 'budget',
      budgetFiles: ['a.test.ts'],
    }),
    [],
  );

  // And the hidden status is the HEAD's, once. Counting every status-bearing
  // element of the pipeline reports the same masked status twice, which is a
  // checker telling a maintainer to fix two things where there is one.
  const unprotected = stepsPipingWithoutPipefail(withFilter([pipeline]));
  assert.equal(unprotected.length, 1, `one hidden status reported ${unprotected.length} times:\n${unprotected.join('\n')}`);
  assert.deepEqual(stepsWithMaskedStatus(withFilter([pipeline])), ['budget / "measure"']);
});

test('a trailing comment on a command line is prose, not more command', () => {
  // Mutation survivor: deleting the tokenizer's `#` handling broke nothing,
  // because every case in this file put its comments on their own line — and
  // those are dropped one layer up, by the YAML reader. A TRAILING comment is
  // the case only the tokenizer can decide, and both directions of getting it
  // wrong are findings about commands that do not exist.
  const swallowShaped = shellCommands('node --import ./p.mjs --test a.test.ts  # || true if it ever flakes');
  assert.deepEqual(swallowShaped.map((command) => command.head), ['node']);
  assert.ok(
    !swallowShaped.some((command) => command.precededBy === '||' && command.head === 'true'),
    'a `|| true` inside a comment was read as a swallowed failure',
  );

  const pipeShaped = [
    'jobs:', '  budget:', '    steps:', '      - name: measure', '        run: |',
    '          set -o pipefail',
    '          node --import ./p.mjs --test a.test.ts 2>&1  # | tee "$RUNNER_TEMP/old.log"',
    '',
  ].join('\n');
  assert.deepEqual(stepsWithMaskedStatus(pipeShaped), [], 'a `| tee` inside a comment was read as a pipeline');
  const step = parseWorkflowJobs(pipeShaped)[0]!.steps[0]!;
  assert.deepEqual(testFilesInvokedBy(step), ['a.test.ts'], 'the command before the comment stopped being read');
});

test('a command substitution is one opaque word, so its `|` is not a pipeline of the outer command', () => {
  // Mutation survivor, and the comment on the tokenizer argues for exactly this
  // without anything checking it. Every report step in the enforcing job
  // contains `reason=$(grep -o … | awk …)`; descending into it would invent an
  // outer pipeline where the body has none, and `maskedPipelines` would then be
  // reporting on commands that are not in the shape it thinks they are.
  const commands = shellCommands([
    "reason=$(grep -o 'LATENCY BUDGET INCONCLUSIVE.*' \"$log\" | awk '{ print }')",
    'npm test 2>&1 | tee log',
  ].join('\n'));
  assert.deepEqual(
    commands.map((command) => `${command.head}#${command.pipeline}.${command.indexInPipeline}`),
    ['#0.0', 'npm#1.0', 'tee#1.1'],
    'the substitution\'s own `|` became a pipeline of the assignment around it',
  );

  // The other side of the same decision, recorded rather than asserted away: a
  // test runner INSIDE a substitution is not seen as an invocation. That is the
  // safe direction — the audit then says the file is not invoked, which is a
  // false positive with a one-line fix, rather than crediting a measurement it
  // cannot read.
  assert.deepEqual(
    testFilesInvokedBy({
      name: '', line: 1, if: null, continueOnError: false, shell: null, id: null, env: new Map(), uses: null,
      run: ['out=$(node --import ./p.mjs --test a.test.ts)'],
    }),
    [],
  );
});

test('the audit tells the maintainer something TRUE about their workflow', () => {
  // A message that misdescribes the file is worse than no message: it sends the
  // reader to a place that is fine. Three shapes, three different sentences.
  const budget = ['x.test.ts'];
  const base = (body: string): string => [
    'jobs:', '  budget:', '    runs-on: ubuntu-latest', '    steps:', body, '',
  ].join('\n');

  // 1. Named but not invoked -> say so, and say where.
  const echoed = auditEnforcingJob({
    workflow: base('      - name: hollow\n        run: echo "skipping x.test.ts"'),
    workflowPath: WORKFLOW_PATH,
    jobId: 'budget',
    budgetFiles: budget,
  });
  assert.ok(echoed.some((f) => f.includes('The name appears in "hollow" (line 5), but not as an argument')), echoed.join('\n'));

  // 2. Not named at all -> must NOT claim it appears somewhere.
  const absent = auditEnforcingJob({
    workflow: base('      - name: unrelated\n        run: npm run build'),
    workflowPath: WORKFLOW_PATH,
    jobId: 'budget',
    budgetFiles: budget,
  });
  assert.ok(absent.some((f) => f.includes('INVOKES')), absent.join('\n'));
  assert.ok(!absent.some((f) => f.includes('The name appears in')), `claimed a mention that does not exist:\n${absent.join('\n')}`);

  // 3. A LOCAL composite action is worth mentioning as a blind spot; checkout
  //    and setup-node are not, and a hint that one of them might be running a
  //    budget file is noise wearing the shape of help.
  const thirdParty = auditEnforcingJob({
    workflow: base('      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4'),
    workflowPath: WORKFLOW_PATH,
    jobId: 'budget',
    budgetFiles: budget,
  });
  assert.ok(!thirdParty.some((f) => f.includes('local action')), thirdParty.join('\n'));
  const local = auditEnforcingJob({
    workflow: base('      - uses: ./.github/actions/measure'),
    workflowPath: WORKFLOW_PATH,
    jobId: 'budget',
    budgetFiles: budget,
  });
  assert.ok(local.some((f) => f.includes('`./.github/actions/measure`')), local.join('\n'));

  // 4. A reusable-workflow job is a LIMIT of this check, and must be reported as
  //    one rather than as a workflow that fails to measure anything.
  const delegated = auditEnforcingJob({
    workflow: 'jobs:\n  budget:\n    uses: ./.github/workflows/other.yml\n',
    workflowPath: WORKFLOW_PATH,
    jobId: 'budget',
    budgetFiles: budget,
  });
  assert.equal(delegated.length, 1);
  assert.ok(delegated[0]!.includes('That is a limit of this check, not a defect in the workflow'), delegated[0]);

  // 5. "Zero steps" separates unreadable from absent, because the two send a
  //    maintainer to different places.
  const unreadable = auditEnforcingJob({
    workflow: 'jobs:\n  budget:\n    steps:\n      NOT A STEP\n',
    workflowPath: WORKFLOW_PATH,
    jobId: 'budget',
    budgetFiles: budget,
  });
  assert.ok(unreadable[0]!.includes('which this reader could not read'), unreadable[0]);
  const stepless = auditEnforcingJob({
    workflow: 'jobs:\n  budget:\n    runs-on: ubuntu-latest\n',
    workflowPath: WORKFLOW_PATH,
    jobId: 'budget',
    budgetFiles: budget,
  });
  assert.ok(stepless[0]!.includes('no `steps:` key'), stepless[0]);
});

test('the trigger reader reads every spelling of `on:`, and the committed file fires on push and pull_request', () => {
  // The fact the job-level `if:` refusal cites. Read directly here as well as
  // through the audit, because the audit can only report on what this returns.
  const committed = parseWorkflowTriggers(committedWorkflow);
  assert.deepEqual([...committed.events].sort(), ['pull_request', 'push']);
  assert.deepEqual(committed.filters, []);

  // The three spellings, so a file the reader cannot read is a red rather than
  // a file that reads as having no triggers — which is the fail-open shape.
  assert.deepEqual(parseWorkflowTriggers('on: push\njobs:\n').events, ['push']);
  assert.deepEqual(parseWorkflowTriggers('on: [push, pull_request]\njobs:\n').events, ['push', 'pull_request']);
  assert.deepEqual(parseWorkflowTriggers('"on":\n  push:\n  pull_request:\njobs:\n').events, ['push', 'pull_request']);
  assert.deepEqual(parseWorkflowTriggers('on:\n  - push\n  - pull_request\njobs:\n').events, ['push', 'pull_request']);
  assert.equal(parseWorkflowTriggers('jobs:\n  a:\n').declared, false);

  // And a filter is seen wherever it is written.
  assert.deepEqual(
    parseWorkflowTriggers("on:\n  push:\n    branches:\n      - main\n  pull_request:\njobs:\n").filters,
    ['push.branches'],
  );
  assert.deepEqual(parseWorkflowTriggers('on:\n  push: [main]\njobs:\n').filters, ['push.<inline>']);
});

test('the reader records the step ids and step env the conditions and the strict switch depend on', () => {
  const job = parseWorkflowJobs(committedWorkflow).find((candidate) => candidate.id === ENFORCING_JOB)!;
  // The id every measurement condition in this job names. Nothing asserted this
  // for two rounds, and deleting the one line that declares it left the whole
  // audit green with all four budgets skipped.
  const install = job.steps.find((step) => step.id === 'install');
  assert.ok(install, `no step of \`${ENFORCING_JOB}\` declares an id, so the measurement conditions name nothing`);
  assert.equal(install.if, null, 'the step the measurement conditions name can itself be skipped');

  // And the env of the one step that carries a switch. `T1_HOOK_TIMING_PROCESS`
  // is asserted alongside it because the same reader gap hid both: a step-level
  // `env:` block was invisible, so "this leg is enabled here and nowhere else"
  // was a claim about a key nothing read.
  const selfCheck = job.steps.find((step) => step.name.includes('Latency instrument self-check'));
  assert.ok(selfCheck, 'anchor lost: the instrument self-check step');
  assert.equal(selfCheck.env.get(STRICT_ENV), '1');
  const hooks = job.steps.find((step) => step.name.includes('Per-event hook timing'));
  assert.equal(hooks?.env.get('T1_HOOK_TIMING_PROCESS'), '1');
  assert.equal(hooks?.env.get('T1_HOOK_TIMING_BUDGET'), '1');
});

/** A TestContext stub: `settle` only ever calls these two. */
function recordingContext(): { t: TestContext; diagnostics: string[]; skips: string[] } {
  const diagnostics: string[] = [];
  const skips: string[] = [];
  const t = {
    diagnostic: (message: string) => { diagnostics.push(message); },
    skip: (message?: string) => { skips.push(message ?? ''); },
  } as unknown as TestContext;
  return { t, diagnostics, skips };
}

/** Run `body` with the strict switch forced on or off, and the banner swallowed. */
function withStrict<T>(on: boolean, body: () => T): T {
  const before = process.env[STRICT_ENV];
  const write = process.stderr.write.bind(process.stderr);
  if (on) process.env[STRICT_ENV] = '1';
  else delete process.env[STRICT_ENV];
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return body();
  } finally {
    process.stderr.write = write;
    if (before === undefined) delete process.env[STRICT_ENV];
    else process.env[STRICT_ENV] = before;
  }
}

const INCONCLUSIVE_REASON = 'this machine delivered 41% of the CPU a reference workload asked for';
/** A function, not a const: FIXTURE_STATS is declared further down this file. */
const inconclusiveOutcome = () => ({
  verdict: 'inconclusive' as const, reason: INCONCLUSIVE_REASON, stats: FIXTURE_STATS,
});

test('the strict switch is EXECUTED on both sides, in the branch the escalation actually lives in', () => {
  // WHAT THIS REPLACES, and why the replacement is not a formality. The branch
  // in `settle` that turns an INCONCLUSIVE into a throw is the escalation every
  // "an unanswerable row is still a hard failure under the switch" sentence in
  // this repo rests on, and nothing ran it. The one CI step that sets the
  // switch runs latency-budget.test.ts, which imports `measureLatencyBudget`
  // and no asserting entry point; the four files that DO call one are in the
  // parallel suite, where the switch is unset. Its only guard was
  // `source.includes('process.env[STRICT_ENV]')` on the instrument's own
  // text — a check that passes with the branch's BODY deleted, and passes on a
  // comment. Both sides are driven here against a recorded outcome, so no
  // measurement is taken to reach one line.
  //
  // AND THIS TITLE WAS FALSE FOR A ROUND, which is why the row below it exists.
  // `settle` was the branch the tests drove and NOT the branch CI reached: the
  // self-check row hand-rolled a second escalation, so the only escalation any
  // CI step could execute was the one nothing here touched. Measured: with the
  // switch set in the environment, disabling that branch (`strictModeEngaged()
  // && false`) left 111/111 and 16/16 green, and instrumented counts put its
  // executions at zero. There is one escalation now — `settleSelfCheck` routes
  // the row's corridor exit through `settle` — so this row and the next are
  // about the same branch, and the title says something checkable.
  assert.equal(withStrict(true, () => strictModeEngaged()), true);
  assert.equal(withStrict(false, () => strictModeEngaged()), false);
  assert.equal(strictModeEngaged({ [STRICT_ENV]: '0' }), false, 'anything but `1` is off');
  assert.equal(strictModeEngaged({}), false);

  // Strict: a throw, naming the switch, with the reason carried into it.
  const strict = recordingContext();
  assert.throws(
    () => withStrict(true, () => settle(strict.t, 'probe', 24, inconclusiveOutcome())),
    (error: Error) => error.message.includes(STRICT_ENV) && error.message.includes(INCONCLUSIVE_REASON),
    'an INCONCLUSIVE outcome did not become a hard failure under the strict switch',
  );
  assert.deepEqual(strict.skips, [], 'the strict branch skipped as well as throwing');

  // Lenient: no throw, and the skip carries the reason where a reporter prints it.
  const lenient = recordingContext();
  const outcome = withStrict(false, () => settle(lenient.t, 'probe', 24, inconclusiveOutcome()));
  assert.equal(outcome.verdict, 'inconclusive');
  assert.equal(lenient.skips.length, 1, 'an INCONCLUSIVE outcome did not mark the row skipped');
  assert.ok(lenient.skips[0]!.includes('budget NOT checked'), lenient.skips[0]);
  assert.ok(
    lenient.diagnostics.some((line) => line.includes('INCONCLUSIVE')),
    'the skip travelled without the verdict line every reporter prints inline',
  );

  // And the switch decides nothing else: a FAIL is a throw either way, a PASS
  // is neither. A strict branch that swallowed a real failure would be the same
  // hollow green from the other direction.
  for (const on of [true, false]) {
    assert.throws(
      () => withStrict(on, () => settle(recordingContext().t, 'probe', 24, {
        verdict: 'fail', reason: 'over budget', stats: FIXTURE_STATS,
      })),
      /over budget/,
      `a FAIL stopped being a throw with the switch ${on ? 'on' : 'off'}`,
    );
    const passed = recordingContext();
    withStrict(on, () => settle(passed.t, 'probe', 24, {
      verdict: 'pass', reason: 'within budget', stats: FIXTURE_STATS,
    }));
    assert.deepEqual(passed.skips, [], `a PASS was skipped with the switch ${on ? 'on' : 'off'}`);
  }
});

test('the escalation the SERIAL STEP reaches is executed, on both switch states, from its own seam', () => {
  // THE BRANCH CI ACTUALLY RUNS. The step that sets the switch runs
  // latency-budget.test.ts, so the escalation production depends on is whatever
  // that row does with a corridor exit — and for one round that was a second,
  // hand-rolled `if (strictModeEngaged()) assert.fail(…)` inside the row, which
  // no test could execute (importing the row registers ten seconds of live
  // measurement) and which a source-text regex was left guarding. Measured with
  // the switch SET in the environment: that branch was entered 0 times across
  // both suites, and `strictModeEngaged() && false` in it survived 111/111 and
  // 16/16. The decision now lives in `settleSelfCheck`, one file over, and this
  // is it being driven — three corridor outcomes by two switch states, in
  // milliseconds, with the recorded statistics above.
  const outcome = (cpuP95: number, wallP95: number) => ({
    verdict: 'inconclusive' as const,
    reason: 'unused: settleSelfCheck writes its own reason from the corridor',
    stats: { ...FIXTURE_STATS, cpuP95, wallP95 },
  });
  const ceilingExit = outcome(SELF_CHECK_BUDGET_MS + 1, SELF_CHECK_BUDGET_MS * 3);
  const floorExit = outcome(1, SELF_CHECK_BUDGET_MS - 1);
  const inside = outcome(1, SELF_CHECK_BUDGET_MS * 2);

  // 1. Strict, either exit: a THROW carrying the marker the report step tells
  //    the two red arms apart by, and the corridor's own sentence with it.
  for (const [exit, expected] of [
    [ceilingExit, /rule 2 decides this measurement/],
    [floorExit, /did not put this section over its/],
  ] as const) {
    const strict = recordingContext();
    assert.throws(
      () => withStrict(true, () => settleSelfCheck(strict.t, exit, 'n=60 …')),
      (error: Error) => error.message.includes(STRICT_FAILURE_MARKER) && expected.test(error.message),
      `a corridor exit under the switch did not raise the escalation the serial step depends on (${expected})`,
    );
    assert.deepEqual(strict.skips, [], 'the strict escalation skipped as well as throwing');
    // And the log the report step reads still carries the verdict line, which
    // is the ONLY thing distinguishing its two red arms. Throwing before
    // printing would make the arm that names the runner unreachable.
    assert.ok(
      strict.diagnostics.some((line) => (
        line.startsWith(`LATENCY BUDGET INCONCLUSIVE · ${SELF_CHECK_LABEL} · corridor not reachable`)
      )),
      `the escalation threw without printing the corridor line the report step reads:\n${strict.diagnostics.join('\n')}`,
    );
  }

  // 2. Lenient, either exit: three-valued, as everywhere else off the serial
  //    runner — a skip carrying the reason, and the same verdict line.
  for (const exit of [ceilingExit, floorExit]) {
    const lenient = recordingContext();
    assert.equal(withStrict(false, () => settleSelfCheck(lenient.t, exit, 'n=60 …')), true);
    assert.equal(lenient.skips.length, 1, 'a corridor exit off the serial runner did not mark the row skipped');
    assert.ok(lenient.skips[0]!.includes('budget NOT checked'), lenient.skips[0]);
    assert.ok(
      lenient.diagnostics.some((line) => line.includes('corridor not reachable')),
      lenient.diagnostics.join('\n'),
    );
  }

  // 3. Inside the corridor, either way: nothing said, nothing skipped, and
  //    `false` returned so the row goes on to assert its verdict. A seam that
  //    escalated here would red every green run, which is the other direction
  //    of the same defect.
  for (const on of [true, false]) {
    const ok = recordingContext();
    assert.equal(
      withStrict(on, () => settleSelfCheck(ok.t, inside, 'n=60 …')),
      false,
      `a machine INSIDE the corridor was settled as an exit with the switch ${on ? 'on' : 'off'}`,
    );
    assert.deepEqual(ok.skips, []);
    assert.deepEqual(ok.diagnostics, []);
  }

  // And the marker really is what separates the two red arms: the message of a
  // strict escalation contains it, the diagnostic of a lenient one does not.
  const lenient = recordingContext();
  withStrict(false, () => settleSelfCheck(lenient.t, ceilingExit, 'n=60 …'));
  assert.ok(
    !lenient.diagnostics.concat(lenient.skips).some((line) => line.includes(STRICT_FAILURE_MARKER)),
    'the lenient corridor exit printed the strict marker, so the report step cannot tell the two exits apart',
  );
});

test('the corridor decision is EXECUTED on all three of its outcomes', () => {
  // The other coupling this file used to assert by substring. Each arm is the
  // sentence the report step's two annotations are chosen between, so a
  // deleted arm has to red here rather than in a workflow nobody runs locally.
  const stats = (cpuP95: number, wallP95: number) => ({ ...FIXTURE_STATS, cpuP95, wallP95 });
  assert.match(
    selfCheckCorridorMiss(stats(SELF_CHECK_BUDGET_MS + 1, SELF_CHECK_BUDGET_MS * 3)),
    /burned .* ms of CPU .* rule 2 decides this measurement/,
    'a machine over the ceiling was not reported as a rule-2 exit',
  );
  assert.match(
    selfCheckCorridorMiss(stats(1, SELF_CHECK_BUDGET_MS - 1)),
    /did not put this section over its .* budget/,
    'a machine under the floor was not reported as a no-breach exit',
  );
  assert.equal(
    selfCheckCorridorMiss(stats(1, SELF_CHECK_BUDGET_MS * 2)),
    '',
    'a machine inside the corridor was reported as outside it',
  );
  // The corridor is a corridor: its floor is below its ceiling by a margin, and
  // the ceiling clears the GC/JIT term the instrument's own docblock records
  // (9 samples in 250, up to 11.7 ms) rather than merely clearing the section.
  // 12 ms did not — 12/11.7 is 1.03x — and a 12.28 ms CPU sample was drawn on
  // an idle machine while re-measuring this.
  assert.ok(
    SELF_CHECK_BUDGET_MS / 11.7 >= 2,
    `the corridor ceiling ${SELF_CHECK_BUDGET_MS} ms is ${(SELF_CHECK_BUDGET_MS / 11.7).toFixed(2)}x the 11.7 ms`
    + ' GC/JIT term this instrument documents, which is not a margin',
  );
  assert.ok(
    SELF_CHECK_WAIT_MS * 3 / SELF_CHECK_BUDGET_MS >= 1.4,
    `three ${SELF_CHECK_WAIT_MS} ms waits per sample inject ${SELF_CHECK_WAIT_MS * 3} ms of wall clock against a`
    + ` ${SELF_CHECK_BUDGET_MS} ms ceiling, so raising the ceiling closed the corridor from below`,
  );
});

test('the self-check row holds the shared spellings rather than copies of them', () => {
  // What is LEFT of the source-text coupling, and it is now the opposite check:
  // the row must NOT contain the literals, because they live in the instrument
  // and all three files import them. Importing the row's module here would
  // register ten seconds of live measurement in this process, so its use of the
  // shared names is the one thing still read rather than executed.
  //
  // AND WHAT LEFT THIS LIST, because it is the round's blocker. A regex over
  // this source asserting the shape of the row's own `assert.fail(…)` used to
  // stand in for executing it — the construction this file denounces a hundred
  // lines above, applied to the branch the serial CI step actually reaches, and
  // it survived that branch being switched off. The branch is gone: the row
  // CALLS `settleSelfCheck`, whose body is driven above with both switch states.
  // A name is all that is checked here now, and a call site is the one thing a
  // source-text check can honestly assert, because deleting the call is a
  // deletion rather than a body that quietly stops deciding anything.
  const source = fs.readFileSync(path.join(REPO_ROOT, ALSO_MEASURED_SERIALLY[0]!), 'utf8');
  for (const name of [
    'SELF_CHECK_LABEL', 'SELF_CHECK_BUDGET_MS', 'SELF_CHECK_WAIT_MS', 'SELF_CHECK_MEASUREMENT_MARKER',
    'settleSelfCheck',
  ]) {
    // USED, not merely imported. A mutation that deleted `${STRICT_FAILURE_MARKER}`
    // from the strict failure message survived the first version of this loop,
    // because the name was still on the import line — and with the marker gone
    // the report step beside that row cannot tell an engaged switch from a
    // broken one, which is the whole of Major 2 reopened by one deletion.
    const uses = source.split(name).length - 1;
    assert.ok(uses >= 2, `the self-check row imports \`${name}\` and no longer uses it (${uses} occurrence(s))`);
  }
  // And it holds NO escalation of its own. A second `strictModeEngaged()` read
  // in this file is the defect this round removed coming back: two escalations
  // means the one the tests drive and the one CI reaches can be different
  // branches again, which is how a disabled escalation went green for a round.
  for (const escalation of ['strictModeEngaged', 'STRICT_ENV', 'assert.fail(']) {
    assert.ok(
      !source.includes(escalation),
      `the self-check row raises its own strict escalation again (\`${escalation}\`). There is one escalation in`
      + ' this repo — `settle`, reached from `settleSelfCheck` — because a second one is reachable in CI while'
      + ' every test drives the first.',
    );
  }
  for (const literal of [`'${SELF_CHECK_LABEL}'`, SELF_CHECK_MEASUREMENT_MARKER, `= ${SELF_CHECK_BUDGET_MS};`]) {
    assert.ok(
      !source.includes(literal),
      `the self-check row re-typed ${JSON.stringify(literal)} instead of importing it, which is the drift these`
      + ' constants were moved to prevent',
    );
  }
});

test('the workflow reader finds the jobs this repo has, with their real boundaries', () => {
  // The parser is the load-bearing half of every case above, so its own reading
  // of the committed file is pinned rather than assumed. A reader that silently
  // returned nothing would make every hollow-workflow case pass for the wrong
  // reason — it would report "zero steps" instead of the defect being injected.
  const jobs = parseWorkflowJobs(committedWorkflow);
  assert.deepEqual(jobs.map((job) => job.id),
    ['generate-check', ENFORCING_JOB, 'test-env-strict', 'fence-linux']);

  const serial = jobs.find((job) => job.id === ENFORCING_JOB)!;
  assert.ok(serial.steps.length >= 6, `the serial job parsed with ${serial.steps.length} steps`);
  // The boundary the old slice did not have: nothing from the next job leaks in.
  const serialLines = serial.steps.flatMap((step) => step.run);
  assert.ok(!serialLines.some((line) => line.includes('npm run test:env')),
    'the serial job slice reached into test-env-strict');
  // And comments really are gone, in both syntaxes — while `###` inside an
  // `echo` for the step summary, which is not one, is kept.
  assert.deepEqual(serialLines.filter((line) => line.trimStart().startsWith('#')), []);
  assert.ok(serialLines.some((line) => line.includes('echo "###')), 'a markdown heading was mistaken for a comment');
});

// ── the report steps' own shells, run the way CI runs them ───────────────────
// The static audit above refuses a measurement step that runs an `echo` where
// the test runner was. This section is the other half of that defeat, and it is
// the half that used to work: the peer wrote the log BY HAND. Every guard in
// every report step was a `grep -qF '<test title>'`, and a title is a string the
// hollow step can print. Three titles echoed into the log and the report step
// exited 0 over a job that measured nothing.
//
// So the report steps are no longer asked whether a NAME appeared. They are
// asked for the instrument's own verdict line WITH ITS NUMBERS, and this section
// PROVES that by extracting each committed step's shell and running it — the
// real body, out of the real file — against faked logs and against a genuine
// one. A claim about what a `grep` in a YAML file does, tested by reading the
// YAML file, is not a proof; running it is.
//
// TWO THINGS THIS SECTION GOT WRONG UNTIL NOW, both of which made it a proof
// about something other than CI.
//
//   1. IT RAN A DIFFERENT SHELL. `bash -c BODY` is not how GitHub runs
//      `shell: bash`, which is `bash --noprofile --norc -eo pipefail {0}`, and
//      the divergence is observable on the committed bodies rather than
//      theoretical. On a hook-timing log carrying every marker and zero
//      measured rows, `bash -c` printed the diagnostic annotation and exited 1
//      while CI's shell died at the bare `rows=$(grep -c …)` and printed
//      NOTHING — a red with no sentence attached, which the prose in this very
//      workflow calls the way a maintainer concludes a check is noise and
//      deletes it. It diverges in the other direction too: a log with 20k
//      matching lines made `grep -F … | grep -q …` take a broken pipe upstream,
//      which pipefail turns into a failure the old harness could not see. Both
//      are fixed in the workflow; the harness now runs the bodies under CI's
//      shell so a reintroduction is red here.
//   2. IT COVERED ONE STEP OF FOUR. The other three were certified by static
//      pattern matching alone, which is exactly the half that motivated this
//      section. They are structurally identical, so they are now one table and
//      one loop.
//
// The genuine log is built from `latencyVerdictLine`, the instrument's OWN
// renderer — the same function `settle()` prints from. That is the coupling the
// old fixture only claimed: it re-typed the `LATENCY BUDGET PASS ·` prefix by
// hand, so changing the prefix (which is what four CI steps grep on) left this
// suite green and would have reddened every report step on the next push.

const reportDirs = trackedTempDirs('t1-report-step-');
after(() => { reportDirs.cleanup(); });

/** Numbers a real measurement produced, for a fixture that has to look like one. */
const FIXTURE_STATS = {
  n: 250,
  wallP50: 0.48,
  wallP95: 0.81,
  wallMax: 2.04,
  cpuP50: 0.44,
  cpuP95: 0.62,
  cpuMax: 1.9,
  delivered: 1,
  ioDelivered: 1,
  attempts: 1,
  elapsedMs: 320,
};

/** The verdict line the instrument really prints for a passing budget. */
function realPassLine(label: string): string {
  return latencyVerdictLine(label, 15, { verdict: 'pass', reason: 'within budget', stats: FIXTURE_STATS });
}

/**
 * The verdict line the instrument really prints when it could not answer.
 *
 * The reason comes out of `classifyLatency` rather than being typed here,
 * because the phrase the CI grep demands (`wall p95 <x> ms >= <budget> ms`) is
 * assembled there and nowhere else.
 */
function realInconclusiveLine(label: string): string {
  const decision = classifyLatency({
    wall: Array.from({ length: 20 }, () => 22.86),
    cpu: Array.from({ length: 20 }, () => 3),
    delivered: 0.5,
    ioDelivered: 0.5,
  }, 15);
  assert.equal(decision.verdict, 'inconclusive', `the fixture stopped being inconclusive: ${decision.reason}`);
  return latencyVerdictLine(label, 15, { verdict: decision.verdict, reason: decision.reason, stats: FIXTURE_STATS });
}

/** One committed report step, and what a genuine log for it contains. */
interface ReportStepCase {
  /** Fragment of the step's `name:`, which is also this case's anchor. */
  readonly step: string;
  /** The log file it reads out of `$RUNNER_TEMP`. */
  readonly log: string;
  /** node:test titles it greps for by name. */
  readonly titles: readonly string[];
  /** Instrument labels it demands a verdict line for. */
  readonly labels: readonly string[];
  /** Other literal markers it demands (the hook-timing step has four). */
  readonly markers: readonly string[];
  /**
   * Table rows a real run of this measurement prints ALONGSIDE its verdicts.
   *
   * Only the hook-timing step has any: it counts measured rows as well as
   * demanding a verdict, and the dispatch table prints them whatever the
   * verdict turns out to be. A fixture without them makes an INCONCLUSIVE run
   * look like a run that measured nothing, which is a different thing.
   */
  readonly tableRows: readonly string[];
  /** Lines only a real measurement prints. The genuine log is titles + markers + these. */
  readonly measured: readonly string[];
  /** The same claim with its numbers removed — a phrase a hollow step can echo. */
  readonly phraseOnly: readonly string[];
  /** The same claim with a numeric shape the instrument never prints. */
  readonly zeroed: readonly string[];
  /** What a run that could not answer prints instead. */
  readonly unanswered: readonly string[];
  /**
   * What this step must do with `unanswered`, and the one axis the five steps
   * differ on. Four of them WARN: an inconclusive verdict is the instrument's
   * honest third value and a red for it would be a red about the runner. The
   * instrument self-check REDS, because its step sets the strict switch
   * precisely so the third value cannot be reached there — so a corridor-exit
   * line in that log means the switch stopped working, which is a self-mute
   * rather than a busy machine.
   */
  readonly unansweredIsFatal: boolean;
  /** The annotation an unanswerable run must produce. */
  readonly unansweredSays: RegExp;
  /** Substring of the annotation it emits when the numbers are missing. */
  readonly missing: RegExp;
}

/**
 * The four evidence shapes for a step whose evidence is the instrument's
 * VERDICT line, which is four of the five.
 */
function verdictEvidence(
  labels: readonly string[],
  tableRows: readonly string[],
): Pick<ReportStepCase, 'measured' | 'phraseOnly' | 'zeroed' | 'unanswered' | 'unansweredIsFatal' | 'unansweredSays'> {
  return {
    measured: [...tableRows, ...labels.map((label) => realPassLine(label))],
    phraseOnly: labels.map((label) => `LATENCY BUDGET PASS · ${label}`),
    // `[0-9.]+` accepted `0/0/0`, i.e. a triple with no decimals and no
    // magnitude. Every number on this line comes from `toFixed(2)`.
    zeroed: labels.map((label) => `LATENCY BUDGET PASS · ${label}  n= 1  wall p50/p95/max 0/0/0 ms`),
    unanswered: [...tableRows, ...labels.map((label) => realInconclusiveLine(label))],
    unansweredIsFatal: false,
    unansweredSays: /::warning title=.*UNENFORCED/,
  };
}

const SESSION_LABELS = [
  'session-start · unseen updates read + frame (8 items)',
  'session-start · unseen updates read, empty feed',
  'session-start · unseen updates, full first-session path incl. marker write',
];
const SESSION_TITLES = [
  'latency · the repeated SessionStart read stays a local read',
  'latency · the empty feed, which is what every session on every machine pays',
  'latency · the full first-session path, including the once-marker write',
];

/** One row per canonical event, which is the floor the hook-timing step counts to. */
const HOOK_EVENTS = [
  'SessionStart [SessionStart]', 'PreToolUse [PreToolUse]', 'PostToolUse [PostToolUse]',
  'UserPromptSubmit [UserPromptSubmit]', 'Stop [Stop]', 'SubagentStop [SubagentStop]',
  'PreCompact [PreCompact]',
];

/**
 * The corridor-exit line that row prints when it skips, through the
 * instrument's own renderer and with the instrument's own label and ceiling.
 *
 * The label and the ceiling used to be re-typed just above this, with the
 * argument that importing a test file into a test file registers its rows in
 * THIS process and that file's rows take ten seconds of live measurement. That
 * is true of the ROW's module and not of the instrument, so both constants moved
 * into latency-budget.ts and are imported here — the copies are gone, and with
 * them the source-text assertion that stood in for the coupling.
 */
function realCorridorExitLine(): string {
  return latencyVerdictLine(`${SELF_CHECK_LABEL} · corridor not reachable`, SELF_CHECK_BUDGET_MS, {
    verdict: 'inconclusive',
    reason: 'this machine burned 14.20 ms of CPU on a section whose unpatched cost is a ~0.15 ms median',
    stats: FIXTURE_STATS,
  });
}

const REPORT_STEPS: readonly ReportStepCase[] = [
  {
    step: 'Report the verdict (and refuse a hollow green)',
    log: 'latency-budget.log',
    titles: ['complete Write pre-tool path remains below the 150 ms p95 budget'],
    labels: ['complete Write pre-tool path'],
    markers: [],
    tableRows: [],
    ...verdictEvidence(['complete Write pre-tool path'], []),
    missing: /::error title=Latency budget was never measured/,
  },
  {
    step: 'Report the session-start verdicts',
    log: 'session-latency.log',
    titles: SESSION_TITLES,
    labels: SESSION_LABELS,
    markers: [],
    tableRows: [],
    ...verdictEvidence(SESSION_LABELS, []),
    missing: /::error title=Session-start budget was never measured/,
  },
  {
    step: 'Report the structural analysis verdict',
    log: 'react-structure.log',
    titles: ['hot single-file structural analysis remains below the 150 ms p95 budget'],
    labels: ['hot single-file structural analysis'],
    markers: [],
    tableRows: [],
    ...verdictEvidence(['hot single-file structural analysis'], []),
    missing: /::error title=Structural analysis budget was never measured/,
  },
  {
    // The one step whose evidence is not a verdict line. Its measurement's
    // subject IS an inconclusive verdict, so printing the instrument's
    // INCONCLUSIVE phrase on the run where everything went right would fire the
    // parallel job's "budget not checked" annotation on every push and bury the
    // signal it exists for. What that row prints instead is the instrument's
    // own COLUMN renderer; the INCONCLUSIVE phrase is reserved for the run
    // where it skipped, which is exactly when the parallel job should say so.
    step: 'Report the latency instrument self-check',
    log: 'latency-instrument.log',
    titles: ['the live instrument reaches an INCONCLUSIVE verdict when the filesystem is starved'],
    labels: [],
    markers: [],
    tableRows: [],
    measured: [
      `${SELF_CHECK_MEASUREMENT_MARKER}${latencyStatsLine(SELF_CHECK_LABEL, FIXTURE_STATS)}`
      + `  budget ${SELF_CHECK_BUDGET_MS.toFixed(2)} ms; 180 waits injected across 720 reads`,
    ],
    phraseOnly: [`${SELF_CHECK_MEASUREMENT_MARKER}${SELF_CHECK_LABEL}`],
    zeroed: [`${SELF_CHECK_MEASUREMENT_MARKER}${SELF_CHECK_LABEL}  n= 1  wall p50/p95/max 0/0/0 ms`],
    // A real corridor exit prints BOTH: the measurement happened and then fell
    // outside the bracket. So this fixture leaves the numbers in place, which
    // is what makes the row a test of the skip refusal rather than of the
    // missing-numbers one.
    unanswered: [
      `${SELF_CHECK_MEASUREMENT_MARKER}${latencyStatsLine(SELF_CHECK_LABEL, FIXTURE_STATS)}`
      + `  budget ${SELF_CHECK_BUDGET_MS.toFixed(2)} ms; 180 waits injected across 720 reads`,
      realCorridorExitLine(),
    ],
    unansweredIsFatal: true,
    unansweredSays: /::error title=Latency instrument self-check skipped instead of measuring \(the strict switch/,
    missing: /::error title=Latency instrument self-check was never measured/,
  },
  {
    // Seven labels because this step also counts measured rows and wants one
    // per canonical event; in a real run those rows come from the dispatch
    // table, which prints them through the same `latencyStatsLine`.
    step: 'Report per-event hook timing',
    log: 'hook-timing.log',
    titles: [
      'every hook event stays inside the 150 ms in-process dispatch budget at p95',
      'hook timing harness covers every canonical event and every declared hook subcommand',
    ],
    labels: HOOK_EVENTS,
    markers: ['HOOK TIMING · OS PROCESS', 'HOOK TIMING · BUDGET ENFORCED'],
    tableRows: HOOK_EVENTS.map((event) => `${latencyStatsLine(event, FIXTURE_STATS)}  headroom 3.3x`),
    ...verdictEvidence(HOOK_EVENTS, HOOK_EVENTS.map((event) => `${latencyStatsLine(event, FIXTURE_STATS)}  headroom 3.3x`)),
    missing: /::error title=Per-event hook budget printed no verdict/,
  },
];

/** The committed step, with the two declarations this harness depends on asserted. */
function reportStepBody(fragment: string, logName: string): string {
  const job = parseWorkflowJobs(committedWorkflow).find((candidate) => candidate.id === ENFORCING_JOB)!;
  const step = job.steps.find((candidate) => candidate.name.includes(fragment));
  assert.ok(step, `anchor lost: no report step named like "${fragment}"`);
  const body = stepBody(step);
  // The step reads its own log path out of RUNNER_TEMP; that spelling is the
  // anchor, and asserting it here is what keeps this proof pointed at a real file.
  assert.ok(body.includes(`"$RUNNER_TEMP/${logName}"`), `the report step's log path moved:\n${body}`);
  // And it declares the shell this harness is about to imitate. Without this the
  // harness runs `-eo pipefail` over a step CI might be running under `sh`.
  assert.equal(step.shell, 'bash', `"${fragment}" no longer declares \`shell: bash\``);
  return body;
}

/**
 * Run a committed report step's body THE WAY GITHUB RUNS IT.
 *
 * `bash --noprofile --norc -eo pipefail {0}` is the literal invocation behind
 * `shell: bash`, and every part of it matters here: errexit decides whether a
 * `grep` that matches nothing kills the step before it can annotate, and
 * pipefail decides what a pipeline whose head takes a broken pipe reports.
 */
function runReportStep(step: ReportStepCase, log: string | null): { code: number; output: string } {
  const body = reportStepBody(step.step, step.log);
  const home = reportDirs.make();
  if (log !== null) fs.writeFileSync(path.join(home, step.log), log);
  const script = path.join(home, 'step.sh');
  fs.writeFileSync(script, body);
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_TEMP: home,
      GITHUB_STEP_SUMMARY: path.join(home, 'step-summary.md'),
    },
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Everything a hollow step could `echo` into the log: the titles and the literal markers. */
function echoableLines(step: ReportStepCase): string[] {
  return [...step.titles.map((title) => `ok - ${title}`), ...step.markers];
}

function logOf(step: ReportStepCase, ...extra: readonly (readonly string[])[]): string {
  return `${[...echoableLines(step), ...extra.flat()].join('\n')}\n`;
}

test('the self-check report step names the cause its log actually shows, on both corridor exits', () => {
  // MAJOR: this step used to blame a cause the run had just DISPROVED. Rule 3
  // read the row's `corridor not reachable` diagnostic as proof that the strict
  // switch had failed to engage — but the row prints that diagnostic BEFORE it
  // reads the switch, so it is in the log on the engaging runs too. Every
  // genuine strict failure was therefore annotated "skipped instead of
  // measuring", which sends a maintainer to inspect a switch that had just
  // worked while the actual finding — this runner left the corridor — went
  // unnamed. Both logs below are red, and both should be.
  const selfCheck = REPORT_STEPS.find((step) => step.step.includes('instrument self-check'))!;
  const measurement = selfCheck.measured;

  // The switch ENGAGED: the row failed, and the failure carries the marker the
  // instrument exports for exactly this. The finding is the machine.
  const engaged = runReportStep(selfCheck, logOf(selfCheck, measurement, [
    realCorridorExitLine(),
    `not ok 1 - the live instrument reaches an INCONCLUSIVE verdict when the filesystem is starved`,
    `  AssertionError: this machine burned 31.20 ms of CPU — ${STRICT_FAILURE_MARKER} — n=60`,
  ]));
  assert.equal(engaged.code, 1, `a corridor exit under the engaged switch was not fatal:\n${engaged.output}`);
  assert.match(
    engaged.output,
    /::error title=Latency instrument self-check left its corridor on this runner/,
    `the step blamed the switch on a run where the switch demonstrably engaged:\n${engaged.output}`,
  );
  assert.doesNotMatch(engaged.output, /the strict switch did not engage/, engaged.output);

  // The switch did NOT engage: the same diagnostic, no failure behind it. The
  // finding is the wiring, and this is the state the whole step exists for.
  const skipped = runReportStep(selfCheck, logOf(selfCheck, measurement, [realCorridorExitLine()]));
  assert.equal(skipped.code, 1, `a silent corridor skip was not fatal:\n${skipped.output}`);
  assert.match(
    skipped.output,
    /::error title=Latency instrument self-check skipped instead of measuring \(the strict switch did not engage\)/,
    skipped.output,
  );
  assert.doesNotMatch(skipped.output, /left its corridor on this runner/, skipped.output);

  // The marker is the instrument's, not a copy: a rename of STRICT_ENV moves it,
  // and this asserts the workflow moved with it.
  assert.ok(
    reportStepBody(selfCheck.step, selfCheck.log).includes(STRICT_FAILURE_MARKER),
    `the report step no longer greps for "${STRICT_FAILURE_MARKER}", so it cannot tell the two exits apart`,
  );
});

test('all five report steps are found, declare bash, and there are as many as this file thinks', () => {
  const job = parseWorkflowJobs(committedWorkflow).find((candidate) => candidate.id === ENFORCING_JOB)!;
  const reporting = job.steps.filter((step) => /^Report /.test(step.name));
  assert.equal(
    reporting.length,
    REPORT_STEPS.length,
    `the enforcing job has ${reporting.length} report steps and this file drives ${REPORT_STEPS.length}:`
    + ` ${reporting.map((step) => step.name).join(' | ')}. A report step nobody executes is certified by static`
    + ' pattern matching alone, which is the half this section exists to replace.',
  );
  for (const step of REPORT_STEPS) reportStepBody(step.step, step.log);
});

for (const step of REPORT_STEPS) {
  test(`"${step.step}" ACCEPTS a log a real measurement produced`, () => {
    // One-sided proof is no proof: a step that rejects everything is not a
    // checker either, and it would be red on every push until someone deleted it.
    const real = runReportStep(step, logOf(step, step.measured));
    assert.equal(real.code, 0, `the report step rejected a genuine measurement:\n${real.output}`);
  });

  test(`"${step.step}" REJECTS the faked log that defeated its name-shaped predecessor`, () => {
    // Verbatim what the hollow step produced: the titles and markers, printed by
    // an `echo` standing where the measurement was, teed to the log the report
    // step reads. Every `grep -qF '<title>'` in the old step found what it was
    // looking for, so the job went green having measured nothing.
    const faked = runReportStep(step, logOf(step));
    assert.equal(
      faked.code,
      1,
      `the report step accepted a log with no measurement in it — this is the hollow green:\n${faked.output}`,
    );
    assert.match(faked.output, step.missing);
    // The titles themselves are still found — that is the point. The step is no
    // longer satisfied by finding them.
    assert.ok(
      !faked.output.includes('did not run::'),
      `a title check misfired on a log that contains every title:\n${faked.output}`,
    );
  });

  test(`"${step.step}" refuses the verdict PHRASE with no numbers under it`, () => {
    // A hollow step that learns the phrase can print the phrase. What it cannot
    // print without deliberately fabricating one is a p50/p95/max triple — a
    // different act from copying a title out of a test file, and NOT a
    // categorically harder one, which is why the static invocation detector
    // rather than this grep is what holds the line.
    const faked = runReportStep(step, logOf(step, step.phraseOnly));
    assert.equal(faked.code, 1, `a verdict phrase with no numbers behind it was accepted:\n${faked.output}`);
    assert.match(faked.output, step.missing);
  });

  test(`"${step.step}" does not count the verdict line quoted inside prose`, () => {
    // The unanchored form accepted this, and it is the cheapest fake there is:
    // no fabricated numbers, no format to copy — a sentence in a log that
    // happens to mention a past measurement. Every string these greps demand is
    // printed verbatim in the workflow file itself.
    const inProse = runReportStep(step, logOf(
      step,
      step.measured.map((line) => `# TODO re-check ${line} from the old run`),
    ));
    assert.equal(inProse.code, 1, `a verdict quoted inside a comment was accepted as a measurement:\n${inProse.output}`);
    assert.match(inProse.output, step.missing);
  });

  test(`"${step.step}" refuses a prefix no reporter emits, including a diff-removal line`, () => {
    // The prefix class was `[^A-Za-z]*`, which refuses a leading WORD and
    // nothing else. Measured as accepted: a quote marker, a pasted bullet, an
    // indented failure-YAML line, and the pointed one — a DIFF-REMOVAL line, so
    // a log showing the verdict being deleted read as the verdict being
    // present. Narrowed to the two prefixes a reporter actually emits, which
    // leaves the tap `#` admitting a shell comment as a limit no pattern can
    // remove (the same character means both, and `# LATENCY BUDGET …` in a log
    // is a diagnostic under tap).
    for (const prefix of ['-', '> ', '+ ', '"', "'", '  - ']) {
      const prefixed = runReportStep(step, logOf(step, step.measured.map((line) => `${prefix}${line}`)));
      assert.equal(
        prefixed.code,
        1,
        `a verdict line prefixed with ${JSON.stringify(prefix)} was counted as a measurement:\n${prefixed.output}`,
      );
      assert.match(prefixed.output, step.missing);
    }
    // And the two that ARE a reporter's own prefix still pass, indented or not:
    // node:test prints diagnostics as `# text` under tap and `ℹ text` under
    // spec, and a step that refused those would be red on whichever Node the
    // runner happens to have.
    for (const prefix of ['# ', 'ℹ ', '    # ', '    ℹ ']) {
      const prefixed = runReportStep(step, logOf(step, step.measured.map((line) => `${prefix}${line}`)));
      assert.equal(
        prefixed.code,
        0,
        `the reporter prefix ${JSON.stringify(prefix)} was refused, so this step is red under one reporter:`
        + `\n${prefixed.output}`,
      );
    }
  });

  test(`"${step.step}" refuses numbers that are not the shape the instrument prints`, () => {
    const zeroed = runReportStep(step, logOf(step, step.zeroed));
    assert.equal(zeroed.code, 1, `an all-zero triple with no decimals was accepted:\n${zeroed.output}`);
    assert.match(zeroed.output, step.missing);
  });

  test(`"${step.step}" ${step.unansweredIsFatal ? 'REDS on' : 'warns about'} a run that could not answer`, () => {
    // The third value has to survive the strengthening: for four of these steps
    // an inconclusive run is the one outcome that is otherwise a silent skip,
    // and it must warn rather than fail — the parallel path reaches it by
    // construction. The fifth is the instrument self-check, whose step sets the
    // strict switch so that outcome cannot be reached there; a skip line in its
    // log means the switch stopped working, and that is a red.
    const unanswered = runReportStep(step, logOf(step, step.unanswered));
    assert.equal(unanswered.code, step.unansweredIsFatal ? 1 : 0, unanswered.output);
    assert.match(unanswered.output, step.unansweredSays);
  });
}

test('a log short of ONE label is a failure, named', () => {
  // Three budgets split across three tests is what keeps one inconclusive leg
  // from skipping the other two, so a log carrying two of the three
  // under-measured — and the annotation has to say WHICH, rather than one
  // generic red that sends the reader looking for a broken pipeline.
  const session = REPORT_STEPS.find((step) => step.log === 'session-latency.log')!;
  const short = runReportStep(session, `${[
    ...session.titles.map((title) => `ok - ${title}`),
    ...session.labels.slice(1).map((label) => realPassLine(label)),
  ].join('\n')}\n`);
  assert.equal(short.code, 1, `two measurements out of three were accepted as three:\n${short.output}`);
  assert.ok(short.output.includes(session.labels[0]!), short.output);
});

test('a report step that reaches a red still prints the sentence explaining it', () => {
  // MEASURED DIVERGENCE, and the reason this harness runs CI's shell. Under
  // `bash -c` the hook-timing body printed its annotation and exited 1 on a log
  // with every marker and zero measured rows. Under `-eo pipefail` the bare
  // `rows=$(grep -c …)` — grep exits 1 when it counts nothing — killed the step
  // first, so CI got a red with no sentence attached. An unexplained red is how
  // a check gets deleted, which makes this a self-mute on a slow fuse.
  const hooks = REPORT_STEPS.find((step) => step.log === 'hook-timing.log')!;
  const noRows = runReportStep(hooks, `${[
    ...hooks.titles.map((title) => `ok - ${title}`),
    ...hooks.markers,
    realInconclusiveLine('row'),
  ].join('\n')}\n`);
  assert.equal(noRows.code, 1, `a log with zero measured rows was accepted:\n${noRows.output}`);
  assert.match(
    noRows.output,
    /::error title=Per-event hook timing measured too few rows::found 0 measured rows/,
    `the step went red without saying why — this is the errexit divergence:\n${noRows.output}`,
  );
});

test('a genuine log with thousands of matching lines is still a pass under pipefail', () => {
  // The divergence in the other direction. `grep -F … | grep -q …` lets the
  // downstream exit on its first match, and the upstream then takes a broken
  // pipe; under pipefail that is a failing pipeline, so a log with MORE
  // evidence in it than usual read as no evidence at all. One anchored grep has
  // no upstream to kill.
  const session = REPORT_STEPS.find((step) => step.log === 'session-latency.log')!;
  const many = runReportStep(session, `${[
    ...session.titles.map((title) => `ok - ${title}`),
    ...session.labels.flatMap((label) => Array.from({ length: 2000 }, () => realPassLine(label))),
  ].join('\n')}\n`);
  assert.equal(many.code, 0, `a log with 6000 genuine verdict lines was rejected:\n${many.output}`);
});

/**
 * The checker job's count step, run the way GitHub runs it.
 *
 * The rule in `auditCheckerJob` that REQUIRES this step is a shape check over
 * the workflow text, and a shape check is exactly what this file denounces
 * elsewhere: it passes with the step's body replaced by an `echo`. What makes
 * the requirement worth having is that the body it requires is executed here,
 * against the two logs that decide it — the one a real run produces and the one
 * a filtered run produces. The static rule keeps the step present; this keeps it
 * a checker.
 */
function runCountStep(log: string | null): { code: number; output: string } {
  const job = parseWorkflowJobs(committedWorkflow).find((candidate) => candidate.id === CHECKER_JOB)!;
  const step = job.steps.find((candidate) => candidate.name.includes('Refuse a suite that ran'));
  assert.ok(step, 'anchor lost: the checker job has no step holding the suite to a minimum count');
  assert.equal(step.shell, 'bash', 'the count step no longer declares `shell: bash`');
  const home = reportDirs.make();
  if (log !== null) fs.writeFileSync(path.join(home, 'npm-test.log'), log);
  const script = path.join(home, 'step.sh');
  fs.writeFileSync(script, stepBody(step));
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: home, GITHUB_STEP_SUMMARY: path.join(home, 'step-summary.md') },
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** A runner summary in the two spellings CI can actually produce. */
function suiteSummary(passed: number, reporter: 'tap' | 'spec'): string {
  const marker = reporter === 'tap' ? '#' : 'ℹ';
  return [
    'ok 1 - some test',
    `${marker} tests ${passed}`,
    `${marker} suites 291`,
    `${marker} pass ${passed}`,
    `${marker} fail 0`,
    `${marker} cancelled 0`,
  ].join('\n');
}

test('the suite-count step REFUSES the log a filtered run produces, and accepts a real one', () => {
  // THE ONLY CLOSABLE MEMBER OF THE RESIDUAL. `npm test --
  // --test-name-pattern='zzzz-no-such-test'` and `npm test -- --test-only` are
  // refused by the audit above, but the identical silencing can arrive from the
  // `test` script, from NODE_OPTIONS or from an .npmrc, and no rule about this
  // workflow can see any of those. What it leaves behind is a green log with a
  // count in it, so the count is where it is caught — measured on Node 26.5.0,
  // a file holding one FAILING test reports `tests 1 / pass 1 / fail 0` under
  // either flag, which is the `passed = 1` case below.
  const filtered = runCountStep(`${suiteSummary(1, 'tap')}\n`);
  assert.equal(filtered.code, 1, `a suite that ran ONE test was accepted as a full run:\n${filtered.output}`);
  assert.match(filtered.output, /::error title=The suite did not run::it reported 1 passing tests/, filtered.output);

  // And it is not a step that refuses everything, which would be red on every
  // push until somebody deleted it. Both reporters, because Node 22 (this
  // runner's pin) and Node 26 default to different ones and both spellings are
  // correct output — a check that reads only one of them silently stops
  // checking on a version bump.
  for (const reporter of ['tap', 'spec'] as const) {
    const real = runCountStep(`${suiteSummary(3000, reporter)}\n`);
    assert.equal(real.code, 0, `a genuine ${reporter} summary was rejected:\n${real.output}`);
  }

  // A log with no summary at all is the third state, and it is a red rather
  // than a pass: a runner that printed no count is a runner nothing here can
  // tell apart from one that ran nothing.
  const silent = runCountStep('ok 1 - some test\n');
  assert.equal(silent.code, 1, `a log with no count was accepted:\n${silent.output}`);
  assert.match(silent.output, /::error title=The suite reported no count/, silent.output);

  // No log at all defers, for the same reason every report step does: the step
  // that would have written it is already red. What makes that sound HERE is
  // the audit rule refusing a suite step that tees nowhere, which is the
  // `stops teeing its output` case in the table above.
  const absent = runCountStep(null);
  assert.equal(absent.code, 0, `a missing log reddened the count step instead of deferring:\n${absent.output}`);
});

test('no log at all is a quiet exit 0, and that is only sound because of what is above it', () => {
  // The last runtime self-mute, and it is deliberate: `[ -f "$log" ] || exit 0`
  // in all four steps. Read alone it is the shape this whole section refuses —
  // a checker whose own guard turns it off. It is sound here only because every
  // path that reaches a missing log has ALREADY reddened this job, and each of
  // those is held by a rule with its own row above:
  //
  //   - the measurement never started: its `if:` must be spelled from
  //     MEASUREMENT_CONDITIONS, and every term of that spelling is now owned.
  //     The premise recorded here used to be "its only skipping term is a
  //     FAILED install step", and that was false in the direction that matters:
  //     the failure route is closed (a failed step carrying no
  //     continue-on-error fails the job), but a DELETED `id:`, an `if: false`
  //     on the install step, or any condition that lets it skip were all
  //     skipping terms too, and all three left this exit 0 standing over four
  //     unmeasured budgets. The audit now requires the named step to exist, to
  //     run before the step naming it, and to carry no condition of its own —
  //     so "install did not succeed" means "install FAILED" again;

  //   - the measurement started and died before `tee`: the step is red, and it
  //     may not mask its status;
  //   - the run was cancelled: `if: always()` reruns this step, and a red on a
  //     cancelled run is noise about nothing.
  //
  // So it is recorded here as an assertion rather than as prose: if any of
  // those rules is relaxed, this exit 0 becomes a hollow green and this row is
  // where a reader is sent.
  for (const step of REPORT_STEPS) {
    const absent = runReportStep(step, null);
    assert.equal(absent.code, 0, `a missing log reddened "${step.step}" instead of deferring to the step that failed:\n${absent.output}`);
    assert.equal(absent.output.trim(), '', `a missing log annotated instead of deferring:\n${absent.output}`);
  }
  const job = parseWorkflowJobs(committedWorkflow).find((candidate) => candidate.id === ENFORCING_JOB)!;
  assert.ok(
    job.steps.every((step) => !step.continueOnError),
    'a step in the enforcing job now masks its status, which makes the missing-log exit 0 above a hollow green',
  );
  // And "died before tee" has to be able to red the step at all: every one of
  // these measurements IS a masked pipeline, so it is `set -o pipefail` above
  // it, not the exit status of `tee`, that carries the failure out.
  assert.deepEqual(stepsPipingWithoutPipefail(committedWorkflow), []);
});

// ── the census: which assertions hold a wall clock to a number ───────────────
// The coverage set above is "files that import the instrument", which is a
// complete answer about the population that already adopted the fix and a silent
// one about everything else. It missed a 150 ms p95 assertion in the plan-guard
// tests — same threshold, same 250 samples, same warmup, same percentile index
// as the Write pre-tool budget — written by hand as `assert.ok(p95 < 150)` over
// its own `performance.now()` loop. It imported nothing, so no coverage check
// could see it; it ran only on the parallel path, where a wall-clock verdict is
// not evidence either way. Un-enforced and flake-prone at once.
//
// So the population is taken from the SHAPE (a clock difference, and an
// assertion comparing something derived from it against a number) and recorded
// here with a judgement per site. Two directions are asserted: nothing new
// appears unclassified, and the census can still SEE the hand-rolled shape that
// motivated it.

/**
 * The baseline, keyed by file and normalized claim and NOT by line.
 *
 * A line-keyed baseline is a harness defect, not a stricter check: an unrelated
 * edit anywhere above a site renumbers it and reports a new violation that is
 * the same old one. tests/refusal-contract.test.ts had exactly that shape and
 * reddened another lane this week over a one-line shift. `file + claim` survives
 * reformatting, moving the site within its file, and any edit above it; what it
 * cannot distinguish is two identical claims in one file, which is why the count
 * is part of the key rather than a set membership test.
 */
const CLASSIFIED_WALL_CLOCK_CLAIMS: Readonly<Record<string, string>> = {
  // WHAT THIS MAP CANNOT DO, deliberately: it is a one-line escape. Migrate a
  // budget back to a hand-rolled `assert.ok(p95 < N)`, add a row here marked
  // 'boundedness', and everything stays green — the census records a HUMAN
  // judgement about a site's kind, and no static shape distinguishes a speed
  // claim from a boundedness one (both are a clock difference against a
  // number). What the map buys is that the judgement has to be written down, by
  // name, in a diff someone reviews, next to entries whose stated slack a
  // reviewer can compare against. The same trade as the condition allowlist:
  // exact and reviewable, not inferential. If it is ever taken, the coverage
  // set and the serial job's report step are what notice the budget stopped
  // being measured, not this map.
  //
  // Boundedness assertions: "this call returned at all", with the timeout it is
  // bounded by and a large multiple of it as the ceiling. Not latency budgets —
  // there is no user-facing speed claim behind any of them — and migrating them
  // to the three-valued instrument would be wrong: an unanswerable machine
  // should not turn "the call was bounded" into a skip, because that is the
  // property whose absence hangs the suite forever.
  'src/shared/__tests__/exec.test.ts  elapsed < 250*40  x1': 'boundedness, 40x slack',
  'src/shared/__tests__/git-init.test.ts  elapsed < 30000  x1': 'boundedness, spawn ceiling',
  'src/runners/onboarding-wait/__tests__/wait.test.ts  elapsed < 2000  x1': 'boundedness, 350 ms wait',
  'src/shared/onboarding-server/__tests__/wizard-links.test.ts  waited < 2000  x1': 'boundedness, 100 ms wait',
  'src/shared/state/__tests__/run-agent.test.ts  elapsed < 4000  x3': 'boundedness, 1800 ms floor',
  // Same shape and the same floor as the row above it, one lock over: a held
  // `.cursor-spawns.lock` must make SubagentStart give up inside
  // CURSOR_SPAWN_LOCK_TIMEOUT_MS and REPORT the gap, and the pair of bounds is
  // how the row tells a real acquisition timeout from the store refusing for
  // some cheaper reason. Nothing here claims a spawn hook is fast.
  'src/modules/agent-model/__tests__/cursor-failures.test.ts  elapsed < 6000  x1':
    'boundedness, 1800 ms floor under a 2 s lock budget',
  'src/shared/state/__tests__/run-agent.test.ts  elapsed < 12000  x3': 'boundedness, 3500 ms floor',
  // Both of these sit UNDER a deadline rather than over a measured cost, which
  // is the boundedness shape: the runner must give up inside its poll loop
  // instead of holding the process to its readiness budget, and two contended
  // carries must share ONE lease budget instead of taking one each (the row
  // above them asserts the 8 s floor).
  //
  // The lighthouse ceiling was 3500 under a 4 s budget and is now 10000 under a
  // 20 s one, for a reason that does not weaken the claim: the wall clock there
  // spans `node --import tsx index.mts` booting as well as the poll it is
  // grading, and that boot alone measured 3.6-7.7 s with the rest of the suite
  // compiling beside it — so at the old ceiling a loaded machine and a runner
  // holding its process open were the SAME observation, and the row red at
  // 5234 ms with nothing wrong. Both numbers moved together, so the ratio a
  // regression has to cross is unchanged: boot cannot reach 10 s, and a runner
  // that waits out its budget cannot come in under 20 s.
  'src/runners/lighthouse/__tests__/preview-start-failure.test.ts  elapsedMs < 10000  x1':
    'boundedness, under a 20 s readiness deadline',
  'src/runners/traffic-one-reset/__tests__/carry-integrity.test.ts  elapsed < 14000  x2':
    'boundedness, one shared lease budget',
  // The one worth re-reading if it ever flakes: a 500 ms cap on a re-entrant
  // lock acquisition. The CLASSIFICATION is right — it is a deadlock detector,
  // not a speed claim, because nothing here asserts that re-entrancy is fast
  // for its own sake — but the reason recorded here used to be that "the
  // failure it guards against takes forever", and that is false. The regression
  // it detects spins to the lock's 1 s acquisition deadline and THROWS, which
  // the file being cited states four lines above the assertion, with four
  // measured instances (1004/1007/1004/1006 ms) against 1 ms for the control.
  // So the cap is 500 ms because it sits between an immediate memo hit and a
  // deadline twice its size, not because the alternative is unbounded — the
  // slack is 500x on the passing side and 2x on the failing side.
  'src/shared/__tests__/lock-path-spelling-exclusion.test.ts  sameSpellingMs < 500  x1': 'deadlock detector',
};

/** `file  claim  xN`, so a line shift cannot renumber a baseline entry. */
function censusKeys(claims: readonly WallClockClaim[]): string[] {
  const counts = new Map<string, number>();
  for (const claim of claims) {
    const key = `${claim.file}  ${claim.claim.replace(/\s*([*/+-])\s*/g, '$1')}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key}  x${count}`).sort();
}

test('every wall-clock threshold assertion in this repo is classified, however it is spelled', () => {
  const claims: WallClockClaim[] = [];
  for (const file of [...sourceFiles(path.join(REPO_ROOT, 'src')), ...sourceFiles(path.join(REPO_ROOT, 'tests'))]) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    // This file's own fixtures are import statements and log lines in string
    // literals, not measurements.
    if (file === __filename) continue;
    claims.push(...wallClockClaimsIn(relative, fs.readFileSync(file, 'utf8')));
  }
  // Upper bounds only: a floor ("this took AT LEAST the timeout") is the one
  // direction contention cannot break, so it needs no verdict of its own.
  const upper = claims.filter((claim) => claim.upperBound);
  assert.ok(upper.length > 0, 'the census found nothing at all, which means it stopped working');

  const unclassified = censusKeys(upper).filter((key) => !(key in CLASSIFIED_WALL_CLOCK_CLAIMS));
  assert.deepEqual(
    unclassified,
    [],
    'these assertions hold a wall clock to a number and nobody has said which kind they are.\n\n'
    + 'If it is a LATENCY BUDGET — a user-facing speed claim — it belongs in assertLatencyBudget and in a\n'
    + `step of the \`${ENFORCING_JOB}\` job, or it is enforced nowhere: on the parallel path an INCONCLUSIVE\n`
    + 'is a skip and the step over the suite log only warns. If it is a BOUNDEDNESS assertion — "this call\n'
    + 'returned at all", with a large multiple of its own timeout as the ceiling — record it below and leave\n'
    + `it alone.\n\n${unclassified.map((key) => `  - ${key}`).join('\n')}`,
  );
});

test('the census sees a hand-rolled budget that imports nothing', () => {
  // The site that motivated the census, in the shape it had before it was
  // migrated: a `performance.now()` difference accumulated into an array,
  // sorted, indexed at the 95th percentile, and compared against a literal.
  // Every coverage check in this repo was blind to it because it imported
  // nothing. This is the counterexample the census must never stop finding.
  const handRolled = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    'test(`hot single-file structural analysis`, () => {',
    '  const durations: number[] = [];',
    '  for (let i = 0; i < 250; i += 1) {',
    '    const started = performance.now();',
    '    analyze(source);',
    '    durations.push(performance.now() - started);',
    '  }',
    '  durations.sort((a, b) => a - b);',
    '  const p95 = durations[Math.floor(durations.length * 0.95)]!;',
    '  assert.ok(p95 < 150, `p95 ${p95} ms`);',
    '});',
  ].join('\n');
  const found = wallClockClaimsIn('example.test.ts', handRolled);
  assert.deepEqual(found.map((claim) => claim.claim), ['p95 < 150'], JSON.stringify(found));
  assert.equal(found[0]!.upperBound, true);

  // And the variants: a `Date.now()` clock, an alias in between, the comparison
  // written the other way round, and a threshold written as arithmetic.
  const variants: Readonly<Record<string, string>> = {
    'const t0 = Date.now();\nconst took = Date.now() - t0;\nassert.ok(took <= 150);': 'took <= 150',
    'const t0 = performance.now();\nconst d = performance.now() - t0;\nconst ms = d;\nassert.ok(150 > ms);':
      'ms < 150',
    'const t0 = performance.now();\nconst d = performance.now() - t0;\nassert.ok(d < 250 * 40);': 'd < 250 * 40',
  };
  for (const [source, expected] of Object.entries(variants)) {
    assert.deepEqual(
      wallClockClaimsIn('v.test.ts', source).map((claim) => claim.claim),
      [expected],
      `not found, or found as something else: ${source}`,
    );
  }

  // A timestamp is not a duration, and this repo is full of timestamps. A census
  // that counted them would drown the classification above in noise and get it
  // rubber-stamped.
  assert.deepEqual(wallClockClaimsIn('v.test.ts', 'const at = Date.now();\nassert.ok(at > 1000);'), []);
});
