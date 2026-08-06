import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLatency, type LatencySamples } from './latency-budget';

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

function samples(wall: number[], cpu: number[], delivered: number): LatencySamples {
  return { wall, cpu, delivered };
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

test('an under-budget wall clock passes however starved the machine was', () => {
  // The one-way soundness that makes this safe to adopt: contention can only
  // ever inflate, so nothing the classifier does can turn a green into a red.
  const r = classifyLatency(samples(shape(60, 90, 149), shape(20, 25, 30), 0.02), BUDGET);
  assert.equal(r.verdict, 'pass', r.reason);
});
