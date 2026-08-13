import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyLatency,
  latencyStatsLine,
  makeReference,
  measureLatencyBudget,
  settleSelfCheck,
  SELF_CHECK_BUDGET_MS,
  SELF_CHECK_LABEL,
  SELF_CHECK_MEASUREMENT_MARKER,
  SELF_CHECK_WAIT_MS,
  type LatencySamples,
} from './latency-budget';
import { trackedTempDirs } from './temp-dirs';

// Every distribution below is a RECORDING, not an invention: each was measured
// on this repo's own 150 ms Write pre-tool budget (n=250) on 2026-08-06, and
// the run that produced it is named in each case. Keeping them here is what
// makes the three-valued rules testable in milliseconds instead of only by
// re-inducing machine load for two minutes.
const BUDGET = 150;

/** n samples whose sorted p95 (index floor(0.95n)) and p50 are the given values. */
function shape(p50: number, p95: number, max: number, n = 250): number[] {
  const out: number[] = [];
  const p95Index = Math.floor(n * 0.95);
  for (let i = 0; i < n; i += 1) {
    if (i < n / 2) out.push(p50 * 0.9);
    else if (i < p95Index) out.push(p50);
    else if (i === p95Index) out.push(p95);
    else out.push(max);
  }
  return out;
}

function samples(wall: number[], cpu: number[], delivered: number, ioDelivered?: number): LatencySamples {
  return { wall, cpu, delivered, ioDelivered };
}

test('an idle-machine measurement inside the budget passes', () => {
  // Measured: 8 isolated idle runs, p95 27.63-31.56 ms, median 21.92-26.06 ms.
  const r = classifyLatency(samples(shape(23.4, 28.82, 44.73), shape(23.0, 28.0, 40.0), 0.98), BUDGET);
  assert.equal(r.verdict, 'pass', r.reason);
});

// The shape that started this: p95 jumped to 50.01 while the median held at
// 25.09 and one sample hit 196.72 — over budget, on an IDLE machine. With
// n=250 the p95 is index 237, so up to 12 samples may exceed before the
// assertion moves. A single spike is not a budget breach and must not read as
// one, in either direction.
test('a lone over-budget outlier on an otherwise clean run still passes', () => {
  const wall = shape(25.09, 50.01, 196.72);
  assert.ok(wall.some((v) => v > BUDGET), 'the recording must contain an over-budget sample');
  const r = classifyLatency(samples(wall, shape(24.5, 30.0, 40.0), 0.97), BUDGET);
  assert.equal(r.verdict, 'pass', r.reason);
});

test('contention that breaches the budget is inconclusive, not a failure', () => {
  // Measured under 24 induced spinners on 10 cores: wall p95 270.50 ms while
  // cpu p95 stayed at 33.35 ms. This is the flake, and it is now not a red.
  const r = classifyLatency(samples(shape(114.82, 270.5, 417.91), shape(27.71, 33.35, 43.34), 0.23), BUDGET);
  assert.equal(r.verdict, 'inconclusive', r.reason);
});

test('the 47.9 s observation is inconclusive rather than a four-order-of-magnitude failure', () => {
  const r = classifyLatency(samples(shape(20_000, 47_900, 60_000), shape(28, 33, 45), 0.01), BUDGET);
  assert.equal(r.verdict, 'inconclusive', r.reason);
});

// ── the two anti-mute rules ─────────────────────────────────────────────────
// Delete either one and a real regression becomes a silent skip. These are the
// tests that make this instrument a gate rather than a mute.

test('a CPU regression fails even though the wall clock alone cannot prove it', () => {
  // Measured with a fixed-work +150 ms CPU burn injected into planWriteGate:
  // wall p95 187.63, cpu p95 173.72, on a quiet machine.
  const r = classifyLatency(samples(shape(165.66, 187.63, 419.53), shape(164.72, 173.72, 182.62), 0.95), BUDGET);
  assert.equal(r.verdict, 'fail', r.reason);
  assert.match(r.reason, /CPU alone is over budget/);
});

test('a CPU regression is NOT muted when the machine is also contended', () => {
  // Measured with the same injected regression under 12 induced spinners:
  // wall p95 683.58 ms (pure noise), cpu p95 194.19 ms (the truth).
  // Delivery is deep in contention territory, so only the CPU floor can save
  // this verdict — and it must.
  const r = classifyLatency(samples(shape(300, 683.58, 1200), shape(180, 194.19, 240), 0.28), BUDGET);
  assert.equal(r.verdict, 'fail', r.reason);
  assert.match(r.reason, /Contention cannot explain burned CPU/);
});

test('a purely blocking regression fails on a machine proven to be quiet', () => {
  // Measured with 45 fsync'd 4 KB writes injected into planWriteGate: wall p95
  // 251.70 ms, but the CPU floor stays ~33 ms, so this regression looks exactly
  // like contention until the reference workload reports 95% CPU delivery.
  const r = classifyLatency(samples(shape(120, 251.7, 400), shape(30, 33, 45), 0.95), BUDGET);
  assert.equal(r.verdict, 'fail', r.reason);
  assert.match(r.reason, /not contention/);
});

test('the same blocking distribution IS inconclusive once the machine stops delivering CPU', () => {
  // Identical timings, only the reference workload's answer differs. This is
  // the honest limit of the instrument, pinned deliberately: from inside one
  // process, blocking I/O and scheduler starvation are the same observation,
  // and the reference workload is the only thing that separates them.
  const r = classifyLatency(samples(shape(120, 251.7, 400), shape(30, 33, 45), 0.25), BUDGET);
  assert.equal(r.verdict, 'inconclusive', r.reason);
});

test('a breach smaller than the delivery discount is inconclusive, not a regression', () => {
  // Recorded from tests/hook-timing's claude session-start row on 2026-08-08:
  // 45.31 ms p95 at 100% delivery running alone, and 152.40 ms p95 at 91%
  // delivery inside the 291-file `npm test` suite. The second reading is 1.02x
  // over budget on a machine the instrument itself says could have inflated it
  // by 1.10x, so calling it a regression is a claim the data does not support —
  // 152.40 x 0.91 = 138.68 ms, still inside the budget.
  const r = classifyLatency(samples(shape(120, 152.4, 190), shape(36, 40, 55), 0.91), BUDGET);
  assert.equal(r.verdict, 'inconclusive', r.reason);

  // The discount is a discount, not an amnesty: the same delivery with a breach
  // bigger than 1/d is still a failure, and so is a quiet machine at the same
  // wall clock. Without both of these the rule above would read as "anything
  // under 91% of the budget-crossing point is fine".
  assert.equal(classifyLatency(samples(shape(150, 200, 260), shape(36, 40, 55), 0.91), BUDGET).verdict, 'fail');
  assert.equal(classifyLatency(samples(shape(120, 152.4, 190), shape(36, 40, 55), 1), BUDGET).verdict, 'fail');
});

test('an under-budget wall clock passes however starved the machine was', () => {
  // The one-way soundness that makes this safe to adopt: contention can only
  // ever inflate, so nothing the classifier does can turn a green into a red.
  const r = classifyLatency(samples(shape(60, 90, 149), shape(20, 25, 30), 0.02), BUDGET);
  assert.equal(r.verdict, 'pass', r.reason);
});

// ── the filesystem reference ────────────────────────────────────────────────
// The arithmetic reference answers "was this process descheduled?" and nothing
// else, by construction (`spin` does no syscalls). A section whose cost is a
// readFileSync can therefore be held up for its entire budget by a filesystem
// twenty peer processes are queueing on, while the detector reports a perfectly
// healthy machine and the breach is billed to the code. These rows are that
// case and the two ways closing it could have gone wrong.

const IO_BUDGET = 15;

test('a breach the machine caused through the FILESYSTEM is not billed to the code', () => {
  // Measured against src/modules/session/__tests__/session-updates-surface.ts's
  // 15 ms marker-write budget, which reads wall p95 0.54-0.82 ms running alone.
  // Beside twelve real test files it read 10.69 ms at cpu delivery 84% and
  // filesystem delivery 77%, and the reported breach that forced this work was
  // the same band one draw worse: 22.86 ms p95 at 81% CPU delivery, on a path
  // that burned 2.5 ms of CPU. A 40x inflation with no code change is a busy
  // filesystem, and only one of the two references can see one.
  const wall = shape(12, 22.86, 31);
  const cpu = shape(2.3, 2.5, 4.1);
  assert.equal(classifyLatency(samples(wall, cpu, 0.81, 0.77), IO_BUDGET).verdict, 'inconclusive');

  // A/B on the SAME timings, and the whole point of the change: the reading is
  // a REGRESSION to a classifier that only asks about CPU. Without this row the
  // one above could pass because 22.86 x 0.77 happens to land somewhere
  // convenient rather than because the filesystem was consulted at all.
  const cpuOnly = classifyLatency(samples(wall, cpu, 0.81), IO_BUDGET);
  assert.equal(cpuOnly.verdict, 'fail', cpuOnly.reason);
  assert.match(cpuOnly.reason, /The breach is not contention/);
});

test('a filesystem the machine IS delivering cannot excuse a blocking regression', () => {
  // Measured through the live instrument:
  // 45 fsync'd 4 KB writes injected into a readFileSync-shaped section, on a
  // quiet machine, three runs — wall p95 268.99/290.43/346.93 ms, cpu p95
  // ~12 ms, cpu delivery 98-100% and FILESYSTEM delivery 100% every time.
  //
  // That last figure is the one that decides whether the second reference is a
  // detector or a mute: the regression's own fsyncs do not depress it, because
  // the reference reads a page-cache-resident file it wrote itself and is
  // measuring the machine, not the section. Take this row away and any
  // regression that blocks could plead contention it caused.
  const r = classifyLatency(samples(shape(120, 290.43, 400), shape(11, 12, 14), 0.98, 1), IO_BUDGET);
  assert.equal(r.verdict, 'fail', r.reason);
  assert.match(r.reason, /100% of requested filesystem throughput/);
});

test('a CPU regression is not muted by a busy filesystem either', () => {
  // Rule 2 runs before any discount, so the anti-mute floor is unmoved by the
  // second reference: burned CPU over the budget is a failure whatever either
  // reference says about the machine.
  const r = classifyLatency(samples(shape(300, 683, 1200), shape(18, 19.4, 24), 0.9, 0.05), IO_BUDGET);
  assert.equal(r.verdict, 'fail', r.reason);
  assert.match(r.reason, /Contention cannot explain burned CPU/);
});

test('a recording taken before the filesystem reference existed reads exactly as it did', () => {
  // Every distribution above this section omits `ioDelivered`, and they are
  // recordings of real runs that cannot be re-measured. Absent must therefore
  // mean "not measured, so not blamed" — 1, never 0 — or adding a detector
  // would silently reinterpret the archive.
  const wall = shape(120, 251.7, 400);
  const cpu = shape(30, 33, 45);
  assert.equal(
    classifyLatency(samples(wall, cpu, 0.95), 150).verdict,
    classifyLatency(samples(wall, cpu, 0.95, 1), 150).verdict,
  );
  assert.equal(classifyLatency(samples(wall, cpu, 0.95), 150).verdict, 'fail');
});

// ── the instrument, not the classifier ──────────────────────────────────────
// Everything above drives classifyLatency with hand-entered numbers, which
// covers the decision procedure completely and covers the INSTRUMENT not at
// all. Measured: replacing the whole filesystem reference with a constant 1 —
// deleting the second detector outright — broke no test in this repository.
// Every row above still passed, because every row above supplies its own
// `ioDelivered`. The rows here take that figure from the real measurement over
// a real filesystem-bound section instead.

const liveDirs = trackedTempDirs('t1-latency-live-');
after(() => { liveDirs.cleanup(); });

/**
 * `node:fs` through the CJS registry — the handle that reaches the `import * as
 * fs` namespace inside latency-budget.ts. Assigning to this file's own
 * namespace object does not (measured: silently dropped).
 */
const nodeFs = createRequire(__filename)('node:fs') as typeof fs;

/** A section whose cost is reads and nothing else, which is what the second reference is for. */
function readBoundSection(): () => void {
  const file = path.join(liveDirs.make(), 'payload.bin');
  fs.writeFileSync(file, Buffer.alloc(8192, 3));
  let sink = 0;
  return () => { for (let i = 0; i < 12; i += 1) sink += fs.readFileSync(file).length; void sink; };
}

/** Block without burning CPU — which is what waiting on a busy filesystem is. */
function waitOffCpu(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Sizing of the interleaved A/B, and every number here was moved by measurement
 * rather than taste — see the loaded distribution recorded below the test.
 *
 * Delivery is a ratio of SUMS weighted by each burst's own wall clock, so one
 * badly descheduled burst dominates the figure. At 20 rounds of 8 reads with a
 * wait on every sixth, the injected waiting was ~78 ms against a read cost that
 * grows under load (0.28 ms/read measured under 2x-core contention, against
 * 0.025 ms idle), so the injected share fell to ~55% and the claim went red on a
 * loaded machine with nothing wrong. A wait on EVERY eligible read makes the
 * injected share ~97% arithmetically, at any read cost a busy machine produces.
 */
const REFERENCE_ROUNDS = 30;
const REFERENCE_WAIT_MS = 6;

/**
 * Arm an off-CPU wait inside every `n`th `readFileSync`, and report how many
 * fired. `gate` decides whether a given call is eligible, which is what lets a
 * single patch starve one participant in a window and leave the other alone.
 */
function injectReadWaiting(
  options: { readonly everyNth: number; readonly waitMs: number; readonly gate: () => boolean },
): { reads: number; waits: number; restore(): void } {
  const original = nodeFs.readFileSync;
  const counters = {
    reads: 0,
    waits: 0,
    restore(): void {
      Object.defineProperty(nodeFs, 'readFileSync', { configurable: true, writable: true, value: original });
    },
  };
  Object.defineProperty(nodeFs, 'readFileSync', {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      if (options.gate()) {
        counters.reads += 1;
        if (counters.reads % options.everyNth === 0) {
          counters.waits += 1;
          waitOffCpu(options.waitMs);
        }
      }
      return (original as (...a: unknown[]) => unknown)(...args);
    },
  });
  return counters;
}

// THE FLAKE THIS SHAPE REPLACES, because a deleted flaky guard is worse than no
// guard at all and that is where the previous shape was heading (measured: one
// red in twenty runs under load).
//
// The causal claim — "injecting filesystem waiting is what moved the filesystem
// reference" — used to be `starved.ioDelivered < quiet.ioDelivered` over two
// `measureLatencyBudget` calls, with a comment reading "same section, same
// machine, one difference between the runs". There were TWO differences: the
// injection, and several seconds of whatever else the machine was doing. The
// injected run was never the problem; the QUIET baseline being starved by
// ambient contention below the injected run is, and it needs no unusual load to
// happen, only an unlucky ordering of somebody else's filesystem traffic.
//
// So the claim is made inside ONE window instead. Two references are built from
// the same probe and burst ALTERNATELY, with the injection gated on to exactly
// one of them: every ambient disturbance in the window is experienced by both,
// in interleaved slices, and the only asymmetry left is the one under test.
// Nothing here depends on the machine being idle, or on two moments in time
// resembling each other.
test('the filesystem reference responds to filesystem waiting and the arithmetic one does not — in ONE window', (t) => {
  // A probe standing in for a ~0.2 ms section, which is what readBoundSection
  // costs idle. It only sizes the reference workloads, and both get the same.
  const probe = [0.2, 0.2, 0.2, 0.2, 0.2];
  const control = makeReference(probe);
  const starved = makeReference(probe);

  let injecting = false;
  const injected = injectReadWaiting({ everyNth: 1, waitMs: REFERENCE_WAIT_MS, gate: () => injecting });
  try {
    for (let round = 0; round < REFERENCE_ROUNDS; round += 1) {
      control.burst();
      injecting = true;
      starved.burst();
      injecting = false;
    }
  } finally {
    injected.restore();
    control.dispose();
    starved.dispose();
  }

  const numbers = `control cpu ${control.delivered().toFixed(3)} / fs ${control.ioDelivered().toFixed(3)}; `
    + `starved cpu ${starved.delivered().toFixed(3)} / fs ${starved.ioDelivered().toFixed(3)}; `
    + `${injected.waits} waits injected across ${injected.reads} eligible reads`;

  // Printed on a PASS as well, for the same reason latency-budget.ts prints its
  // own numbers on a pass: a green tick cannot tell a comfortable margin from
  // one about to start flaking, and this row's whole history is the second.
  t.diagnostic(`ONE-WINDOW REFERENCE A/B · ${numbers}`);
  assert.ok(injected.waits > 0, `no wait was injected, so this row measured nothing — ${numbers}`);

  // 1. The causal claim, now with the two sides interleaved rather than
  //    sequential. Two claims rather than one, because they fail in opposite
  //    conditions: the ABSOLUTE bound is one-sided (ambient contention can only
  //    push the figure further down, so a busy machine strengthens it) and the
  //    RELATIVE one is what says the injection rather than the ambient state did
  //    it. RE-MEASURED — the figure that used to be here cited 110 runs in two
  //    campaigns and was not reproducible: 6 runs idle and 8 under 10 spinners
  //    plus 3 fsync workers, on 10 cores. Idle, the injected leg spanned
  //    0.007-0.019 against a control of 0.994-1.000. Loaded, the injected leg
  //    spanned 0.021-0.028 — steady, because the injection dominates it — while
  //    the CONTROL spanned 0.074-1.000, so the worst observed draw of the ratio
  //    was 0.291 against the 0.5 threshold and the absolute bound had 5.4x to
  //    spare. That 0.074 control draw is why the ratio is not tighter: ambient
  //    filesystem traffic depresses the control leg too, and a threshold that
  //    assumed a quiet control would be the same mistake in a new place.
  assert.ok(
    starved.ioDelivered() <= 0.15,
    `injecting a wait into every reference read did not depress the filesystem figure — ${numbers}`,
  );
  assert.ok(
    starved.ioDelivered() <= control.ioDelivered() * 0.5,
    `injecting filesystem waiting did not move the filesystem reference relative to the control burst`
    + ` interleaved with it — ${numbers}`,
  );

  // 2. And it moved that leg SPECIFICALLY, measured against the machine's own
  //    CPU witness FROM THE SAME WINDOW. The arithmetic reference makes no
  //    syscalls by construction, so an off-CPU wait inside readFileSync cannot
  //    reach it; if both legs moved together they would be one detector reported
  //    twice and the second one decoration.
  //
  //    Compared against the BETTER of the two arithmetic legs on purpose. A low
  //    arithmetic figure is not a defect in this test — it is that detector
  //    doing its job on a contended machine — so the claim has to be that the
  //    filesystem leg is far worse than anything the CPU side reported, not that
  //    the CPU side reported a quiet machine. Measured in the same 8 loaded runs
  //    as above, the better arithmetic leg ranged 0.571-1.000 while the injected
  //    filesystem leg sat at 0.021-0.028, so the worst draw of this claim had
  //    6.8x of room.
  const cpuWitness = Math.max(control.delivered(), starved.delivered());
  assert.ok(
    starved.ioDelivered() * 3 <= cpuWitness,
    `the filesystem leg is no worse than the CPU witness taken in the same window, so the injection was not`
    + ` filesystem-specific — ${numbers}`,
  );
});

/**
 * The label, the ceiling and the injected wait all come from the instrument.
 *
 * They used to be three literals here, and the CI test that checks the report
 * step's grep patterns had its own re-typed copies of them, because importing
 * this module from that one would register this row — ten seconds of live
 * measurement inside a structural test. Three copies of a string is three
 * places a rename can half-land, so the values moved into the instrument, where
 * all three files can import them and none imports a test row. `SELF_CHECK_BUDGET_MS`
 * carries the corridor's calibration and the arithmetic margins behind it — in
 * particular why 12 ms was the wrong ceiling and 24 ms is the right one.
 */
const LIVE_LABEL = SELF_CHECK_LABEL;
const LIVE_BUDGET_MS = SELF_CHECK_BUDGET_MS;

test('the live instrument reaches an INCONCLUSIVE verdict when the filesystem is starved', (t) => {
  const quiet = measureLatencyBudget({
    label: 'live filesystem reference (quiet)', budgetMs: LIVE_BUDGET_MS, run: readBoundSection(), samples: 60, warmup: 5,
  });
  t.diagnostic(`LIVE QUIET MEASUREMENT · ${latencyStatsLine('live filesystem reference (quiet)', quiet.stats)}`);
  // One-sided and ambient-proof: whatever the machine was doing, the figure has
  // to be a fraction. A detector that returns 0 or NaN on an unstarved run is a
  // mute, and this is the row that would catch one.
  assert.ok(
    Number.isFinite(quiet.stats.ioDelivered) && quiet.stats.ioDelivered > 0 && quiet.stats.ioDelivered <= 1,
    `the filesystem reference reported ${quiet.stats.ioDelivered}, which is not a delivered fraction`,
  );

  // Every fourth read waits off-CPU — ungated, so the section's reads and the
  // reference's reads both pay it, which is the honest shape of a busy
  // filesystem. The patch is armed after the quiet run so its calibration is
  // unaffected; calibration sizes on CPU, which an off-CPU wait does not move.
  // The wait doubled with the ceiling: raising the corridor's roof above the
  // GC/JIT term without raising its floor would have closed it from below.
  const section = readBoundSection();
  const injected = injectReadWaiting({ everyNth: 4, waitMs: SELF_CHECK_WAIT_MS, gate: () => true });
  let starved;
  try {
    starved = measureLatencyBudget({
      label: LIVE_LABEL,
      budgetMs: LIVE_BUDGET_MS,
      run: section,
      samples: 60,
      warmup: 5,
    });
  } finally {
    injected.restore();
  }

  const s = starved.stats;
  // Rendered by the instrument's OWN column renderer rather than by hand, for
  // the reason latencyVerdictLine is shared with the CI fixtures: the report
  // step beside this row's measurement step greps for these columns, and a
  // hand-rolled copy of them is a format that can drift away from the
  // instrument without a local red.
  const numbers = `${latencyStatsLine(LIVE_LABEL, s)}  budget ${LIVE_BUDGET_MS.toFixed(2)} ms; `
    + `${injected.waits} waits injected across ${injected.reads} reads`;

  t.diagnostic(`${SELF_CHECK_MEASUREMENT_MARKER}${numbers}`);
  assert.ok(injected.waits > 0, `no wait was injected, so this row measured nothing — ${numbers}`);

  // The corridor, judged before the verdict is. Either side of it makes the
  // verdict below mean something other than what this test is asserting, and
  // the decision itself lives in the instrument — see `settleSelfCheck`, which
  // is where this row's own reading of the strict switch used to be. That was
  // the escalation the serial CI step actually reaches and the one thing here
  // no test could execute, because importing this module to reach it registers
  // ten seconds of live measurement; moved one file over it is driven on all
  // three corridor outcomes against both switch states with recorded numbers,
  // and there is one escalation in this repo instead of two.
  //
  // WHERE THIS ROW LIVES, which is the question a skip here forces and which
  // this comment used to answer by describing the exposure instead of closing
  // it. The row has a step of its own in the serial `latency-budget` job — one
  // file, alone, on an idle runner — and that step sets the strict switch, so
  // on the only runner where the corridor is meant to be reachable, leaving it
  // is a RED that fails the job. Three things had to be true for that sentence
  // to mean anything, and each is asserted rather than asserted-about:
  //
  //   - something has to SET the switch. Nothing did: for three rounds
  //     T1_LATENCY_BUDGET_STRICT appeared only in its own definition, in one
  //     branch, and in prose, so the escalation could not happen on any runner.
  //     The step's `env:` sets it, ci-workflow.ts requires that env on the step
  //     invoking this file, and the name is imported from the instrument rather
  //     than retyped.
  //   - the skip has to be VISIBLE where it survives. Off the serial runner
  //     (local `npm test`, and the 291-file parallel suite) this stays
  //     three-valued, and a skip line inside a three-thousand-test run is not a
  //     diagnosis — this repo rejects that argument everywhere else. So the
  //     corridor exit prints the instrument's own INCONCLUSIVE verdict line
  //     first, which is the exact phrase the parallel job greps for to turn an
  //     unanswerable measurement into an annotation. Measured before: forcing
  //     the exit produced exit 0, one skipped test, and ZERO lines that step
  //     could see.
  //   - the corridor has to be reachable on the runner that reds. It was
  //     measured leaving one run in three under ordinary contention, with the
  //     departing run's underlying verdict a `fail`, i.e. the skip converted the
  //     run that would have been red into a run that said nothing. The widened
  //     corridor above contains every draw either measurement campaign has
  //     produced, loaded or idle.
  //
  // What is left is the honest three-valued case: a machine that cannot host
  // this measurement says so, with the numbers, through a channel that is read.
  if (settleSelfCheck(t, starved, numbers)) return;

  // The verdict itself. This is the row that fails if the filesystem detector
  // is deleted: with `ioDelivered` pinned at 1 the machine reads as fully
  // delivering, the discount in rule 3 does nothing, and this same measurement
  // comes out FAIL — a breach billed to a section whose only cost is reads, on
  // a run where the reads were made to wait on purpose.
  assert.equal(starved.verdict, 'inconclusive', `${starved.reason} — ${numbers}`);
  assert.match(starved.reason, /% of the filesystem a reference workload asked for/);
});
