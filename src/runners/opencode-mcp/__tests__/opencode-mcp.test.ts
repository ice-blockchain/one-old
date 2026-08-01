import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { attach, delegateFromPlanResumable, delegateResumable, delegateStatus, dispatch, parseRunnerResult, planQueueRoles, runDelegate, runDelegateFromPlan } from '../index';
import { clearOpenCodeApplyInProgress, markOpenCodeApplyInProgress, parsePlanDelegationUnits, readOpenCodePlanBatchState } from '../../../shared/opencode-roles';
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

test('delegateResumable returns {running} within the wait window, then the result on re-call (idempotent)', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const args = { role: 'senior-frontend', task: 'slow unit', runId: 'res-1', allowedFiles: 'apps/web/src/**', projectRoot };
    const first = (await delegateResumable(args, 200)) as Any; // run sleeps 1200ms > 200ms window
    assert.equal(first.running, true);
    assert.equal(first.runId, 'res-1');
    assert.equal(first.ok, undefined); // not a terminal result → not a fallback signal
    await new Promise((r) => setTimeout(r, 1400)); // let the background run finish
    const second = (await delegateResumable(args, 200)) as Any;
    assert.equal(second.ok, true);
    assert.equal(second.action, 'delegated');
    assert.equal(second.role, 'senior-frontend');
    const third = (await delegateResumable(args, 50)) as Any; // cached → idempotent
    assert.equal(third.ok, true);
  });
});

test('delegateResumable re-call without a task keeps waiting on the in-flight run', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const start = (await delegateResumable({ role: 'senior-tester', task: 'slow', runId: 'res-3', allowedFiles: 'apps/web/e2e/**', projectRoot }, 100)) as Any;
    assert.equal(start.running, true);
    // re-call omits task — must NOT error ("task is required") since the run exists
    const again = (await delegateResumable({ role: 'senior-tester', runId: 'res-3', projectRoot, task: '' } as any, 1500)) as Any;
    assert.equal(again.ok, true);
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
    await delegateResumable(args, 2000); // wait for completion
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
    // One long status wait collects the terminal result — no re-poll loop.
    const st = (await delegateStatus({ runId: 'res-wait', role: 'senior-frontend', projectRoot, waitMs: 3000 })) as Any;
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
    // 1) globs — the shape maintenance rejects outright.
    const globs = (await delegateResumable({ ...base, allowedFiles: 'routes/**, app/Http/Controllers/**' }, 2000)) as Any;
    assert.equal(globs.ok, false);
    assert.match(globs.error, /routes\/\*\*/);
    assert.equal(spawnCount(projectRoot), 1);

    // 2) corrected to exact files — must actually run, not replay the rejection.
    const exact = (await delegateResumable({ ...base, allowedFiles: 'routes/api.php, app/Http/Controllers/BatchController.php' }, 2000)) as Any;
    assert.equal(spawnCount(projectRoot), 2, 'a corrected allowlist starts a new delegation');
    assert.match(exact.error, /routes\/api\.php/);
    assert.doesNotMatch(exact.error, /\*\*/, 'the stale glob rejection is not replayed');

    // 3) same file SET, newline-separated instead of comma-separated → replay.
    const reordered = (await delegateResumable({ ...base, allowedFiles: 'app/Http/Controllers/BatchController.php\nroutes/api.php' }, 2000)) as Any;
    assert.equal(spawnCount(projectRoot), 2, 'separator/order changes alone must not re-delegate');
    assert.equal(reordered.error, exact.error);

    // 4) a changed task is also new work.
    const newTask = (await delegateResumable({ ...base, task: 'batch delete endpoint', allowedFiles: 'routes/api.php, app/Http/Controllers/BatchController.php' }, 2000)) as Any;
    assert.equal(spawnCount(projectRoot), 3, 'a changed task starts a new delegation');
    assert.equal(newTask.ok, false);
  });
});

test('delegateResumable does not start a second run while one is still in flight, even with different args', async () => {
  await withStubRunner(SLOW_STUB, async (projectRoot) => {
    const first = (await delegateResumable({ role: 'senior-frontend', task: 'slow unit', runId: 'res-inflight', allowedFiles: 'apps/web/src/A.tsx', projectRoot }, 100)) as Any;
    assert.equal(first.running, true);
    // Different allowlist while the run is still RUNNING → keep waiting on it.
    const second = (await delegateResumable({ role: 'senior-frontend', task: 'slow unit', runId: 'res-inflight', allowedFiles: 'apps/web/src/B.tsx', projectRoot }, 2000)) as Any;
    assert.equal(second.ok, true);
    assert.equal(second.action, 'delegated');
  });
});

test('delegateFromPlanResumable replays its finished batch instead of re-running it', async () => {
  await withStubRunner(COUNT_STUB, async (projectRoot) => {
    const first = (await delegateFromPlanResumable({ runId: 'res-plan', projectRoot }, 2000)) as Any;
    assert.equal(spawnCount(projectRoot), 1);
    const second = (await delegateFromPlanResumable({ runId: 'res-plan', projectRoot }, 2000)) as Any;
    assert.equal(spawnCount(projectRoot), 1, 'the plan batch has no per-call args and must never restart');
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

test('active polling keeps a slow delegation alive past the abandon threshold', async () => {
  const savedAbandon = process.env.T1_OC_ABANDON_MS;
  const savedTick = process.env.T1_OC_WATCHDOG_TICK_MS;
  process.env.T1_OC_ABANDON_MS = '400';
  process.env.T1_OC_WATCHDOG_TICK_MS = '100';
  try {
    await withStubRunner(SLOW_STUB, async (projectRoot) => { // stub finishes after 1200ms > abandon 400ms
      const args = { role: 'senior-backend', task: 'slow but polled', runId: 'alive-1', allowedFiles: 'services/api/src/**', projectRoot };
      let res = (await delegateResumable(args, 150)) as Any;
      // Poll repeatedly (each poll refreshes the keep-alive) until terminal.
      for (let i = 0; i < 20 && res.running; i++) {
        res = (await delegateResumable(args, 150)) as Any;
      }
      assert.equal(res.ok, true, 'polled run must complete, not be abandoned');
      assert.equal(res.action, 'delegated');
    });
  } finally {
    if (savedAbandon === undefined) delete process.env.T1_OC_ABANDON_MS;
    else process.env.T1_OC_ABANDON_MS = savedAbandon;
    if (savedTick === undefined) delete process.env.T1_OC_WATCHDOG_TICK_MS;
    else process.env.T1_OC_WATCHDOG_TICK_MS = savedTick;
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
