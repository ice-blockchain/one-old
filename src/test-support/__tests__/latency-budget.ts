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
 */
const STRICT_ENV = 'T1_LATENCY_BUDGET_STRICT';

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
  const units = referenceUnitsFor(probe);
  const burstEvery = burstIntervalFor(samples);

  const wall: number[] = [];
  const cpu: number[] = [];
  let referenceWall = 0;
  let referenceCpu = 0;
  const startedAt = performance.now();
  for (let sample = 0; sample < samples; sample += 1) {
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    run();
    wall.push(performance.now() - wallBefore);
    cpu.push(cpuMs(process.cpuUsage(cpuBefore)));

    if (sample % burstEvery === 0) {
      const refCpuBefore = process.cpuUsage();
      const refWallBefore = performance.now();
      spin(units);
      referenceWall += performance.now() - refWallBefore;
      referenceCpu += cpuMs(process.cpuUsage(refCpuBefore));
    }
  }
  return {
    wall,
    cpu,
    delivered: deliveredFraction(referenceCpu, referenceWall),
    elapsedMs: performance.now() - startedAt,
  };
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
  const units = referenceUnitsFor(probe);
  const burstEvery = burstIntervalFor(samples);

  const wall: number[] = [];
  const cpu: number[] = [];
  let referenceWall = 0;
  let referenceCpu = 0;
  const startedAt = performance.now();
  for (let sample = 0; sample < samples; sample += 1) {
    if (setup) await setup();
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    await run();
    wall.push(performance.now() - wallBefore);
    cpu.push(cpuMs(process.cpuUsage(cpuBefore)));

    if (sample % burstEvery === 0) {
      const refCpuBefore = process.cpuUsage();
      const refWallBefore = performance.now();
      spin(units);
      referenceWall += performance.now() - refWallBefore;
      referenceCpu += cpuMs(process.cpuUsage(refCpuBefore));
    }
  }
  return {
    wall,
    cpu,
    delivered: deliveredFraction(referenceCpu, referenceWall),
    elapsedMs: performance.now() - startedAt,
  };
}

export interface LatencySamples {
  /** Per-sample wall clock, milliseconds, unsorted. */
  readonly wall: readonly number[];
  /** Per-sample process CPU time (user+system), milliseconds, unsorted. */
  readonly cpu: readonly number[];
  /** Fraction of requested CPU the machine delivered to a reference workload. */
  readonly delivered: number;
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
  //    from the timings alone, which is why a reference workload was run in the
  //    same window. It did no I/O, so any CPU it was denied is starvation and
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
  if (attempt.delivered >= DELIVERY_FLOOR && wallP95 * attempt.delivered >= budgetMs) {
    return {
      verdict: 'fail',
      reason: `wall p95 ${wallP95.toFixed(2)} ms >= ${budgetMs} ms on a machine that delivered `
        + `${(attempt.delivered * 100).toFixed(0)}% of requested CPU (>= ${(DELIVERY_FLOOR * 100).toFixed(0)}%), `
        + `so it could inflate this by at most ${(1 / attempt.delivered).toFixed(2)}x — `
        + `${(wallP95 * attempt.delivered).toFixed(2)} ms even after that discount. The breach is not contention.`,
    };
  }

  return {
    verdict: 'inconclusive',
    reason: `wall p95 ${wallP95.toFixed(2)} ms >= ${budgetMs} ms, but the machine delivered only `
      + `${(attempt.delivered * 100).toFixed(0)}% of requested CPU and the path burned just `
      + `${cpuP95.toFixed(2)} ms of it. Both a passing and a failing truth are consistent with this data.`,
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
    `delivered ${(stats.delivered * 100).toFixed(0)}%`,
  ].join('  ');
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
    `  CPU delivered       ${(s.delivered * 100).toFixed(0)}% of a fixed reference workload's request`,
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
 */
function settle(t: TestContext, label: string, budgetMs: number, outcome: LatencyOutcome): LatencyOutcome {
  if (outcome.verdict === 'fail') {
    throw new Error(`${label}: ${outcome.reason}`);
  }
  if (outcome.verdict === 'inconclusive') {
    const text = banner(label, budgetMs, outcome);
    if (process.env[STRICT_ENV] === '1') {
      throw new Error(`${label}: INCONCLUSIVE under ${STRICT_ENV}=1 — ${outcome.reason}`);
    }
    process.stderr.write(text);
    t.diagnostic(`LATENCY BUDGET INCONCLUSIVE · ${label} · ${outcome.reason}`);
    t.skip(`INCONCLUSIVE (budget NOT checked) · ${label} · ${outcome.reason}`);
    return outcome;
  }
  // A PASS carries its numbers too. A green tick alone cannot tell a budget
  // with 20x of headroom apart from one that cleared by a millisecond, and the
  // second is a budget about to start flaking with no warning anywhere in the
  // log. Every node:test reporter prints diagnostics inline.
  t.diagnostic(`LATENCY BUDGET PASS · ${latencyStatsLine(label, outcome.stats)}  budget ${budgetMs.toFixed(2)} ms`);
  return outcome;
}

export function assertLatencyBudget(t: TestContext, options: LatencyBudgetOptions): LatencyOutcome {
  return settle(t, options.label, options.budgetMs, measureLatencyBudget(options));
}

/** The async twin of assertLatencyBudget — same three-valued contract. */
export async function assertLatencyBudgetAsync(
  t: TestContext,
  options: LatencyBudgetAsyncOptions,
): Promise<LatencyOutcome> {
  return settle(t, options.label, options.budgetMs, await measureLatencyBudgetAsync(options));
}
