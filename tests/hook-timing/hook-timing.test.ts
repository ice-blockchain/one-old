// tests/hook-timing/hook-timing.test.ts
// Wall-clock per hook EVENT, measured through the real dispatch path.
//
// ── what was missing ────────────────────────────────────────────────────────
// Exactly one hook event had an enforced latency budget: PreToolUse, via the
// 150 ms p95 assertion in src/modules/plan-guard/__tests__/plan-write.test.ts.
// That assertion calls `planWriteGate(ctx)` — one handler function, on a Ctx
// built by hand. Six other canonical events had no budget and no measurement,
// and even the one that had both was measuring a handler rather than an
// invocation. This file measures the INVOCATION: the exported entry function
// that the compiled `scripts/hook-runtime.cjs` / `scripts/cursor-hook-runtime.cjs`
// main() calls with the host's argv and the host's stdin, which is the only
// seam on the far side of which everything a real hook pays for actually
// happens (adapter.parse, the fail-closed pre-checks, per-invocation module
// discovery, observeCurrentRunHostCapabilityFromHook, the pipeline, serialize).
//
// ── the two numbers a hook costs ────────────────────────────────────────────
// A hook invocation is one OS process, so its wall clock decomposes as
//
//     hook wall clock  =  process constant  +  dispatch cost
//
// where the CONSTANT is node startup plus `require` of the compiled bundle —
// event-independent, paid identically by every invocation of every event — and
// the DISPATCH COST is the event-specific part, the only part a source change
// can move. Measured on the authoring machine (macOS, 10 cores, idle,
// n=15/spawn, compiled runtime under bare node): bare `node -e ''` is 22.03 ms
// p50, `require(hook-runtime.cjs)` is 63.43 ms p50, and the constant implied by
// twelve (process cost − dispatch cost) pairs is 108–128 ms, mean ~121 ms, with
// no ordering by event. That additivity is what makes it legitimate to budget
// the dispatch cost on its own, which is what the budget test below does; the
// constant is measured by the opt-in process leg at the bottom rather than
// asserted, because it is a property of Node and of the bundle's require graph
// on a particular machine, not of this repo's gate logic.
//
// ── why the budget number is not a new one ──────────────────────────────────
// 150 ms is the number this product already claims, and it is applied here,
// unchanged, to the six events that had none. That is deliberately not the same
// thing as picking a comfortable round number per event: it invents nothing,
// every event measures under it today with the headroom printed on its own row
// (3.5x for the most expensive, ~100x for the cheapest), and a future tightening
// becomes a data-driven change against a table that already exists. What this
// file does NOT do is assert 150 ms on the whole-process figure — see the
// process leg for why that claim is not currently true, and see the work-item
// report for what would have to change before it could be.

import './invocations';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ALL_CANONICAL_EVENTS,
  HOOK_INVOCATIONS,
  declaredModuleSubcommands,
  invoke,
  type HookInvocation,
} from './invocations';
import { CORPUS_PLUGIN_ROOT, resetCorpusEnv } from '../replay-corpus/env';
import { cleanupReplayTempTrees } from '../replay-corpus/fixtures';
import {
  assertLatencyBudgetAsync,
  latencyStatsLine,
  measureLatencyBudgetAsync,
  type LatencyStats,
} from '../../src/test-support/__tests__/latency-budget';
import type { CanonicalEvent, HostId } from '../../src/core/types';

test.after(cleanupReplayTempTrees);

/**
 * The one declared wall-clock claim this product makes, reused rather than
 * re-invented. See this file's header.
 */
const DECLARED_BUDGET_MS = 150;

/**
 * Sample counts. Small on purpose: this file runs inside `npm test` alongside
 * 290 other files, and a measurement that takes a minute is a measurement that
 * gets deleted. At n=40 the p95 index is 38, so two samples may exceed the
 * budget before the p95 does — the same "a tail is allowed to exist" property
 * the 250-sample assertion next door has at index 237.
 */
const STEADY_SAMPLES = 30;
const STEADY_WARMUP = 3;
/** Cold means one invocation against a project that has never seen one, so
 * every sample costs a whole fixture build outside the timer. */
const COLD_SAMPLES = 5;
/** The cold/steady test only needs the steady figure as a DENOMINATOR; the
 * budget test above is where the steady distribution is established. */
const COLD_COMPARISON_SAMPLES = 20;

/**
 * The opt-in switch for the OS-process leg.
 *
 * `T1_`, never `TRAFFIC_ONE_`: src/build/test-preload.mjs wipes the entire
 * `TRAFFIC_ONE_` namespace before any test file loads, so a switch spelled that
 * way is deleted and silently does nothing (the same trap documented on
 * T1_LATENCY_BUDGET_STRICT).
 *
 * Off by default, and that is a cost decision rather than a confidence one: the
 * leg compiles the runtime and then spawns ~60 node processes, which inside a
 * parallel suite is both slow and a load generator that would push the OTHER
 * timing measurements in this repo toward INCONCLUSIVE — i.e. running it by
 * default would mute the budgets it exists to support. It is NOT allowed to
 * become invisible: with the switch off this file prints the row that says so,
 * and the serial `latency-budget` CI job sets the switch and hard-fails if the
 * process table's marker line is missing from the output, so the leg cannot be
 * quietly turned off anywhere it is supposed to run.
 */
const PROCESS_LEG_ENV = 'T1_HOOK_TIMING_PROCESS';
const PROCESS_TABLE_MARKER = 'HOOK TIMING · OS PROCESS';
const PROCESS_LEG_SKIPPED_MARKER = 'HOOK TIMING · OS PROCESS LEG NOT RUN';

/**
 * The opt-in switch for ENFORCING the budget below, as opposed to measuring it.
 *
 * Measured, and the reason this exists: `claude · session-start` reads 45.31 ms
 * p95 at 100% CPU delivery when this file runs alone, and 152.40 ms (91%
 * delivered) and 242.86 ms (81% delivered) on the same commit inside `npm
 * test`'s 291-file parallel suite. That is a 3.4-5.4x inflation of the wall
 * clock while the instrument's starvation detector still reports 81-91%, and
 * the detector is right to: its reference workload is pure arithmetic and does
 * no I/O (see latency-budget.ts), whereas this row's cost is dominated by
 * fixture filesystem work queued behind 290 other test processes. So the ONE
 * signal the three-valued instrument has for "do not trust this number" is
 * structurally blind to the contention this particular measurement suffers, and
 * enforcing here produces a red that carries no information about the code —
 * exactly the failure mode the instrument was built to end.
 *
 * Set in the serial `latency-budget` CI job, which runs this file alone on a
 * runner that has done nothing else, and which hard-fails if the ENFORCED
 * marker is missing from the output. Everywhere else the rows are still
 * measured, still printed, and any breach is still reported by name — the table
 * says which of the two it was on every run, so "enforced nowhere" is a state
 * this repo cannot reach silently.
 *
 * `T1_`, never `TRAFFIC_ONE_`: src/build/test-preload.mjs wipes that namespace.
 */
const BUDGET_ENV = 'T1_HOOK_TIMING_BUDGET';
const BUDGET_ENFORCED_MARKER = 'HOOK TIMING · BUDGET ENFORCED';
const BUDGET_NOT_ENFORCED_MARKER = 'HOOK TIMING · BUDGET MEASURED, NOT ENFORCED '
  + `(set ${BUDGET_ENV}=1 on a quiet machine)`;

function prepare(row: HookInvocation): { cwd: string; stdin: string } {
  resetCorpusEnv();
  process.env.TRAFFIC_ONE_HOST = row.host;
  const cwd = row.project(row.host as HostId);
  return { cwd, stdin: row.stdin(cwd) };
}

/** One representative invocation per canonical event, for the legs that cannot
 * afford to run all 26 rows. Picked as the most expensive row of that event in
 * the steady table, so nothing here is quietly measuring the cheap case. */
const REPRESENTATIVE: Readonly<Record<CanonicalEvent, string>> = {
  SessionStart: 'claude · session-start',
  UserPromptSubmit: 'claude · user-prompt-submit',
  PreToolUse: 'claude · check-onboarding-gate',
  PostToolUse: 'claude · post-stack-setup',
  SubagentStart: 'claude · subagent-start',
  SubagentStop: 'cursor · cursor-subagent-stop',
  Stop: 'cursor · cursor-stop',
};

function rowByKey(key: string): HookInvocation {
  const row = HOOK_INVOCATIONS.find((candidate) => candidate.key === key);
  assert.ok(row, `no hook invocation named ${key}`);
  return row;
}

// ── 1. the coverage gate ────────────────────────────────────────────────────
// The measurement legs below are only worth their runtime if they cover the
// surface they claim to. This is the assertion that makes a new event or a new
// hook subscription arrive WITH a timing row instead of silently outside the
// harness — the failure mode that turned the one existing budget into a claim
// about one event out of seven in the first place.

test('hook timing harness covers every canonical event and every declared hook subcommand', () => {
  const measuredEvents = new Set(HOOK_INVOCATIONS.map((row) => row.event));
  const missingEvents = ALL_CANONICAL_EVENTS.filter((event) => !measuredEvents.has(event));
  assert.deepEqual(
    missingEvents, [],
    'canonical event(s) with no timing row. A budget that is never measured for an event is not a budget\n'
    + 'for that event — add a row to invocations.ts carrying that event\'s real host wire payload:\n\n  '
    + missingEvents.join('\n  '),
  );

  // Every subcommand the module descriptors declare must be timed. Read back
  // through the real registry, so a module gaining a subscription fails here
  // by name rather than shrinking the harness's coverage silently.
  const declared = declaredModuleSubcommands();
  const measuredSubcommands = new Set(HOOK_INVOCATIONS.map((row) => row.subcommand));
  const untimed = [...declared].filter((subcommand) => !measuredSubcommands.has(subcommand)).sort();
  assert.deepEqual(
    untimed, [],
    'hook subcommand(s) declared by a module descriptor that no timing row invokes. Each of these is a\n'
    + 'separate OS process a host fires with no measurement behind it:\n\n  ' + untimed.join('\n  '),
  );

  // And the reverse: a row naming a subcommand nothing declares is measuring a
  // dead entry point, which reads as coverage and is not.
  const cursorSubcommands = new Set(
    HOOK_INVOCATIONS.filter((row) => row.family === 'cursor').map((row) => row.subcommand),
  );
  const orphaned = [...measuredSubcommands]
    .filter((subcommand) => !declared.has(subcommand) && !cursorSubcommands.has(subcommand))
    .sort();
  assert.deepEqual(orphaned, [], `timing row(s) for a subcommand no module declares: ${orphaned.join(', ')}`);

  for (const event of ALL_CANONICAL_EVENTS) rowByKey(REPRESENTATIVE[event]);
});

// ── 2. the budget ───────────────────────────────────────────────────────────

test('every hook event stays inside the 150 ms in-process dispatch budget at p95', async (t) => {
  const lines: string[] = [];
  const breaches: string[] = [];
  const byEvent = new Map<CanonicalEvent, LatencyStats[]>();
  const enforced = process.env[BUDGET_ENV] === '1';

  for (const row of HOOK_INVOCATIONS) {
    const { stdin } = prepare(row);
    // Prove the measurement actually went through the dispatch path before
    // timing it: an entry that threw and fell through to its always-exit-0
    // fallback returns quickly and would measure a very fast nothing.
    const first = await invoke(row, stdin);
    assert.equal(typeof first, 'string', `${row.key}: entry returned no stdout string`);

    const options = {
      label: `${row.key} (${row.event})`,
      budgetMs: DECLARED_BUDGET_MS,
      samples: STEADY_SAMPLES,
      warmup: STEADY_WARMUP,
      run: () => invoke(row, stdin),
    };
    const outcome = enforced
      ? await assertLatencyBudgetAsync(t, options)
      : await measureLatencyBudgetAsync(options);
    if (!enforced && outcome.verdict !== 'pass') {
      breaches.push(`${options.label}: ${outcome.verdict.toUpperCase()} — ${outcome.reason}`);
      t.diagnostic(`HOOK TIMING BUDGET NOT ENFORCED · ${options.label} · ${outcome.reason}`);
    }
    const headroom = outcome.stats.wallP95 > 0 ? DECLARED_BUDGET_MS / outcome.stats.wallP95 : Infinity;
    lines.push(`${latencyStatsLine(`${row.key} [${row.event}]`, outcome.stats)}  headroom ${headroom.toFixed(1)}x`);
    const bucket = byEvent.get(row.event) ?? [];
    bucket.push(outcome.stats);
    byEvent.set(row.event, bucket);
  }

  const worst = [...byEvent.entries()]
    .map(([event, stats]) => `${event}=${Math.max(...stats.map((s) => s.wallP95)).toFixed(2)}`)
    .join('  ');
  process.stdout.write([
    '',
    'HOOK TIMING · IN-PROCESS DISPATCH (steady state, warm process, warm project)',
    ...lines,
    `worst p95 per event (ms): ${worst}`,
    `budget: ${DECLARED_BUDGET_MS} ms p95 — the product's one declared wall-clock claim, applied to the`,
    'six events that had none. This bounds the DISPATCH cost only; the per-invocation process constant',
    `is measured by the ${PROCESS_TABLE_MARKER} leg.`,
    enforced ? BUDGET_ENFORCED_MARKER : BUDGET_NOT_ENFORCED_MARKER,
    ...breaches.map((line) => `  ${line}`),
    '',
  ].join('\n'));

  for (const event of ALL_CANONICAL_EVENTS) {
    assert.ok(byEvent.has(event), `${event} produced no measurement — the budget was not checked for it`);
  }
});

// ── 3. cold vs steady ───────────────────────────────────────────────────────

test('cold and steady state are measured separately for every hook event', async (t) => {
  const lines: string[] = [];
  for (const event of ALL_CANONICAL_EVENTS) {
    const row = rowByKey(REPRESENTATIVE[event]);

    // Cold: a fresh project per sample, built in `setup` so the fixture cost
    // stays outside the timed window. This is the FIRST invocation of this
    // event against a project — materialization, the retention sweep and every
    // per-project cache population land on it and on no later one.
    let stdin = '';
    const cold = await measureLatencyBudgetAsync({
      label: `${row.key} cold`,
      budgetMs: DECLARED_BUDGET_MS,
      samples: COLD_SAMPLES,
      warmup: 0,
      setup: () => { stdin = prepare(row).stdin; },
      run: () => invoke(row, stdin),
    });

    const steadyPrepared = prepare(row);
    await invoke(row, steadyPrepared.stdin);
    const steady = await measureLatencyBudgetAsync({
      label: `${row.key} steady`,
      budgetMs: DECLARED_BUDGET_MS,
      samples: COLD_COMPARISON_SAMPLES,
      warmup: STEADY_WARMUP,
      run: () => invoke(row, steadyPrepared.stdin),
    });

    const ratio = steady.stats.wallP50 > 0 ? cold.stats.wallP50 / steady.stats.wallP50 : Infinity;
    lines.push([
      `${event} · ${row.key}`.padEnd(44),
      `cold p50/max ${cold.stats.wallP50.toFixed(2)}/${cold.stats.wallMax.toFixed(2)} ms (n=${cold.stats.n})`,
      `steady p50/p95 ${steady.stats.wallP50.toFixed(2)}/${steady.stats.wallP95.toFixed(2)} ms (n=${steady.stats.n})`,
      `cold/steady ${ratio.toFixed(1)}x`,
    ].join('  '));
    t.diagnostic(lines[lines.length - 1] as string);
  }
  process.stdout.write([
    '',
    'HOOK TIMING · COLD vs STEADY (fresh project per cold sample; same warm process)',
    ...lines,
    'CAVEAT, and it is a large one for SessionStart. A hook does not only run code in its own process:',
    'the first SessionStart on a project SHELLS OUT, synchronously, to a second full node process',
    `(${'scripts/one-mcp-sync.cjs'}) and blocks on it. The corpus plugin root ships a STUB at that path`,
    '(replay-corpus/plugin-root.ts writes `module.exports = {}` there), so the cold figures above pay a',
    'trivial spawn instead of a real one. Against a real compiled runtime the same first SessionStart',
    'measures 723-1041 ms, of which 681 ms is that nested spawnSync — traced on the authoring machine.',
    'No in-process measurement can see that; the OS-process leg is the only one that can.',
    'A budget belongs on the STEADY figure: the cold one is paid at most once per project per process,',
    'it is dominated by work that is idempotent by construction (materialization, the run-retention',
    'sweep), and holding a first invocation to a steady-state number would only ever be met by not doing',
    'that work. What the cold column IS for is the ratio: an event whose ratio grows has started doing',
    'first-invocation work that no steady-state measurement can see.',
    '',
  ].join('\n'));
});

// ── 4. the OS-process leg (opt-in) ──────────────────────────────────────────

interface SpawnStats { p50: number; p95: number; max: number; n: number }

function spawnTimes(args: readonly string[], stdin: string, env: NodeJS.ProcessEnv, cwd: string, n: number): SpawnStats {
  const samples: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const startedAt = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [...args], { input: stdin, encoding: 'utf8', env, cwd, timeout: 60_000 });
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
    assert.equal(result.status, 0, `${args.join(' ')} exited ${result.status}: ${result.stderr || ''}`);
  }
  samples.sort((a, b) => a - b);
  return {
    n,
    p50: samples[Math.floor(samples.length * 0.5)] ?? 0,
    p95: samples[Math.floor(samples.length * 0.95)] ?? 0,
    max: samples[samples.length - 1] ?? 0,
  };
}

test('the per-invocation OS-process constant is measured against the compiled runtime', async (t) => {
  if (process.env[PROCESS_LEG_ENV] !== '1') {
    process.stdout.write([
      '',
      `${PROCESS_LEG_SKIPPED_MARKER} — set ${PROCESS_LEG_ENV}=1 to measure it.`,
      'It compiles the runtime and spawns ~60 bare-node hook processes; run by default it would be a load',
      'generator inside a parallel suite and would push this repo\'s other wall-clock measurements into',
      'INCONCLUSIVE. The serial `latency-budget` CI job sets the switch and fails if this table is absent.',
      '',
    ].join('\n'));
    t.diagnostic(PROCESS_LEG_SKIPPED_MARKER);
    return;
  }

  // Build THIS source, rather than reading whatever dist/ happens to hold: a
  // timing number attributed to a tree nobody can name is not evidence. Emitted
  // over the corpus plugin root's stub scripts/ dir, so the child resolves
  // rules, skills and gate prose exactly the way every other corpus consumer
  // does. require()d lazily so the tsc dependency is not paid when the leg is off.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildRuntime } = require('../../src/build/build-runtime') as typeof import('../../src/build/build-runtime');
  const scripts = path.join(CORPUS_PLUGIN_ROOT, 'scripts');
  buildRuntime(scripts);
  assert.ok(fs.existsSync(path.join(scripts, 'hook-runtime.cjs')), 'compiled hook runtime was not emitted');

  const N = 8;
  const lines: string[] = [];
  resetCorpusEnv();

  // Drive one FULL dispatch through every shim before measuring anything, and
  // report what that first one cost. It is a large, real and easily misread
  // number: the first bare-node process to touch a freshly emitted bundle
  // faults in the OS page cache for several hundred compiled files — including
  // `scripts/modules/**`, which a bare `require()` of the entry does not even
  // reach, since loadModules runs at call time. Measured that way one
  // invocation came in at 1078 ms against a 173 ms steady figure. That is a
  // cold FILE CACHE, not a cold project; attributing it to the event would be
  // wrong by an order of magnitude and would also poison whichever event
  // happened to be measured first. So it is taken once, on its own, here.
  const firstDispatch: string[] = [];
  for (const shim of [...new Set(HOOK_INVOCATIONS.map((row) => row.shim))]) {
    const seed = HOOK_INVOCATIONS.find((row) => row.shim === shim);
    assert.ok(seed, `no row uses ${shim}`);
    const prepared = prepare(seed);
    const first = spawnTimes(
      [path.join(scripts, shim), seed.subcommand], prepared.stdin,
      { ...process.env, TRAFFIC_ONE_HOST: seed.host }, prepared.cwd, 1,
    );
    firstDispatch.push(`${shim} ${first.p50.toFixed(2)}`);
  }
  lines.push(`first dispatch through a freshly emitted bundle (cold page cache): ${firstDispatch.join(', ')} ms`);
  lines.push('  ^ once per machine per build, NOT per event and NOT per project — excluded from the rows below');

  const bootFloor = spawnTimes(['-e', ''], '', process.env, process.cwd(), N);
  const requireOnly = spawnTimes(
    ['-e', `require(${JSON.stringify(path.join(scripts, 'hook-runtime.cjs'))})`],
    '', process.env, process.cwd(), N,
  );
  lines.push(`node boot floor (node -e '')          p50 ${bootFloor.p50.toFixed(2)}  p95 ${bootFloor.p95.toFixed(2)}  max ${bootFloor.max.toFixed(2)}  n=${N}`);
  lines.push(`+ require(hook-runtime.cjs)           p50 ${requireOnly.p50.toFixed(2)}  p95 ${requireOnly.p95.toFixed(2)}  max ${requireOnly.max.toFixed(2)}  n=${N}`);
  lines.push(`= module-load cost, before dispatch   p50 ${(requireOnly.p50 - bootFloor.p50).toFixed(2)} ms, paid by EVERY invocation of EVERY event`);

  for (const event of ALL_CANONICAL_EVENTS) {
    const row = rowByKey(REPRESENTATIVE[event]);
    const { cwd, stdin } = prepare(row);
    const env = { ...process.env, TRAFFIC_ONE_HOST: row.host };
    const shim = path.join(scripts, row.shim);
    // Cold: the very first hook process this project has ever seen.
    const coldProject = prepare(row);
    const cold = spawnTimes([shim, row.subcommand], coldProject.stdin, env, coldProject.cwd, 1);
    spawnTimes([shim, row.subcommand], stdin, env, cwd, 1); // warm the project
    const steady = spawnTimes([shim, row.subcommand], stdin, env, cwd, N);
    lines.push([
      `${event} · ${row.key}`.padEnd(38),
      `p50 ${steady.p50.toFixed(2)}`,
      `p95 ${steady.p95.toFixed(2)}`,
      `max ${steady.max.toFixed(2)}`,
      `n=${N}`,
      `cold-project ${cold.p50.toFixed(2)}`,
    ].join('  '));
    t.diagnostic(lines[lines.length - 1] as string);
  }

  process.stdout.write([
    '',
    `${PROCESS_TABLE_MARKER} (compiled runtime, bare node, one process per invocation)`,
    ...lines,
    'The SessionStart cold-project column is ~6x its own steady figure and it is not materialization:',
    'traced on the authoring machine, the first SessionStart per (project, host, session) spawns',
    'scripts/one-mcp-sync.cjs as a nested synchronous node process and blocks on it for 681 ms of a',
    '890 ms invocation, plus two git calls. It is guarded by a runs/.once/ marker keyed on the session',
    'id, so every new session pays it once.',
    'This is the figure a host actually waits for, and it is NOT asserted against the 150 ms budget:',
    'on the authoring machine the PreToolUse row measures ~132-148 ms against it, i.e. the standing claim',
    'is at ~90% utilisation before any contention, and a Claude PreToolUse on a Write fires FOUR such',
    'processes (five on a Bash) because hooks.json registers one command per gate. Asserting 150 ms here',
    'would be asserting a claim the product does not currently meet.',
    '',
  ].join('\n'));
});
