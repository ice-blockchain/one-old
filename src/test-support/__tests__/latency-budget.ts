// src/test-support/__tests__/latency-budget.ts
// A three-valued instrument for wall-clock latency budgets: PASS, FAIL, or
// "this machine could not answer the question".
//
// WHY THIS EXISTS. A wall-clock p95 taken on a contended machine is not
// evidence in EITHER direction, so a two-valued assertion on it is dishonest
// whichever way it lands. Measured on this repo's own Write pre-tool budget
// (150 ms p95, 250 samples), the same assertion produced 28 ms on an idle
// machine and 166 ms, 16.8 s, 31 s and 47.9 s under load — four orders of
// magnitude, none of them a code change. `npm run test:env -- --strict`
// already answers this class of question with a third value (a case whose
// toolchain is absent is INCONCLUSIVE, never PASS and never FAIL); this is the
// same treatment for a measurement whose machine was absent.
//
// WHY IT LIVES UNDER __tests__/. tsconfig.build.json excludes `src/**/__tests__/**`
// but NOT `src/test-support/**` — src/test-support/host-prefs.ts is compiled
// into dist/scripts/ today. Test scaffolding has no business in the shipped
// hook runtime, so this file stays in the excluded directory. Moving it one
// level up to src/test-support/ silently adds it to the plugin bundle and
// makes `npm run build:verify` red until dist is rebuilt. The repo already
// keeps non-test helpers in __tests__/ for other reasons
// (plan-guard/__tests__/architect-phase-fixtures.ts,
// agent-model/__tests__/agent-model-fixtures.ts).

import type { TestContext } from 'node:test';
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type LatencyVerdict = 'pass' | 'fail' | 'inconclusive';

export interface LatencyBudgetOptions {
  /** Human name of the path being measured; appears in every verdict line. */
  readonly label: string;
  /** The user-facing wall-clock claim, in milliseconds, at p95. */
  readonly budgetMs: number;
  /** The thing being timed. Called warmup + samples times. */
  readonly run: () => void;
  readonly samples?: number;
  readonly warmup?: number;
}

/**
 * The async twin of LatencyBudgetOptions.
 *
 * It exists because the thing this repo most needs a per-event budget on —
 * core/dispatch.ts, and the host entries above it — is `async`. Handing an
 * async function to the SYNCHRONOUS measurement below times how long it takes
 * to return a pending promise (measured: ~0.01 ms for a 39 ms SessionStart),
 * which is not a small error, it is no measurement at all.
 */
export interface LatencyBudgetAsyncOptions {
  readonly label: string;
  readonly budgetMs: number;
  readonly run: () => Promise<unknown> | unknown;
  readonly samples?: number;
  readonly warmup?: number;
  /**
   * Per-sample preparation, EXCLUDED from the timed window and from the CPU
   * accounting. This is what makes a COLD distribution measurable: a hook's
   * first invocation against a project pays work (materialization, the
   * retention sweep, cache population) that its second does not, so "build a
   * fresh project, then time one invocation" is the only shape that can see
   * it. Without a setup seam the fixture build lands inside the sample and
   * swamps the thing being measured.
   */
  readonly setup?: () => Promise<unknown> | unknown;
}

export interface LatencyStats {
  readonly n: number;
  readonly wallP50: number;
  readonly wallP95: number;
  readonly wallMax: number;
  readonly cpuP50: number;
  readonly cpuP95: number;
  readonly cpuMax: number;
  /**
   * Fraction of the CPU a fixed reference workload ASKED for that the machine
   * actually delivered during this measurement window. 1.0 = never descheduled.
   */
  readonly delivered: number;
  /**
   * The same fraction for a fixed FILESYSTEM reference workload — see
   * IO_REFERENCE_BYTES. 1.0 = every syscall it made returned without waiting.
   */
  readonly ioDelivered: number;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface LatencyOutcome {
  readonly verdict: LatencyVerdict;
  readonly reason: string;
  readonly stats: LatencyStats;
}

/**
 * The measurement is admitted as evidence when a fixed reference workload got
 * at least this fraction of the CPU it asked for. The number is not a taste
 * threshold: delivery `d` means a CPU-bound section is inflated by at most
 * `1/d`, so at d >= 0.8 the machine can stretch a timing by at most 1.25x.
 * This repo's Write path has a ~28 ms idle p95 against a 150 ms budget, so a
 * breach is a >5x event — arithmetically out of reach for a machine still
 * delivering 80%. Contention severe enough to manufacture a breach drove
 * delivery to 0.23-0.29 in every induced-load measurement taken here.
 *
 * The threshold is deliberately LENIENT (it calls marginal machines "quiet",
 * which biases toward FAIL) because a muted budget is worse than a flaky one.
 *
 * It is applied to the WORSE of the two reference workloads — see `Reference`.
 * A floor on the arithmetic reference alone was a floor on one of the two ways
 * a machine can hold this process up.
 */
const DELIVERY_FLOOR = 0.8;

/**
 * A second attempt is only worth taking when the first was CHEAP. A bursty
 * disturbance on an otherwise-idle machine clears; a sustained one does not,
 * and re-measuring under it just multiplies a 60 s attempt. Above this cap the
 * machine is not merely disturbed, it is busy, and the answer is already known.
 */
const RETRY_IF_ATTEMPT_UNDER_MS = 15_000;

/**
 * Env switch mirroring `test:env --strict`: refuse to let inconclusive pass.
 *
 * `T1_`, deliberately NOT `TRAFFIC_ONE_`. src/build/test-preload.mjs wipes the
 * ENTIRE `TRAFFIC_ONE_` namespace (and every host namespace) out of the
 * environment before any test file loads, keeping only the three names in its
 * own PRELOAD_OWNED_ENV allowlist — so a `TRAFFIC_ONE_`-prefixed switch is
 * silently deleted and the strict mode never engages. Measured: it skipped
 * instead of failing. This is the same prefix the repo's other test-visible
 * switches use (T1_OC_ABANDON_MS, T1_OC_STATUS_WAIT_MAX_MS, …) for the same
 * reason.
 *
 * EXPORTED because a CI step now sets it, and the spelling in that step has to
 * be tied to this constant by something. Measured before it was: this name
 * appeared in the whole repository exactly three times — its own definition,
 * the branch that reads it, and one line of prose — so the escalation it offers
 * could not happen on any runner, and every claim resting on "strict mode still
 * makes this a hard failure" was resting on a switch nobody flips. A
 * hand-retyped spelling in a workflow is the same hatch one rename away, so
 * latency-budget-ci.test.ts asserts the step's `env:` key against this value.
 */
export const STRICT_ENV = 'T1_LATENCY_BUDGET_STRICT';

/**
 * Is strict mode on? The ONE read of the switch, shared by everything that
 * escalates on it.
 *
 * A function rather than two `process.env[STRICT_ENV] === '1'` expressions
 * because both of the ones it replaces were unreachable-in-practice and
 * untested, and the guard on one of them was a `source.includes(...)` on this
 * file's own text — a check that passes on a branch whose body has been
 * deleted. Reading the switch through a named export gives the tests something
 * to EXECUTE: latency-budget-ci.test.ts drives this and `settle` directly, with
 * the variable set and unset, which is a check the string search could not be.
 */
export function strictModeEngaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STRICT_ENV] === '1';
}

/**
 * The label, ceiling and diagnostic marker of the instrument's live self-check.
 *
 * HERE, IN THE INSTRUMENT, rather than in the row that uses them, because three
 * files have to agree about these strings and one of them must not import the
 * other two. The row lives in latency-budget.test.ts; the CI report step in
 * generate-check.yml greps for the label and the marker; latency-budget-ci.test.ts
 * checks that the grep patterns match what the row emits. Importing the row's
 * module from the CI test would register the row — ten seconds of live
 * measurement inside a structural test — so the CI test used to re-type the
 * three strings and assert the workflow contained them, which couples the check
 * to a copy rather than to the value. A constant is the only thing all three can
 * share.
 */
export const SELF_CHECK_LABEL = 'live filesystem reference (starved)';

/**
 * The corridor ceiling, and it is calibrated against the GC/JIT term rather
 * than against the section.
 *
 * The corridor exists so the row's verdict is reached by rule 3 (a breach the
 * filesystem explains): the ceiling must sit ABOVE the CPU this section burns,
 * or rule 2 fires first and returns a hard FAIL, and BELOW its injected wall
 * clock, or rule 1 returns pass.
 *
 * WHAT THE PREVIOUS NUMBER WAS CALIBRATED AGAINST, AND WHY THAT WAS THE WRONG
 * TERM. It was 12 ms, defended as covering "every cpu p95 either of us has
 * drawn" — 2.15 ms idle, 9.19 ms under 20 spinners and 5 fsync workers. Those
 * are draws of the SECTION. The term that actually threatens rule 2 is the one
 * this file's own `deliveredFraction` docblock records: process-wide GC and JIT
 * landing inside a 0.13 ms section, measured at 9 samples in 250, UP TO 11.7
 * MS. A 12 ms ceiling is 1.03x that, i.e. no margin at all against the term
 * most likely to breach it, and the 9.19 ms "worst loaded draw" is that same
 * signature rather than an independent one. Re-measured here on the patched
 * section (10 cores, Node 26, 60 samples per run, 8 idle + 6 loaded runs): a
 * single sample of 12.28 ms CPU appeared idle and one of 65.18 ms under load —
 * both ABOVE the old ceiling.
 *
 * So the ceiling is calibrated against 11.7 ms, and the wall side is moved with
 * it (the wait doubles to 12 ms, three waits per 12-read sample, ~36 ms of
 * injected off-CPU waiting) so widening the corridor upward does not close it
 * from below. Margins, arithmetic rather than adjective, over 14 runs:
 *
 *   CPU side   24 ms against the 11.70 ms GC/JIT term            2.05x
 *              24 ms against the worst cpu p95 drawn (2.61)      9.19x
 *   wall side  the lowest wall p95 drawn (52.58 ms) over 24 ms   2.19x
 *
 * The rule reads p95 and not max deliberately, and that is what keeps a single
 * 12.28 ms or 65.18 ms GC sample out of the decision: at n=60 the p95 is
 * `sorted[Math.floor(60 × 0.95)]` = `sorted[57]`, so it takes 60 − 57 = THREE
 * samples at or above the ceiling to move it, and none of the 14 runs produced
 * more than one. (This said "four" for a round — off by one, in the reassuring
 * direction. The conclusion is unchanged and does not depend on the count: the
 * 11.7 ms GC/JIT class cannot breach a 24 ms ceiling however often it fires,
 * and events at or above 24 ms were drawn once in 840 samples.)
 */
export const SELF_CHECK_BUDGET_MS = 24;

/** The off-CPU wait injected into every fourth read of the starved section. */
export const SELF_CHECK_WAIT_MS = 12;

/** The prefix the CI report step greps for to prove the row MEASURED. */
export const SELF_CHECK_MEASUREMENT_MARKER = 'LIVE STARVED MEASUREMENT · ';

/**
 * The phrase every strict escalation carries, wherever it is raised.
 *
 * The report step needs it because the two states it has to tell apart leave
 * almost the same log. `settle` emits the INCONCLUSIVE verdict line BEFORE it
 * consults the switch, so that line is present whether the run then skipped
 * (switch off — the arrangement is broken) or threw (switch on — the runner
 * left the corridor). The step used to treat the diagnostic alone as proof of
 * the first, and therefore annotated every genuine strict failure with "the
 * switch did not engage" on a run that had just demonstrated it engaging. Both
 * are red; only one of them is a bug in the wiring, and a maintainer reading
 * the annotation has to be told which.
 *
 * ITS VALUE IS THE TEXT `settle` ALREADY THREW, and that is the fix for the
 * arrangement this replaces. There used to be two escalations — `settle`'s,
 * reached by no CI step, and a hand-rolled one in the self-check row, reached
 * by the only step that sets the switch — and this marker belonged to the
 * second. One escalation now raises every strict failure and composes this
 * constant into its message, so the phrase cannot be present without the
 * escalation having happened, and cannot be renamed away from the report step
 * that greps it (latency-budget-ci.test.ts asserts the workflow carries it).
 */
export const STRICT_FAILURE_MARKER = `INCONCLUSIVE under ${STRICT_ENV}=1`;

/**
 * Why the machine is outside the corridor, or '' when it is inside.
 *
 * Exported for the same reason `strictModeEngaged` is: the CI test can drive
 * both sides of this decision with recorded numbers, in-process, instead of
 * searching the row's source text for the shape of a branch.
 */
export function selfCheckCorridorMiss(stats: LatencyStats, budgetMs = SELF_CHECK_BUDGET_MS): string {
  if (stats.cpuP95 >= budgetMs) {
    return `this machine burned ${stats.cpuP95.toFixed(2)} ms of CPU on a section whose unpatched cost is a`
      + ' ~0.15 ms median, so rule 2 decides this measurement and the filesystem discount is never reached';
  }
  if (stats.wallP95 < budgetMs) {
    return `the injected waiting did not put this section over its ${budgetMs} ms budget, so there is no breach`
      + ' for the references to explain';
  }
  return '';
}

let spinSink = 0;

/** Pure arithmetic, no syscalls and no allocation: CPU time and nothing else. */
function spin(units: number): void {
  let x = 0;
  for (let i = 0; i < units; i += 1) x += Math.sqrt(i + 1);
  spinSink += x;
}

function cpuMs(usage: NodeJS.CpuUsage): number {
  return (usage.user + usage.system) / 1000;
}

/**
 * How many spin units cost `targetCpuMs` of CPU ON THIS MACHINE. Calibrated
 * against CPU time rather than wall clock on purpose: wall clock is the very
 * quantity contention corrupts, so calibrating on it would shrink the reference
 * workload exactly when the machine is busy and hide the starvation being
 * looked for.
 */
function calibrateSpinUnits(targetCpuMs: number): number {
  let units = 4_096;
  for (let doubling = 0; doubling < 24; doubling += 1) {
    const before = process.cpuUsage();
    spin(units);
    if (cpuMs(process.cpuUsage(before)) >= targetCpuMs) return units;
    units *= 2;
  }
  return units;
}

function quantile(sorted: readonly number[], q: number): number {
  // Deliberately the same index arithmetic the original assertion used, so the
  // statistic being reported is the statistic that was always being claimed:
  // at n=250 this is index 237, and up to 12 samples may exceed the budget
  // before the p95 does.
  return sorted[Math.floor(sorted.length * q)] ?? 0;
}

/**
 * The reference workload is sized to the measured section's own median CPU
 * cost so it experiences the same scheduling dynamics: a 0.3 ms probe usually
 * completes inside one quantum and under-reports starvation that a 25 ms
 * section feels in full. Capped so a section that is already slow cannot make
 * calibration dominate the run.
 */
const REFERENCE_TARGET_CAP_MS = 25;
const REFERENCE_BURSTS = 20;

interface Attempt {
  readonly wall: number[];
  readonly cpu: number[];
  readonly delivered: number;
  readonly ioDelivered: number;
  readonly elapsedMs: number;
}

/**
 * Sizing of the interleaved reference workload, shared by the sync and async
 * measurement loops so both experience the SAME starvation detector. Split out
 * of measureOnce for that reason and no other: two loops that sized their
 * reference differently would be two instruments wearing one name.
 */
function referenceUnitsFor(probeCpu: readonly number[]): number {
  const sorted = [...probeCpu].sort((a, b) => a - b);
  return calibrateSpinUnits(Math.min(quantile(sorted, 0.5) || 1, REFERENCE_TARGET_CAP_MS));
}

function burstIntervalFor(samples: number): number {
  return Math.max(1, Math.floor(samples / REFERENCE_BURSTS));
}

/**
 * Clamped at 1: Node's GC and JIT threads burn CPU concurrently with the
 * measured thread, so process-wide CPU time can exceed the section's wall
 * clock. That overshoot is real (measured: 9 of 250 samples, up to 11.7 ms)
 * and must not read as better-than-perfect delivery.
 */
function deliveredFraction(referenceCpu: number, referenceWall: number): number {
  return referenceWall > 0 ? Math.min(1, referenceCpu / referenceWall) : 1;
}

/**
 * Size of the file the filesystem reference reads. Small and page-cache
 * resident on purpose: the quantity being detected is time this process spent
 * WAITING on the filesystem while other processes hammered it, not the speed
 * of the underlying device.
 */
const IO_REFERENCE_BYTES = 4096;

/**
 * The second reference workload, and the reason this instrument stopped
 * reporting other people's test suites as regressions.
 *
 * The arithmetic reference above answers exactly one question — "was this
 * process descheduled?" — and `spin` was written to make it answer only that
 * (no syscalls, no allocation). So a section whose cost is a `readFileSync`
 * can be starved for its whole budget by a filesystem twenty other processes
 * are queueing on while the spin, which never touches the filesystem, reports
 * a perfectly healthy machine. That is not a corner case, it is the ordinary
 * state of this repo's own parallel suite.
 *
 * MEASURED (10-core macOS, a readFileSync-dominated section, against twelve
 * real test files running as peer processes — the shape `npm test` produces):
 *
 *   idle, 5 runs            cpu delivered 1.00      io delivered 1.00
 *   12 peer processes       cpu delivered 1.00 x6   io delivered 0.75-1.00
 *   24 peer processes       cpu delivered 1.00 x5   io delivered 0.27-1.00
 *
 * The CPU detector reported a perfect machine in eleven of sixteen loaded
 * runs. The filesystem detector saw the contention in both bands and still
 * reported 1.00, five times out of five, on an idle machine — which is the
 * property that matters, because a detector that reads low when nothing is
 * wrong mutes the budget instead of qualifying it.
 *
 * WHY READS AND NOT WRITES. A read+write reference was measured beside this
 * one and rejected: it reported 0.26-0.49 under the LIGHT 12-peer load and
 * 0.09-0.25 under the heavy one, i.e. it would push every measurement taken
 * next to any concurrency at all into INCONCLUSIVE. That is a mute wearing a
 * detector's clothes.
 *
 * KNOWN LIMITATION — the delivery figures are window-wide, the assertion is a
 * tail. Read this before treating a surprising verdict as a bug.
 *
 * Each `delivered()` is one scalar for the whole measurement: a ratio of sums
 * over the ~21 bursts REFERENCE_BURSTS spreads through the run, whatever the
 * sample count. The p95 it qualifies is a single sample near the top of that
 * run (the 13th-worst of 250), and NOTHING ties the bursts that were starved
 * to the samples that formed it. A section can be slow in a stretch of the
 * window where no burst happened to land, or be starved during a burst while
 * the samples around it were fine.
 *
 * Measured (a probe replicating burst() exactly but recording each burst
 * separately; readFileSync section, 24 peer processes, six runs):
 *
 *   per-burst MEDIAN delivery      cpu 1.00, io 1.00 — in all six runs
 *   worst single burst             cpu 0.01-1.00, io 0.02-0.25
 *   what this code reports         cpu 0.11-1.00, io 0.10-0.50
 *   the section's own wall         p95/p50 ratio 3.3-30.1x, max 2.1-14.7 ms
 *
 * So the typical burst sees a perfect machine and the aggregate does not,
 * because summing wall and CPU separately weights each burst by its own wall
 * clock and the starved bursts are precisely the long ones. That weighting is
 * why this is usable at all, and it also fixes the DIRECTION of the error: the
 * aggregate is pulled toward under-reporting delivery, and rule 1 of
 * classifyLatency returns `pass` on an under-budget wall clock before delivery
 * is consulted at all. An inaccurate figure can therefore
 * only turn a fail into an INCONCLUSIVE — it can never manufacture a red, and
 * it can never turn a breach into a pass. The exposure is under-enforcement in
 * a window where one unlucky burst was starved, not a false accusation.
 *
 * NEXT REFINEMENT, if that under-enforcement ever bites: tail-matched delivery.
 * Keep the per-burst deliveries instead of the running sums, attribute each
 * sample to the burst nearest it in time, and discount the p95 by the delivery
 * of the bursts bracketing the samples that actually formed it. The probe above
 * already collects the per-burst series; what is missing is the attribution and
 * a decision on how few bursts is too few to bracket a tail (21 per 250 samples
 * is roughly one burst per 12 samples, so the p95 sample is within ~6 samples
 * of a burst, which may well be close enough — measure before rebuilding).
 */
export interface Reference {
  /** Run one burst of both workloads, outside the caller's timed window. */
  burst(): void;
  delivered(): number;
  ioDelivered(): number;
  dispose(): void;
}

function calibrateIoReads(file: string, targetCpuMs: number): number {
  let reads = 8;
  for (let doubling = 0; doubling < 20; doubling += 1) {
    const before = process.cpuUsage();
    for (let i = 0; i < reads; i += 1) spinSink += fs.readFileSync(file).length;
    if (cpuMs(process.cpuUsage(before)) >= targetCpuMs) return reads;
    reads *= 2;
  }
  return reads;
}

/**
 * Both reference workloads behind one seam, sized once from the same probe.
 * The sync and async measurement loops share this for the reason they already
 * shared referenceUnitsFor: two loops whose starvation detectors disagreed
 * would be two instruments wearing one name.
 *
 * Exported for one reason: two references BURST ALTERNATELY inside a single
 * window is the only construction that can show the filesystem leg responding
 * to filesystem waiting while the arithmetic leg does not, without resting on
 * two separate windows having found the machine in the same state. The
 * A/B that did rest on that was this repo's one measured flake — see
 * latency-budget.test.ts.
 */
export function makeReference(probeCpu: readonly number[]): Reference {
  const units = referenceUnitsFor(probeCpu);
  const sorted = [...probeCpu].sort((a, b) => a - b);
  const target = Math.min(quantile(sorted, 0.5) || 1, REFERENCE_TARGET_CAP_MS);

  // os.tmpdir() rather than the project: this runs under the test runner, and
  // the section being measured is frequently a project-directory read whose
  // contention we would otherwise be adding to ourselves.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-latency-ref-'));
  const file = path.join(dir, 'reference.bin');
  fs.writeFileSync(file, Buffer.alloc(IO_REFERENCE_BYTES, 7));
  const reads = calibrateIoReads(file, target);

  let cpuWall = 0;
  let cpuBurned = 0;
  let ioWall = 0;
  let ioBurned = 0;
  return {
    burst(): void {
      let usage = process.cpuUsage();
      let started = performance.now();
      spin(units);
      cpuWall += performance.now() - started;
      cpuBurned += cpuMs(process.cpuUsage(usage));

      usage = process.cpuUsage();
      started = performance.now();
      for (let i = 0; i < reads; i += 1) spinSink += fs.readFileSync(file).length;
      ioWall += performance.now() - started;
      ioBurned += cpuMs(process.cpuUsage(usage));
    },
    delivered: () => deliveredFraction(cpuBurned, cpuWall),
    ioDelivered: () => deliveredFraction(ioBurned, ioWall),
    dispose: () => { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function measureOnce(run: () => void, samples: number, warmup: number): Attempt {
  for (let i = 0; i < warmup; i += 1) run();

  // Median CPU cost of the section, taken from a short pre-pass, so the
  // reference workload can be sized to match it.
  const probe: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const before = process.cpuUsage();
    run();
    probe.push(cpuMs(process.cpuUsage(before)));
  }
  const reference = makeReference(probe);
  const burstEvery = burstIntervalFor(samples);

  const wall: number[] = [];
  const cpu: number[] = [];
  const startedAt = performance.now();
  try {
    for (let sample = 0; sample < samples; sample += 1) {
      const cpuBefore = process.cpuUsage();
      const wallBefore = performance.now();
      run();
      wall.push(performance.now() - wallBefore);
      cpu.push(cpuMs(process.cpuUsage(cpuBefore)));

      if (sample % burstEvery === 0) reference.burst();
    }
    return {
      wall,
      cpu,
      delivered: reference.delivered(),
      ioDelivered: reference.ioDelivered(),
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    reference.dispose();
  }
}

/**
 * The same procedure for an `async` section, plus a per-sample `setup` that is
 * kept outside the timer.
 *
 * Kept as a separate loop rather than folded into measureOnce, deliberately:
 * `await` cannot be introduced into the synchronous loop above without adding
 * microtask turns to the ONE measurement in this repo that already has
 * standing (the 150 ms Write pre-tool budget), and a timing instrument that
 * changes the number it reports while its subject is unchanged is worthless.
 * Everything that decides an OUTCOME — reference sizing, burst interval,
 * delivery accounting, and classifyLatency itself — is shared, so the two
 * loops cannot drift into disagreeing verdicts.
 */
async function measureOnceAsync(
  run: () => Promise<unknown> | unknown,
  samples: number,
  warmup: number,
  setup?: () => Promise<unknown> | unknown,
): Promise<Attempt> {
  for (let i = 0; i < warmup; i += 1) {
    if (setup) await setup();
    await run();
  }

  const probe: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    if (setup) await setup();
    const before = process.cpuUsage();
    await run();
    probe.push(cpuMs(process.cpuUsage(before)));
  }
  const reference = makeReference(probe);
  const burstEvery = burstIntervalFor(samples);

  const wall: number[] = [];
  const cpu: number[] = [];
  const startedAt = performance.now();
  try {
    for (let sample = 0; sample < samples; sample += 1) {
      if (setup) await setup();
      const cpuBefore = process.cpuUsage();
      const wallBefore = performance.now();
      await run();
      wall.push(performance.now() - wallBefore);
      cpu.push(cpuMs(process.cpuUsage(cpuBefore)));

      if (sample % burstEvery === 0) reference.burst();
    }
    return {
      wall,
      cpu,
      delivered: reference.delivered(),
      ioDelivered: reference.ioDelivered(),
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    reference.dispose();
  }
}

export interface LatencySamples {
  /** Per-sample wall clock, milliseconds, unsorted. */
  readonly wall: readonly number[];
  /** Per-sample process CPU time (user+system), milliseconds, unsorted. */
  readonly cpu: readonly number[];
  /** Fraction of requested CPU the machine delivered to a reference workload. */
  readonly delivered: number;
  /**
   * The same fraction for the filesystem reference. OPTIONAL, and absent means
   * 1 — i.e. "the filesystem was not measured, so it cannot be blamed" — which
   * is what keeps every recording taken before this detector existed reading
   * exactly as it did. A live measurement always supplies it.
   */
  readonly ioDelivered?: number;
}

/**
 * The whole decision procedure, as a pure function of the numbers, so it can be
 * exercised against recorded distributions instead of only against a live
 * machine — see latency-budget.test.ts, which drives it with the real measured
 * shapes (idle, bursty, contended, CPU-regressed, block-regressed).
 */
export function classifyLatency(
  attempt: LatencySamples,
  budgetMs: number,
): { verdict: LatencyVerdict; reason: string } {
  const wall = [...attempt.wall].sort((a, b) => a - b);
  const cpu = [...attempt.cpu].sort((a, b) => a - b);
  const wallP95 = quantile(wall, 0.95);
  const cpuP95 = quantile(cpu, 0.95);
  // The machine gets ONE delivery figure, and it is the worse of the two
  // references. The discount below is an inflation BOUND, and a section is a
  // mix of CPU and syscalls in unknown proportion, so the only bound the data
  // supports is the one set by whichever resource the machine was worst at
  // handing over. Taking the CPU figure alone is what let a filesystem the
  // whole test suite was queueing on be reported as a code regression.
  const ioDelivered = attempt.ioDelivered ?? 1;
  const delivered = Math.min(attempt.delivered, ioDelivered);
  const starved = ioDelivered < attempt.delivered ? 'filesystem' : 'CPU';

  // 1. A contended measurement can only ever be an OVER-estimate, so an
  //    under-budget wall clock is sound whatever the machine was doing. This
  //    rule also guarantees the property that makes this change safe to adopt:
  //    every input the old two-valued assertion passed, this one still passes.
  //    Nothing below can manufacture a red where there was a green.
  if (wallP95 < budgetMs) {
    return { verdict: 'pass', reason: `wall p95 ${wallP95.toFixed(2)} ms is within the ${budgetMs} ms budget` };
  }

  // 2. CPU time is what the process BURNED, not what it waited for, so no
  //    amount of contention can inflate it into the budget. A path that spends
  //    the budget in CPU alone is over budget on an empty machine too. This is
  //    the anti-mute rule: a regression that does more work can never hide
  //    behind "the machine was busy".
  if (cpuP95 >= budgetMs) {
    return {
      verdict: 'fail',
      reason: `CPU alone is over budget: cpu p95 ${cpuP95.toFixed(2)} ms >= ${budgetMs} ms `
        + `(wall p95 ${wallP95.toFixed(2)} ms). Contention cannot explain burned CPU.`,
    };
  }

  // 3. The breach is in off-CPU time. That is either the machine starving this
  //    process or the path itself having started to block — indistinguishable
  //    from the timings alone, which is why reference workloads were run in the
  //    same window. Neither of them can block on anything the measured section
  //    is not also exposed to, so time they were denied is starvation and
  //    nothing else.
  //
  //    The delivery test is necessary but NOT sufficient, and this rule used to
  //    stop at it. `delivered` bounds the inflation at 1/d — so the figure this
  //    rule can stand behind is the DISCOUNTED wall clock, and a breach smaller
  //    than that factor is inside the instrument's own error bar. Measured, on
  //    the input that forced this: tests/hook-timing's claude session-start row
  //    reads 45.31 ms p95 at 100% delivery alone and 152.40 ms at 91% delivery
  //    inside the 291-file parallel suite, against a 150 ms budget. The old form
  //    called that second reading a REGRESSION at 1.02x over budget while its
  //    own sentence said the machine could have inflated it by 1.10x. Rule 2
  //    already catches the case this discount could otherwise mute: a path that
  //    burns the budget in CPU never reaches here.
  //
  //    `delivered` is now the worse of the two references, so "off-CPU" here
  //    means off BOTH: neither descheduled nor queued behind somebody else's
  //    filesystem traffic. The reading that forced the second reference:
  //    session-updates-surface's 15 ms marker-write budget measured wall p95
  //    22.86 ms at 81% CPU delivery — over the floor, so a FAIL — while burning
  //    3 ms of CPU on a path whose idle p95 is 0.54 ms. A 40x inflation with no
  //    code change is a busy filesystem, and the arithmetic reference could not
  //    see one.
  if (delivered >= DELIVERY_FLOOR && wallP95 * delivered >= budgetMs) {
    return {
      verdict: 'fail',
      reason: `wall p95 ${wallP95.toFixed(2)} ms >= ${budgetMs} ms on a machine that delivered `
        + `${(attempt.delivered * 100).toFixed(0)}% of requested CPU and `
        + `${(ioDelivered * 100).toFixed(0)}% of requested filesystem throughput `
        + `(both >= ${(DELIVERY_FLOOR * 100).toFixed(0)}%), `
        + `so it could inflate this by at most ${(1 / delivered).toFixed(2)}x — `
        + `${(wallP95 * delivered).toFixed(2)} ms even after that discount. The breach is not contention.`,
    };
  }

  return {
    verdict: 'inconclusive',
    reason: `wall p95 ${wallP95.toFixed(2)} ms >= ${budgetMs} ms, but the machine delivered only `
      + `${(delivered * 100).toFixed(0)}% of the ${starved} a reference workload asked for `
      + `(cpu ${(attempt.delivered * 100).toFixed(0)}%, filesystem ${(ioDelivered * 100).toFixed(0)}%) `
      + `and the path burned just ${cpuP95.toFixed(2)} ms of CPU. `
      + 'Both a passing and a failing truth are consistent with this data.',
  };
}

function statsFrom(attempt: Attempt, samples: number, attempts: number, elapsedMs: number): LatencyStats {
  const wall = [...attempt.wall].sort((a, b) => a - b);
  const cpu = [...attempt.cpu].sort((a, b) => a - b);
  return {
    n: samples,
    wallP50: quantile(wall, 0.5),
    wallP95: quantile(wall, 0.95),
    wallMax: wall[wall.length - 1] ?? 0,
    cpuP50: quantile(cpu, 0.5),
    cpuP95: quantile(cpu, 0.95),
    cpuMax: cpu[cpu.length - 1] ?? 0,
    delivered: attempt.delivered,
    ioDelivered: attempt.ioDelivered,
    attempts,
    elapsedMs,
  };
}

export function measureLatencyBudget(options: LatencyBudgetOptions): LatencyOutcome {
  const samples = options.samples ?? 250;
  const warmup = options.warmup ?? 20;

  let attempt = measureOnce(options.run, samples, warmup);
  let decision = classifyLatency(attempt, options.budgetMs);
  let attempts = 1;
  let elapsedMs = attempt.elapsedMs;
  if (decision.verdict === 'inconclusive' && attempt.elapsedMs < RETRY_IF_ATTEMPT_UNDER_MS) {
    attempt = measureOnce(options.run, samples, warmup);
    decision = classifyLatency(attempt, options.budgetMs);
    attempts = 2;
    elapsedMs += attempt.elapsedMs;
  }

  return { verdict: decision.verdict, reason: decision.reason, stats: statsFrom(attempt, samples, attempts, elapsedMs) };
}

export async function measureLatencyBudgetAsync(options: LatencyBudgetAsyncOptions): Promise<LatencyOutcome> {
  const samples = options.samples ?? 250;
  const warmup = options.warmup ?? 20;

  let attempt = await measureOnceAsync(options.run, samples, warmup, options.setup);
  let decision = classifyLatency(attempt, options.budgetMs);
  let attempts = 1;
  let elapsedMs = attempt.elapsedMs;
  if (decision.verdict === 'inconclusive' && attempt.elapsedMs < RETRY_IF_ATTEMPT_UNDER_MS) {
    attempt = await measureOnceAsync(options.run, samples, warmup, options.setup);
    decision = classifyLatency(attempt, options.budgetMs);
    attempts = 2;
    elapsedMs += attempt.elapsedMs;
  }

  return { verdict: decision.verdict, reason: decision.reason, stats: statsFrom(attempt, samples, attempts, elapsedMs) };
}

/**
 * One line of measured numbers, in a fixed column order, for a report table.
 *
 * Exported because a measurement whose numbers are never printed is a
 * measurement nobody can audit: a budget test that prints only a green tick
 * cannot distinguish "3 ms against 150" from "149 ms against 150", and those
 * are opposite states of the same claim.
 */
export function latencyStatsLine(label: string, stats: LatencyStats): string {
  return [
    label.padEnd(38),
    `n=${String(stats.n).padStart(4)}`,
    `wall p50/p95/max ${stats.wallP50.toFixed(2)}/${stats.wallP95.toFixed(2)}/${stats.wallMax.toFixed(2)} ms`,
    `cpu p95 ${stats.cpuP95.toFixed(2)} ms`,
    `delivered cpu ${(stats.delivered * 100).toFixed(0)}% / fs ${(stats.ioDelivered * 100).toFixed(0)}%`,
  ].join('  ');
}

/**
 * The single verdict line four CI report steps grep for, rendered in one place.
 *
 * Exported, and used by `settle` below rather than duplicated there, because
 * the coupling is the point. The `LATENCY BUDGET PASS ·` / `LATENCY BUDGET
 * INCONCLUSIVE ·` prefix is what
 * .github/workflows/generate-check.yml keys on, and it used to be assembled at
 * the call site while the test that claims to hold CI to it re-typed the prefix
 * by hand. Changing the prefix therefore broke nothing locally and would have
 * reddened every report step on the next push. With one renderer, the fixture
 * in latency-budget-ci.test.ts is built from the same function the instrument
 * prints from, so a prefix or column change is red HERE first.
 *
 * A FAIL has no line: it throws, and the exception is the report.
 */
export function latencyVerdictLine(label: string, budgetMs: number, outcome: LatencyOutcome): string {
  if (outcome.verdict === 'inconclusive') {
    return `LATENCY BUDGET INCONCLUSIVE · ${label} · ${outcome.reason}`;
  }
  return `LATENCY BUDGET PASS · ${latencyStatsLine(label, outcome.stats)}  budget ${budgetMs.toFixed(2)} ms`;
}

function banner(label: string, budgetMs: number, outcome: LatencyOutcome): string {
  const s = outcome.stats;
  const rule = '='.repeat(78);
  return [
    '',
    rule,
    `TRAFFIC ONE · LATENCY BUDGET INCONCLUSIVE · ${label}`,
    rule,
    `  budget              ${budgetMs.toFixed(2)} ms  (p95, wall clock, n=${s.n}, attempts=${s.attempts})`,
    `  wall p50/p95/max    ${s.wallP50.toFixed(2)} / ${s.wallP95.toFixed(2)} / ${s.wallMax.toFixed(2)} ms`,
    `  cpu  p50/p95/max    ${s.cpuP50.toFixed(2)} / ${s.cpuP95.toFixed(2)} / ${s.cpuMax.toFixed(2)} ms   <- contention cannot inflate this`,
    `  CPU delivered       ${(s.delivered * 100).toFixed(0)}% of a fixed arithmetic reference workload's request`,
    `  filesystem deliv.   ${(s.ioDelivered * 100).toFixed(0)}% of a fixed read reference workload's request`,
    '',
    `  ${outcome.reason}`,
    '',
    '  THE BUDGET WAS NOT CHECKED ON THIS RUN. This is not a pass. Re-run on an',
    `  idle machine for a verdict, or set ${STRICT_ENV}=1 to make`,
    '  an unanswerable measurement RED instead of skipped.',
    rule,
    '',
  ].join('\n');
}

/**
 * Measure `options.run` and hold it to `options.budgetMs` at p95, three-valued.
 *
 * PASS and FAIL behave exactly as an ordinary assertion. INCONCLUSIVE marks the
 * test SKIPPED — node:test has no third state, and a skip is the only encoding
 * that is neither a green tick nor a red cross. A bare skip is how a budget
 * quietly stops being enforced, so it never travels alone: the reason string is
 * printed inline by every node:test reporter, the run's `skipped` count moves
 * off zero, and an unmissable block goes to stderr with the numbers that
 * produced it. `T1_LATENCY_BUDGET_STRICT=1` converts it to a hard failure, the
 * same way `test:env --strict` refuses a release verdict on an inconclusive row.
 * The `T1_` prefix is not cosmetic and this doc said `TRAFFIC_ONE_` for a while:
 * src/build/test-preload.mjs wipes the whole `TRAFFIC_ONE_` namespace bar three
 * allowlisted names, so a switch spelled that way is erased before any test
 * reads it and silently does nothing. Any future test-visible switch has the
 * same trap.
 *
 * EXPORTED, and only so it can be EXECUTED. The strict branch below is the
 * escalation every "an inconclusive row is still a hard failure under the
 * switch" sentence in this repo rests on, and it is now the ONLY one: the CI
 * step that sets the switch runs latency-budget.test.ts, whose self-check row
 * reaches this branch through `settleSelfCheck` below. It used to hand-roll a
 * second escalation of its own, which meant the branch CI executed and the
 * branch the tests drove were different branches — a mutation disabling the
 * reachable one survived both suites with the switch set, guarded by nothing
 * but a substring search for its shape in the row's own source. One escalation
 * is what makes driving this function evidence about production. Driving
 * `assertLatencyBudget` instead would mean taking a real measurement to reach
 * one line; this seam takes a recorded outcome.
 *
 * THE VERDICT LINE IS EMITTED BEFORE THE SWITCH IS READ, deliberately: it
 * carries the numbers, and the report step in generate-check.yml reads it on
 * both sides of the switch to tell "this runner left the corridor" (the marker
 * is there too) from "the escalation did not happen" (it is not). Throwing
 * first would leave the engaging run with no verdict line at all, i.e. with the
 * arm of that step that names the machine unreachable.
 */
export function settle(t: TestContext, label: string, budgetMs: number, outcome: LatencyOutcome): LatencyOutcome {
  if (outcome.verdict === 'fail') {
    throw new Error(`${label}: ${outcome.reason}`);
  }
  if (outcome.verdict === 'inconclusive') {
    t.diagnostic(latencyVerdictLine(label, budgetMs, outcome));
    if (strictModeEngaged()) {
      throw new Error(`${label}: ${STRICT_FAILURE_MARKER} — ${outcome.reason}`);
    }
    process.stderr.write(banner(label, budgetMs, outcome));
    t.skip(`INCONCLUSIVE (budget NOT checked) · ${label} · ${outcome.reason}`);
    return outcome;
  }
  // A PASS carries its numbers too. A green tick alone cannot tell a budget
  // with 20x of headroom apart from one that cleared by a millisecond, and the
  // second is a budget about to start flaking with no warning anywhere in the
  // log. Every node:test reporter prints diagnostics inline.
  t.diagnostic(latencyVerdictLine(label, budgetMs, outcome));
  return outcome;
}

export function assertLatencyBudget(t: TestContext, options: LatencyBudgetOptions): LatencyOutcome {
  return settle(t, options.label, options.budgetMs, measureLatencyBudget(options));
}

/**
 * The self-check row's corridor exit, settled the way every other unanswerable
 * measurement in this repo is. Returns true when the machine left the corridor
 * and the caller has nothing left to assert.
 *
 * HERE RATHER THAN IN THE ROW, and that placement is the whole point. The row
 * used to hold this decision itself — `if (strictModeEngaged()) assert.fail(…)`
 * beside a `t.skip(…)` — which put the escalation CI actually reaches inside a
 * test file that cannot be imported without registering ten seconds of live
 * measurement. So it was never executed by anything: instrumented across both
 * suites with the switch set, that branch was entered ZERO times, and replacing
 * its condition with `strictModeEngaged() && false` left 111/111 and 16/16
 * green. Its only guard was a regex over the row's source text, which is the
 * construction this instrument's own docblocks denounce, applied to the one
 * branch production depends on.
 *
 * With the decision here it is an ordinary seam: latency-budget-ci.test.ts
 * drives all three corridor outcomes against both switch states with recorded
 * statistics, in-process, in milliseconds. What is left in the row is the CALL,
 * and a call is the one thing a source-text check can honestly assert — the
 * body it names is executed elsewhere.
 */
export function settleSelfCheck(t: TestContext, outcome: LatencyOutcome, numbers: string): boolean {
  const outside = selfCheckCorridorMiss(outcome.stats);
  if (!outside) return false;
  // A MISS IS THREE-VALUED, not red, and that is this instrument's contract
  // applied to itself: leaving the corridor is the statement "this machine
  // cannot host this measurement", which is what `classifyLatency` returns
  // INCONCLUSIVE for. On the serial runner the strict switch turns it into the
  // hard failure it should be there, and `settle` is what does that.
  settle(t, `${SELF_CHECK_LABEL} · corridor not reachable`, SELF_CHECK_BUDGET_MS, {
    verdict: 'inconclusive',
    reason: `${outside} — ${numbers}`,
    stats: outcome.stats,
  });
  return true;
}

/** The async twin of assertLatencyBudget — same three-valued contract. */
export async function assertLatencyBudgetAsync(
  t: TestContext,
  options: LatencyBudgetAsyncOptions,
): Promise<LatencyOutcome> {
  return settle(t, options.label, options.budgetMs, await measureLatencyBudgetAsync(options));
}
