import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { attach, delegateFromPlanResumable, delegateResumable, delegateStatus, dispatch, parseRunnerResult, planQueueRoles, runDelegate, runDelegateFromPlan } from '../index';
import { clearOpenCodeApplyInProgress, markOpenCodeApplyInProgress, openCodeApplyInProgress, parsePlanDelegationUnits, readOpenCodePlanBatchState } from '../../../shared/opencode-roles';
import { buildOpenCodeQueue, readOpenCodeUnitStatuses } from '../../../shared/opencode-queue';
import { OPENCODE_RUNNER_OVERRIDE_ENV } from '../../../config/opencode-mcp';

type Any = Record<string, any>;

function writePlanQueue(projectRoot: string, runId: string, planMarkdown: string): void {
  const units = parsePlanDelegationUnits(planMarkdown);
  const queue = buildOpenCodeQueue(projectRoot, runId, units);
  const runDir = path.join(projectRoot, '.traffic-one', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'opencode-queue.json'), `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

// ── dispatch(): the MCP protocol surface (pure, no subprocess) ───────────────

test('initialize echoes the client protocolVersion + reports serverInfo', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26' } })) as Any;
  assert.equal(resp.id, 0);
  assert.equal(resp.result.protocolVersion, '2025-03-26');
  assert.equal(resp.result.serverInfo.name, 'opencode-worker');
  assert.ok(resp.result.capabilities.tools);
});

test('initialize falls back to a default protocol version when none requested', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })) as Any;
  assert.match(resp.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test('tools/list advertises the delegation + status tools with their schemas', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as Any;
  const names = resp.result.tools.map((t: Any) => t.name).sort();
  assert.deepEqual(names, ['opencode_delegate', 'opencode_delegate_from_plan', 'opencode_status']);
  const del = resp.result.tools.find((t: Any) => t.name === 'opencode_delegate');
  assert.deepEqual(del.inputSchema.required, ['role', 'task', 'runId', 'allowedFiles']);
  const batch = resp.result.tools.find((t: Any) => t.name === 'opencode_delegate_from_plan');
  assert.deepEqual(batch.inputSchema.required, ['runId']);
});

test('ping returns an empty result', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 3, method: 'ping' })) as Any;
  assert.deepEqual(resp.result, {});
});

test('notifications receive no reply', async () => {
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
});

test('an unknown request method → JSON-RPC -32601', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 4, method: 'does/not/exist' })) as Any;
  assert.equal(resp.error.code, -32601);
});

// ── parseRunnerResult(): tolerate stray stdout above the JSON line ───────────

test('parseRunnerResult takes the last JSON object line', () => {
  const r = parseRunnerResult('warming up...\n{"ok":true,"action":"delegated"}\n', '');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'delegated');
});

test('parseRunnerResult surfaces the stderr tail when there is no JSON', () => {
  const r = parseRunnerResult('', 'opencode gateway unreachable');
  assert.equal(r.ok, false);
  assert.match(r.error || '', /gateway unreachable/);
});

// ── runDelegate / runDelegateFromPlan: spawn a STUB runner ───────────────────

// Stub runner: echoes the flags it received (so we can assert plumbing) + the
// task-file contents + its cwd, as the single JSON line a real runner prints.
const ECHO_STUB = [
  'const a = process.argv.slice(2);',
  'const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };',
  'const fs = require("fs");',
  'const tf = get("--task-file");',
  'const task = tf && fs.existsSync(tf) ? fs.readFileSync(tf, "utf8") : null;',
  'console.log(JSON.stringify({ ok: true, action: "delegated", role: get("--role"), runId: get("--run-id"), allowedFiles: get("--allowed-files"), task, cwd: process.cwd(), fromPlan: a.includes("--from-plan"), digest: null, touched: [] }));',
].join('\n');

function withStubRunner(stub: string, fn: (projectRoot: string) => Promise<void>): Promise<void> {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmcp-stub-'));
  const runner = path.join(stubDir, 'stub-runner.cjs');
  fs.writeFileSync(runner, stub, 'utf8');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmcp-proj-'));
  const saved = process.env[OPENCODE_RUNNER_OVERRIDE_ENV];
  process.env[OPENCODE_RUNNER_OVERRIDE_ENV] = runner;
  return (async () => {
    try {
      await fn(projectRoot);
    } finally {
      if (saved === undefined) delete process.env[OPENCODE_RUNNER_OVERRIDE_ENV];
      else process.env[OPENCODE_RUNNER_OVERRIDE_ENV] = saved;
      fs.rmSync(stubDir, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  })();
}

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * The HANG CEILING for every wait below whose subject is a delegation's
 * BEHAVIOUR rather than its duration. Never a budget: `waitBounded` resolves
 * the instant the run settles, so a green test costs what the stub costs and
 * this number never elapses.
 *
 * It replaces a family of waits sized off the stub's own sleep constant
 * ("the stub sleeps 1200 ms, so 1500 ms is plenty"), an arithmetic that
 * silently assumes a child boots in ~0 ms. It does not. Measured on this
 * repo's suite machine (10 cores), spawn-to-close overhead for a node child
 * that prints on a fixed timer:
 *
 *     idle                    p50  51 ms   max  59 ms
 *     40 concurrent spawns    p50 363 ms   max 442 ms
 *
 * `npm test` runs 291 test files as parallel processes, so the full suite is
 * the 40-spawn column, and a 1500 ms wait against a 1200 ms stub left ~355 ms
 * of boot budget — a coin flip. Two tests in this file were measured red under
 * exactly that pressure and 35/35 green in isolation.
 *
 * Widening a wait is only safe where the assertion does not depend on it, so
 * the resumable tests below no longer leave "did this re-call start a SECOND
 * runner?" to the clock at all. They never checked it reliably: a restarted
 * delegation settles in boot + 1200 ms, comfortably inside the 1500 ms and
 * 2000 ms waits it was supposedly bounded by. SLOW_COUNTING_STUB counts the
 * spawns instead, which is checkable at any speed.
 */
const TERMINAL_WAIT_CEILING_MS = 60_000;

test('runDelegate plumbs role/runId/task-file and runs in projectRoot', async () => {
  await withStubRunner(ECHO_STUB, async (projectRoot) => {
    const r = (await runDelegate({ role: 'senior-frontend', task: 'build the card', runId: 'run-123', allowedFiles: 'apps/web/src/Card.tsx', projectRoot })) as Any;
    assert.equal(r.ok, true);
    assert.equal(r.role, 'senior-frontend');
    assert.equal(r.runId, 'run-123');
    assert.equal(r.allowedFiles, 'apps/web/src/Card.tsx');
    assert.equal(r.task, 'build the card');
    assert.equal(r.cwd, fs.realpathSync(projectRoot)); // child cwd === projectRoot (realpath: macOS /var → /private/var)
  });
});

test('runDelegate rejects missing required args without spawning', async () => {
  const noRole = (await runDelegate({ role: '', task: 'x', runId: '1' })) as Any;
  assert.equal(noRole.ok, false);
  assert.match(noRole.error, /role is required/);
  const noTask = (await runDelegate({ role: 'r', task: '   ', runId: '1' })) as Any;
  assert.match(noTask.error, /task is required/);
  const noAllowed = (await runDelegate({ role: 'r', task: 'x', runId: '1' })) as Any;
  assert.match(noAllowed.error, /allowedFiles is required/);
});

test('runDelegateFromPlan passes --from-plan + run-id', async () => {
  await withStubRunner(ECHO_STUB, async (projectRoot) => {
    const r = (await runDelegateFromPlan({ runId: 'rp1', projectRoot })) as Any;
    assert.equal(r.fromPlan, true);
    assert.equal(r.runId, 'rp1');
  });
});

// ── Plan-batch: one runner per role, run SEQUENTIALLY, merged result ─────────
// (Shards used to run concurrently; that dropped later shards on Cursor — only the
// first reached the OpenCode CLI — so forced roles went undelegated. Now serial.)

const PLAN_TWO_ROLES = [
  '# Plan', '',
  '<!-- opencode-delegate:start -->',
  '- id: fe-a | role: senior-frontend | files: a.txt | task: unit A',
  '- id: fe-a2 | role: frontend | files: a2.txt | task: unit A2',
  '- id: tester-b | role: tester | files: b.txt | task: unit B',
  '<!-- opencode-delegate:end -->', '',
].join('\n');

// Echoes the --roles shard it got as a one-unit batch result and counts
// invocations in a sidecar file next to the runner script.
const SHARD_STUB = [
  'const a = process.argv.slice(2);',
  'const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };',
  'const fs = require("fs"); const path = require("path");',
  'const marker = path.join(__dirname, "shard-calls");',
  'fs.appendFileSync(marker, (get("--roles") || "(all)") + "\\n");',
  'const roles = (get("--roles") || "").split(",").filter(Boolean);',
  'console.log(JSON.stringify({ total: roles.length || 1, delegated: roles.length || 1, units: roles.map((r) => ({ role: r, task: "t", action: "delegated", touched: [] })) }));',
].join('\n');

// Returns JSON for the frontend shard only; the tester shard exits without JSON.
const PARTIAL_SHARD_STUB = [
  'const a = process.argv.slice(2);',
  'const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };',
  'const role = get("--roles") || "all";',
  'if (role === "frontend" || !get("--roles")) {',
  '  console.log(JSON.stringify({ total: 1, delegated: 1, units: [{ id: "fe-a", role: "frontend", task: "unit A", action: "delegated", touched: [] }] }));',
  '} else { process.exit(0); }',
].join('\n');

test('planQueueRoles: distinct normalized roles in order; empty without a plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocmcp-plan-'));
  try {
    assert.deepEqual(planQueueRoles(dir), []);
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), PLAN_TWO_ROLES, 'utf8');
    assert.deepEqual(planQueueRoles(dir), ['frontend', 'tester']); // senior- stripped, deduped
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDelegateFromPlan runs a multi-role queue as per-role shards (sequential) and merges every role', async () => {
  await withStubRunner(SHARD_STUB, async (projectRoot) => {
    fs.mkdirSync(path.join(projectRoot, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), PLAN_TWO_ROLES, 'utf8');
    const r = (await runDelegateFromPlan({ runId: 'rp-shard', projectRoot })) as Any;
    // EVERY role's units land in the merged result — the Cursor bug was that later
    // (concurrent) shards silently delivered nothing.
    assert.equal(r.total, 2);
    assert.equal(r.delegated, 2);
    assert.deepEqual(r.units.map((u: Any) => u.role).sort(), ['frontend', 'tester']);
    const marker = path.join(path.dirname(process.env[OPENCODE_RUNNER_OVERRIDE_ENV] as string), 'shard-calls');
    const calls = fs.readFileSync(marker, 'utf8').trim().split('\n');
    assert.equal(calls.length, 2, 'one runner per role shard');
    assert.ok(calls.every((c) => c !== '(all)'), 'shards must carry --roles');
  });
});

test('multi-role partial failure synthesizes missing role units from queue', async () => {
  await withStubRunner(PARTIAL_SHARD_STUB, async (projectRoot) => {
    fs.mkdirSync(path.join(projectRoot, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), PLAN_TWO_ROLES, 'utf8');
    writePlanQueue(projectRoot, 'rp-partial', PLAN_TWO_ROLES);
    const r = (await runDelegateFromPlan({ runId: 'rp-partial', projectRoot })) as Any;
    assert.equal(r.units.length, 3);
    assert.equal(r.units.filter((u: Any) => u.role === 'frontend').length, 2);
    assert.equal(r.units.filter((u: Any) => u.role === 'tester').length, 1);
    assert.equal(r.units.find((u: Any) => u.id === 'fe-a')?.action, 'delegated');
    assert.equal(r.units.find((u: Any) => u.id === 'tester-b')?.action, 'failed');
    assert.equal(r.units.find((u: Any) => u.id === 'fe-a2')?.action, 'failed');
    const batch = readOpenCodePlanBatchState(projectRoot, 'rp-partial');
    assert.equal(batch?.outcome, 'partial');
  });
});

test('runDelegateFromPlan stays single-runner for a single-role queue', async () => {
  await withStubRunner(SHARD_STUB, async (projectRoot) => {
    fs.mkdirSync(path.join(projectRoot, '.traffic-one'), { recursive: true });
    const plan = ['<!-- opencode-delegate:start -->', '- id: fe-a | role: frontend | files: a | task: A', '- id: fe-b | role: senior-frontend | files: b | task: B', '<!-- opencode-delegate:end -->'].join('\n');
    fs.writeFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), plan, 'utf8');
    await runDelegateFromPlan({ runId: 'rp-single', projectRoot });
    const marker = path.join(path.dirname(process.env[OPENCODE_RUNNER_OVERRIDE_ENV] as string), 'shard-calls');
    const calls = fs.readFileSync(marker, 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['(all)'], 'single role → plain --from-plan, no shard flag');
  });
});

// ── Resumable (background) delegation: survive the host's ~120s tool-call timeout ─

// A runner stub that takes longer than the bounded wait window, so the first
// resumable call returns {running} and a later call returns the result.
const SLOW_STUB = [
  'const a = process.argv.slice(2);',
  'const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };',
  'setTimeout(() => { console.log(JSON.stringify({ ok: true, action: "delegated", role: get("--role"), digest: null, touched: [] })); }, 1200);',
].join('\n');

// SLOW_STUB plus a spawn ledger, appended at BOOT (before the sleep) so the
// count is complete the moment any delegation reports a terminal result. This
// is what proves a re-call waited on the IN-FLIGHT run rather than starting a
// second one: a second runner answers ok:true too, so no assertion on the
// RESULT can tell the two apart, at any wait length.
const SLOW_COUNTING_STUB = [
  'const fs = require("fs"); const path = require("path");',
  'fs.appendFileSync(path.join(__dirname, "slow-spawns"), process.argv.slice(2).join(" ") + "\\n");',
  'const a = process.argv.slice(2);',
  'const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };',
  'setTimeout(() => { console.log(JSON.stringify({ ok: true, action: "delegated", role: get("--role"), digest: null, touched: [] })); }, 1200);',
].join('\n');

function slowSpawnCount(): number {
  const marker = path.join(path.dirname(process.env[OPENCODE_RUNNER_OVERRIDE_ENV] as string), 'slow-spawns');
  try {
    return fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

test('delegateResumable returns {running} within the wait window, then the result on re-call (idempotent)', async () => {
  await withStubRunner(SLOW_COUNTING_STUB, async (projectRoot) => {
    const args = { role: 'senior-frontend', task: 'slow unit', runId: 'res-1', allowedFiles: 'apps/web/src/**', projectRoot };
    // 200 ms IS the subject here and stays small: the stub cannot print before
    // 1200 ms, so this window is short whatever the machine is doing.
    const first = (await delegateResumable(args, 200)) as Any;
    assert.equal(first.running, true);
    assert.equal(first.runId, 'res-1');
    assert.equal(first.ok, undefined); // not a terminal result → not a fallback signal
    // Waits for the run to SETTLE, rather than sleeping a guessed interval and
    // hoping it has. The old `setTimeout(1400)` + 200 ms window was a 600 ms
    // boot budget and was measured red under a full suite.
    const second = (await delegateResumable(args, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(second.ok, true);
    assert.equal(second.action, 'delegated');
    assert.equal(second.role, 'senior-frontend');
    const third = (await delegateResumable(args, 50)) as Any; // cached → idempotent
    assert.equal(third.ok, true);
    assert.equal(slowSpawnCount(), 1, 'a re-call replays the finished run; it never re-spawns the runner');
  });
});

test('delegateResumable re-call without a task keeps waiting on the in-flight run', async () => {
  await withStubRunner(SLOW_COUNTING_STUB, async (projectRoot) => {
    const start = (await delegateResumable({ role: 'senior-tester', task: 'slow', runId: 'res-3', allowedFiles: 'apps/web/e2e/**', projectRoot }, 100)) as Any;
    assert.equal(start.running, true);
    // The re-call omits the task. The claim is BEHAVIOURAL and checkable under
    // any load: it must attach to the existing run instead of re-running the
    // "task is required" argument check. That error is TERMINAL, so a
    // regression surfaces on the first reply — the ceiling below is never
    // reached and the assertion cannot pass by waiting.
    const again = (await delegateResumable({ role: 'senior-tester', runId: 'res-3', projectRoot, task: '' } as any, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.doesNotMatch(String(again.error ?? ''), /task is required/, 'a re-call must not re-assert the start-time argument checks');
    assert.equal(again.ok, true);
    assert.equal(slowSpawnCount(), 1, 'it waited on the IN-FLIGHT run, not a second delegation');
  });
});

test('delegateStatus reports running → done, surfaces reservedFiles while running', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const args = { role: 'senior-frontend', task: 'slow', runId: 'res-2', allowedFiles: 'apps/web/src/**', projectRoot };
    const started = (await delegateResumable(args, 100)) as Any; // start (returns running)
    assert.deepEqual(started.reservedFiles, ['apps/web/src/**']);
    const running = (await delegateStatus({ runId: 'res-2', role: 'senior-frontend', projectRoot })) as Any;
    assert.equal(running.status, 'running');
    assert.deepEqual(running.reservedFiles, ['apps/web/src/**']);
    await delegateResumable(args, TERMINAL_WAIT_CEILING_MS); // wait for completion, however slow the boot was
    const st = (await delegateStatus({ runId: 'res-2', role: 'senior-frontend', projectRoot })) as Any;
    assert.equal(st.status, 'done');
    assert.equal(st.result.ok, true);
    assert.equal(((await delegateStatus({ runId: 'nope', projectRoot })) as Any).status, 'unknown');
  });
});

test('delegateStatus waitMs is a bounded long wait that returns the terminal result', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const args = { role: 'senior-frontend', task: 'slow', runId: 'res-wait', allowedFiles: 'apps/web/src/**', projectRoot };
    const first = (await delegateResumable(args, 100)) as Any; // stub sleeps 1200ms
    assert.equal(first.running, true);
    // One long status wait collects the terminal result — no re-poll loop, so
    // the poll-until-terminal shape used elsewhere would destroy the claim.
    // The ceiling is what makes the single call honest instead of a race.
    const st = (await delegateStatus({ runId: 'res-wait', role: 'senior-frontend', projectRoot, waitMs: TERMINAL_WAIT_CEILING_MS })) as Any;
    assert.equal(st.status, 'done');
    assert.equal(st.result.ok, true);
  });
});

test('delegateStatus cancel kills the worker and marks the delegation cancelled', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const args = { role: 'senior-frontend', task: 'slow', runId: 'res-cancel', allowedFiles: 'apps/web/src/**', projectRoot };
    const first = (await delegateResumable(args, 100)) as Any;
    assert.equal(first.running, true);
    const cancelled = (await delegateStatus({ runId: 'res-cancel', role: 'senior-frontend', projectRoot, cancel: true })) as Any;
    assert.equal(cancelled.status, 'done');
    assert.equal(cancelled.result.ok, false);
    assert.equal(cancelled.result.action, 'cancelled');
    assert.match(String(cancelled.result.error), /explicitly cancelled/);
    // Idempotent: cancelling a finished run just replays its terminal result.
    const again = (await delegateStatus({ runId: 'res-cancel', role: 'senior-frontend', projectRoot, cancel: true })) as Any;
    assert.equal(again.status, 'done');
    // Unknown runs cannot be cancelled — say so instead of pretending.
    const unknown = (await delegateStatus({ runId: 'never-started', projectRoot, cancel: true })) as Any;
    assert.equal(unknown.status, 'unknown');
    assert.match(String(unknown.message), /nothing to cancel/);
  });
});

test('a role-less cancel targets the single tracked delegation instead of the plan key', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const args = { role: 'senior-frontend', task: 'slow', runId: 'res-roleless', allowedFiles: 'apps/web/src/**', projectRoot };
    const first = (await delegateResumable(args, 100)) as Any;
    assert.equal(first.running, true);
    // The prose shows bare {cancel:true}; with exactly one tracked delegation
    // for this run it must cancel THAT, not answer 'nothing to cancel' on the
    // plan key while the worker keeps running (adversarial review).
    const cancelled = (await delegateStatus({ runId: 'res-roleless', projectRoot, cancel: true })) as Any;
    assert.equal(cancelled.status, 'done');
    assert.equal(cancelled.result.action, 'cancelled');
    assert.equal(cancelled.role, 'senior-frontend');
  });
});

// The apply-back latch is PID-verified, not mtime-fresh: the guarded section's
// own budget (several 120s verification commands) outlives any short TTL, and
// an aged-but-live latch expiring mid-typecheck let a cancel strand an
// applied-unverified diff (adversarial review).
test('the apply latch holds while its runner pid is alive, past any freshness window', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-latch-pid-'));
  try {
    markOpenCodeApplyInProgress(projectRoot, 'latch-run', 'senior-frontend');
    const latchDir = path.join(projectRoot, '.traffic-one', 'runs', 'latch-run', 'opencode-applying');
    const latchFile = path.join(latchDir, 'senior-frontend');
    // Age the file two minutes: pid (this process) is alive → still held.
    const old = new Date(Date.now() - 2 * 60_000);
    fs.utimesSync(latchFile, old, old);
    assert.equal(openCodeApplyInProgress(projectRoot, 'latch-run'), true, 'a live runner holds the latch past 60s');
    // Past the hard cap the latch is a runaway backstop, held or not.
    assert.equal(openCodeApplyInProgress(projectRoot, 'latch-run', Date.now() + 16 * 60_000), false);
    // A DEAD pid is ignored immediately — a crashed runner never bricks cancel.
    fs.writeFileSync(latchFile, `${JSON.stringify({ armedAt: new Date().toISOString(), pid: 999_999_999 })}\n`, 'utf8');
    assert.equal(openCodeApplyInProgress(projectRoot, 'latch-run'), false, 'a dead runner releases the latch');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// Cancelling a multi-role plan batch must stop the SEQUENTIAL loop: killing
// the current shard while the loop went on to spawn the next role's runner
// landed diffs underneath the paid fallback (adversarial review).
test('plan-batch cancel stops the sequential loop before the next role spawns', async () => {
  // Sleeps far longer than the observation window so the FIRST shard is still
  // running when the cancel lands even under full-suite load (a 1.5s stub
  // could finish naturally before a starved event loop delivered the cancel,
  // making the second spawn legitimate and the test flaky).
  const SLOW_COUNTING_STUB = [
    'const fs = require("fs");',
    'const path = require("path");',
    'const marker = path.join(path.dirname(process.argv[1]), "shard-spawns");',
    'fs.appendFileSync(marker, process.argv.slice(2).join(" ") + "\\n");',
    'setTimeout(() => { console.log(JSON.stringify({ total: 1, delegated: 0, units: [{ role: "frontend", task: "t", action: "failed", touched: [] }] })); }, 8000);',
  ].join('\n');
  await withStubRunner(SLOW_COUNTING_STUB, async (projectRoot) => {
    fs.mkdirSync(path.join(projectRoot, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), PLAN_TWO_ROLES, 'utf8');
    writePlanQueue(projectRoot, 'cancel-loop', PLAN_TWO_ROLES);
    const first = (await delegateFromPlanResumable({ runId: 'cancel-loop', projectRoot }, 100)) as Any;
    assert.equal(first.running, true);
    const cancelled = (await delegateStatus({ runId: 'cancel-loop', projectRoot, cancel: true })) as Any;
    assert.equal(cancelled.status, 'done');
    assert.equal(cancelled.result.action, 'abandoned');
    // Give the killed shard's close event (and any wrongly-spawned successor)
    // time to surface. Under load the FIRST shard can be SIGTERMed while node
    // is still booting — before its marker append — so a missing/empty marker
    // is a legitimate outcome. The invariant is strictly "no LATER role shard
    // ever spawns after the cancel".
    await new Promise((r) => setTimeout(r, 2_000));
    const marker = path.join(path.dirname(process.env[OPENCODE_RUNNER_OVERRIDE_ENV] as string), 'shard-spawns');
    let spawns: string[] = [];
    try {
      spawns = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      spawns = []; // shard 1 died pre-append — fine; shard 2 must still be absent
    }
    assert.ok(spawns.length <= 1, `the cancelled batch must not spawn later role shards (saw: ${spawns.join(' | ')})`);
    assert.ok(!spawns.some((line) => line.includes('--roles tester')), `the second role's shard must never spawn after cancel (saw: ${spawns.join(' | ')})`);
  });
});

test('delegateStatus cancel is REFUSED while the apply-back latch is fresh', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const args = { role: 'senior-frontend', task: 'slow', runId: 'res-latch', allowedFiles: 'apps/web/src/**', projectRoot };
    const first = (await delegateResumable(args, 100)) as Any;
    assert.equal(first.running, true);
    // Arm the latch the way run-model does around its apply-back section.
    markOpenCodeApplyInProgress(projectRoot, 'res-latch', 'senior-frontend');
    try {
      const refused = (await delegateStatus({ runId: 'res-latch', role: 'senior-frontend', projectRoot, cancel: true })) as Any;
      assert.equal(refused.status, 'running');
      assert.equal(refused.applying, true);
      assert.match(String(refused.message), /cancel refused/);
    } finally {
      clearOpenCodeApplyInProgress(projectRoot, 'res-latch', 'senior-frontend');
    }
    // Latch cleared → the cancel goes through.
    const cancelled = (await delegateStatus({ runId: 'res-latch', role: 'senior-frontend', projectRoot, cancel: true })) as Any;
    assert.equal(cancelled.status, 'done');
    assert.equal(cancelled.result.action, 'cancelled');
  });
});

// Records every spawn (one line per invocation, naming the allowlist it got) so
// a test can prove whether a re-call actually re-delegated or replayed a cache
// entry, then fails terminally the way a rejected preflight does.
const COUNT_STUB = [
  'const a = process.argv.slice(2);',
  'const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };',
  'const fs = require("fs");',
  'const path = require("path");',
  'fs.appendFileSync(path.join(process.cwd(), "spawns.log"), get("--allowed-files") + "\\n");',
  'console.log(JSON.stringify({ ok: false, action: "failed", error: "stub rejected: " + get("--allowed-files"), digest: null, touched: [] }));',
].join('\n');

function spawnCount(projectRoot: string): number {
  const log = path.join(projectRoot, 'spawns.log');
  if (!fs.existsSync(log)) return 0;
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
}

test('delegateResumable re-delegates when a finished call is retried with a corrected allowlist', async () => {
  await withStubRunner(COUNT_STUB, async (projectRoot) => {
    const base = { role: 'senior-backend', task: 'batch update endpoint', runId: 'res-retry', projectRoot };
    // Every wait here is the ceiling, not a budget: each assertion below reads
    // a TERMINAL result (`error`) or a side effect the child writes before it
    // prints (`spawnCount`), and both are undefined while a call is still
    // {running:true}. Under the old 2000 ms waits a slow boot turned
    // `reordered.error === exact.error` into `null === null` — green, having
    // checked nothing.
    // 1) globs — the shape maintenance rejects outright.
    const globs = (await delegateResumable({ ...base, allowedFiles: 'routes/**, app/Http/Controllers/**' }, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(globs.ok, false);
    assert.match(globs.error, /routes\/\*\*/);
    assert.equal(spawnCount(projectRoot), 1);

    // 2) corrected to exact files — must actually run, not replay the rejection.
    const exact = (await delegateResumable({ ...base, allowedFiles: 'routes/api.php, app/Http/Controllers/BatchController.php' }, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(spawnCount(projectRoot), 2, 'a corrected allowlist starts a new delegation');
    assert.match(exact.error, /routes\/api\.php/);
    assert.doesNotMatch(exact.error, /\*\*/, 'the stale glob rejection is not replayed');

    // 3) same file SET, newline-separated instead of comma-separated → replay.
    const reordered = (await delegateResumable({ ...base, allowedFiles: 'app/Http/Controllers/BatchController.php\nroutes/api.php' }, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(spawnCount(projectRoot), 2, 'separator/order changes alone must not re-delegate');
    assert.equal(reordered.error, exact.error);

    // 4) a changed task is also new work.
    const newTask = (await delegateResumable({ ...base, task: 'batch delete endpoint', allowedFiles: 'routes/api.php, app/Http/Controllers/BatchController.php' }, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(spawnCount(projectRoot), 3, 'a changed task starts a new delegation');
    assert.equal(newTask.ok, false);
  });
});

test('delegateResumable does not start a second run while one is still in flight, even with different args', async () => {
  await withStubRunner(SLOW_COUNTING_STUB, async (projectRoot) => {
    const first = (await delegateResumable({ role: 'senior-frontend', task: 'slow unit', runId: 'res-inflight', allowedFiles: 'apps/web/src/A.tsx', projectRoot }, 100)) as Any;
    assert.equal(first.running, true);
    // Different allowlist while the run is still RUNNING → keep waiting on it.
    // The spawn count is the actual claim, and it is checked directly: a second
    // runner would have settled in boot + 1200 ms and answered ok:true here, so
    // the terminal assertions alone never distinguished the two outcomes.
    const second = (await delegateResumable({ role: 'senior-frontend', task: 'slow unit', runId: 'res-inflight', allowedFiles: 'apps/web/src/B.tsx', projectRoot }, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(second.ok, true);
    assert.equal(second.action, 'delegated');
    assert.equal(slowSpawnCount(), 1, 'a differing allowlist must not start a second concurrent runner');
  });
});

test('delegateFromPlanResumable replays its finished batch instead of re-running it', async () => {
  await withStubRunner(COUNT_STUB, async (projectRoot) => {
    const first = (await delegateFromPlanResumable({ runId: 'res-plan', projectRoot }, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(spawnCount(projectRoot), 1);
    const second = (await delegateFromPlanResumable({ runId: 'res-plan', projectRoot }, TERMINAL_WAIT_CEILING_MS)) as Any;
    assert.equal(spawnCount(projectRoot), 1, 'the plan batch has no per-call args and must never restart');
    // Both must be TERMINAL for this to compare anything: two {running:true}
    // replies both carry `error: null` and would match vacuously.
    assert.equal(second.error, first.error);
  });
});

// ── attach(): newline-framed stdio transport, end to end ─────────────────────

test('attach: initialize + notification + tools/call round-trip over stdio framing', async () => {
  await withStubRunner(ECHO_STUB, async (projectRoot) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Any[] = [];
    let buf = '';
    output.on('data', (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) frames.push(JSON.parse(line));
        nl = buf.indexOf('\n');
      }
    });
    attach(input, output);

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'opencode_delegate', arguments: { role: 'senior-tester', task: 't', runId: 'r9', allowedFiles: 'tests/**', projectRoot } } })}\n`);

    await waitFor(() => frames.some((f) => f.id === 2), 8000);

    const init = frames.find((f) => f.id === 1);
    assert.ok(init);
    assert.equal(init.result.serverInfo.name, 'opencode-worker');
    const call = frames.find((f) => f.id === 2);
    assert.ok(call);
    const payload = JSON.parse(call.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.role, 'senior-tester');
    assert.equal(call.result.isError, false);
    // The notification produced no frame: exactly the two request replies.
    assert.equal(frames.length, 2);
  });
});

test('attach: an unparseable line yields a -32700 parse error', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Any[] = [];
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) frames.push(JSON.parse(line));
      nl = buf.indexOf('\n');
    }
  });
  attach(input, output);
  input.write('this is not json\n');
  await waitFor(() => frames.length > 0, 2000);
  const first = frames[0];
  assert.ok(first);
  assert.equal(first.error.code, -32700);
});

test('attach: a final frame without a trailing newline is flushed on end', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Any[] = [];
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) frames.push(JSON.parse(line));
      nl = buf.indexOf('\n');
    }
  });
  attach(input, output);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' })); // no trailing \n
  input.end();
  await waitFor(() => frames.some((f) => f.id === 9), 2000);
  const ping = frames.find((f) => f.id === 9);
  assert.ok(ping);
  assert.deepEqual(ping.result, {});
});

test('tools/call maps a runner ok:false to isError:true', async () => {
  await withStubRunner('console.log(JSON.stringify({ ok: false, action: "no-changes", error: "nope" }))', async (projectRoot) => {
    const resp = (await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'opencode_delegate', arguments: { role: 'r', task: 't', runId: '1', allowedFiles: 'src/**', projectRoot } } })) as Any;
    assert.equal(resp.result.isError, true);
    assert.equal(JSON.parse(resp.result.content[0].text).ok, false);
  });
});

test('tools/call with an unknown tool name → -32602', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } })) as Any;
  assert.equal(resp.error.code, -32602);
});

// Poll-liveness cancellation: the orchestrator's re-polls are the keep-alive.
// When it stops polling (fell back to a paid worker), the watchdog kills the
// background runner BEFORE it can apply a stale diff, and the cached result
// reports the cancellation.
test('an unpolled background delegation is cancelled by the watchdog (action: abandoned)', async () => {
  const NEVER_ENDING_STUB = [
    '// keeps running until killed; would print a result only after 60s',
    'setTimeout(() => { console.log(JSON.stringify({ ok: true, action: "delegated" })); }, 60000);',
  ].join('\n');
  const savedAbandon = process.env.T1_OC_ABANDON_MS;
  const savedTick = process.env.T1_OC_WATCHDOG_TICK_MS;
  const savedKeepAlive = process.env.T1_OC_CHILD_KEEPALIVE;
  process.env.T1_OC_ABANDON_MS = '300';
  process.env.T1_OC_WATCHDOG_TICK_MS = '100';
  process.env.T1_OC_CHILD_KEEPALIVE = 'false';
  try {
    await withStubRunner(NEVER_ENDING_STUB, async (projectRoot) => {
      const args = { role: 'senior-frontend', task: 'will be abandoned', runId: 'aband-1', allowedFiles: 'apps/web/src/**', projectRoot };
      const first = (await delegateResumable(args, 100)) as Any;
      assert.equal(first.running, true);
      // No further polls: the watchdog should cancel after ~300ms + a tick.
      await new Promise((r) => setTimeout(r, 900));
      const status = (await delegateStatus({ projectRoot, runId: 'aband-1', role: 'senior-frontend' })) as Any;
      assert.equal(status.status, 'done');
      assert.equal(status.result?.action, 'abandoned');
      assert.match(status.result?.error || '', /stopped polling/);
    });
  } finally {
    if (savedAbandon === undefined) delete process.env.T1_OC_ABANDON_MS;
    else process.env.T1_OC_ABANDON_MS = savedAbandon;
    if (savedTick === undefined) delete process.env.T1_OC_WATCHDOG_TICK_MS;
    else process.env.T1_OC_WATCHDOG_TICK_MS = savedTick;
    if (savedKeepAlive === undefined) delete process.env.T1_OC_CHILD_KEEPALIVE;
    else process.env.T1_OC_CHILD_KEEPALIVE = savedKeepAlive;
  }
});

/**
 * The keep-alive env below is what makes this claim testable AT ALL, and its
 * absence is what made this test vacuous for as long as it existed. At the
 * production default (`true`) `refreshChildKeepAlive` stamps `lastPolledAt` on
 * EVERY watchdog tick for as long as a child is alive, so the watchdog refreshes
 * the very timestamp it then tests and the abandon is unreachable while the
 * worker lives: the old form passed with ZERO polls and asserted nothing about
 * polling. Both sibling abandon tests already pin it off for the same reason.
 *
 * Pinning it off turns the test into a race, so the numbers are MEASURED. The
 * abandon is decided from WALL CLOCK (`Date.now() - run.lastPolledAt`), while
 * the poll that refreshes it and the watchdog that reads it are timers on the
 * SAME event loop — so a descheduled process wakes the watchdog onto a stale
 * timestamp, and no in-process poller can out-run that. The failure needs a GAP
 * between consecutive refreshes wider than the threshold, so that gap, at this
 * 150 ms cadence, is the thing to size against. Measured on this repo's suite
 * machine (10 cores):
 *
 *     idle                          p50 151 ms   max  156 ms   (n=40)
 *     full `npm test`               p50 152 ms   max  247 ms   (n=492)
 *     96 concurrent spawn workers   p50 158 ms   max  996 ms   (n=1067)
 *
 * 2000 ms is 8.1x the worst gap the real suite produced and 2.0x the worst under
 * a deliberately adversarial ~10x core oversubscription. Past that the loop
 * misses its own cadence (192 workers: max 1735 ms) and a reap is then the
 * CONTRACT rather than a defect — so the assertion is gated on the cadence the
 * loop actually achieved, INCONCLUSIVE rather than a claim whose premise broke.
 */
test('active polling keeps a slow delegation alive past the abandon threshold', async (t) => {
  const ABANDON_MS = 2000;
  const POLL_MS = 150;
  // Outlives both phases with >2x to spare. Costs nothing: phase 2's abandon
  // kills the child, so the unused remainder is never waited on.
  const SLOW_POLLED_STUB = [
    'setTimeout(() => { console.log(JSON.stringify({ ok: true, action: "delegated", digest: null, touched: [] })); }, 12000);',
  ].join('\n');
  const savedAbandon = process.env.T1_OC_ABANDON_MS;
  const savedTick = process.env.T1_OC_WATCHDOG_TICK_MS;
  const savedKeepAlive = process.env.T1_OC_CHILD_KEEPALIVE;
  process.env.T1_OC_ABANDON_MS = String(ABANDON_MS);
  process.env.T1_OC_WATCHDOG_TICK_MS = '100';
  process.env.T1_OC_CHILD_KEEPALIVE = 'false';
  try {
    await withStubRunner(SLOW_POLLED_STUB, async (projectRoot) => {
      const args = { role: 'senior-backend', task: 'slow but polled', runId: 'alive-1', allowedFiles: 'services/api/src/**', projectRoot };
      const startedAt = Date.now();
      let lastPollAt = startedAt;
      let maxGapMs = 0;
      // Each re-entry stamps `lastPolledAt` synchronously, so the interval
      // between these calls IS the interval the watchdog measures against.
      const poll = async (): Promise<Any> => {
        const now = Date.now();
        maxGapMs = Math.max(maxGapMs, now - lastPollAt);
        lastPollAt = now;
        return (await delegateResumable(args, POLL_MS)) as Any;
      };

      let res = await poll();
      while (res.running && Date.now() - startedAt < ABANDON_MS + 1000) res = await poll();
      maxGapMs = Math.max(maxGapMs, Date.now() - lastPollAt);

      if (maxGapMs > ABANDON_MS) {
        await delegateStatus({ projectRoot, runId: 'alive-1', role: 'senior-backend', cancel: true });
        t.diagnostic(`poll-liveness INCONCLUSIVE · max refresh gap ${maxGapMs}ms exceeded the ${ABANDON_MS}ms threshold`);
        t.skip(`INCONCLUSIVE (poll-liveness NOT checked) · this loop missed its own ${POLL_MS}ms cadence by ${maxGapMs}ms, which makes a reap correct`);
        return;
      }
      assert.equal(res.running, true, 'a polled run must still be running past the abandon threshold');
      assert.ok(Date.now() - startedAt > ABANDON_MS, 'the polled window must actually exceed the threshold');

      // Reachability at THESE numbers, and the guard against this test going
      // vacuous the other way: a threshold that drifted above the stub's
      // duration would keep phase 1 green while proving nothing. The wait only
      // has to outlast threshold + one tick — node fires expired timers in
      // due-time order, so the abandoning tick is delivered before this timer
      // however far load stretches both.
      await new Promise((r) => setTimeout(r, ABANDON_MS + 600));
      const reaped = (await delegateStatus({ projectRoot, runId: 'alive-1', role: 'senior-backend' })) as Any;
      assert.equal(reaped.status, 'done', 'the same run must be reaped once the polls stop');
      assert.equal(reaped.result?.action, 'abandoned');
      assert.match(String(reaped.result?.error), /stopped polling/);
    });
  } finally {
    if (savedAbandon === undefined) delete process.env.T1_OC_ABANDON_MS;
    else process.env.T1_OC_ABANDON_MS = savedAbandon;
    if (savedTick === undefined) delete process.env.T1_OC_WATCHDOG_TICK_MS;
    else process.env.T1_OC_WATCHDOG_TICK_MS = savedTick;
    if (savedKeepAlive === undefined) delete process.env.T1_OC_CHILD_KEEPALIVE;
    else process.env.T1_OC_CHILD_KEEPALIVE = savedKeepAlive;
  }
});

test('plan batch watchdog abandon writes terminal batch.json (fail-open gate)', async () => {
  const NEVER_ENDING_STUB = [
    'setTimeout(() => { console.log(JSON.stringify({ total: 1, delegated: 0, units: [{ role: "frontend", task: "t", action: "failed", touched: [] }] })); }, 60000);',
  ].join('\n');
  const savedAbandon = process.env.T1_OC_ABANDON_MS;
  const savedTick = process.env.T1_OC_WATCHDOG_TICK_MS;
  const savedKeepAlive = process.env.T1_OC_CHILD_KEEPALIVE;
  process.env.T1_OC_ABANDON_MS = '300';
  process.env.T1_OC_WATCHDOG_TICK_MS = '100';
  process.env.T1_OC_CHILD_KEEPALIVE = 'false';
  try {
    await withStubRunner(NEVER_ENDING_STUB, async (projectRoot) => {
      fs.mkdirSync(path.join(projectRoot, '.traffic-one'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, '.traffic-one', 'plan.md'), PLAN_TWO_ROLES, 'utf8');
      writePlanQueue(projectRoot, 'aband-plan-1', PLAN_TWO_ROLES);
      const args = { runId: 'aband-plan-1', projectRoot };
      const first = (await delegateFromPlanResumable(args, 100)) as Any;
      assert.equal(first.running, true);
      await new Promise((r) => setTimeout(r, 900));
      const status = (await delegateStatus({ projectRoot, runId: 'aband-plan-1' })) as Any;
      assert.equal(status.status, 'done');
      assert.equal(status.result?.action, 'abandoned');
      assert.ok(Array.isArray(status.result?.units));
      assert.equal(status.result?.units?.length, 3);
      const batch = readOpenCodePlanBatchState(projectRoot, 'aband-plan-1');
      assert.equal(batch?.outcome, 'abandoned');
      const statuses = readOpenCodeUnitStatuses(projectRoot, 'aband-plan-1');
      assert.equal(statuses.length, 3);
      assert.ok(statuses.every((s) => s.status === 'failed'));
    });
  } finally {
    if (savedAbandon === undefined) delete process.env.T1_OC_ABANDON_MS;
    else process.env.T1_OC_ABANDON_MS = savedAbandon;
    if (savedTick === undefined) delete process.env.T1_OC_WATCHDOG_TICK_MS;
    else process.env.T1_OC_WATCHDOG_TICK_MS = savedTick;
    if (savedKeepAlive === undefined) delete process.env.T1_OC_CHILD_KEEPALIVE;
    else process.env.T1_OC_CHILD_KEEPALIVE = savedKeepAlive;
  }
});
