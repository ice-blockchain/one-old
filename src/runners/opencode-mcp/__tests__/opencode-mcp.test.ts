import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { attach, dispatch, parseRunnerResult, runDelegate, runDelegateFromPlan } from '../index';
import { OPENCODE_RUNNER_OVERRIDE_ENV } from '../../../config/opencode-mcp';

type Any = Record<string, any>;

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

test('tools/list advertises both delegation tools with their schemas', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as Any;
  const names = resp.result.tools.map((t: Any) => t.name).sort();
  assert.deepEqual(names, ['opencode_delegate', 'opencode_delegate_from_plan']);
  const del = resp.result.tools.find((t: Any) => t.name === 'opencode_delegate');
  assert.deepEqual(del.inputSchema.required, ['role', 'task', 'runId']);
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
  'console.log(JSON.stringify({ ok: true, action: "delegated", role: get("--role"), runId: get("--run-id"), task, cwd: process.cwd(), fromPlan: a.includes("--from-plan"), digest: null, touched: [] }));',
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
    const r = (await runDelegate({ role: 'senior-frontend', task: 'build the card', runId: 'run-123', projectRoot })) as Any;
    assert.equal(r.ok, true);
    assert.equal(r.role, 'senior-frontend');
    assert.equal(r.runId, 'run-123');
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
});

test('runDelegateFromPlan passes --from-plan + run-id', async () => {
  await withStubRunner(ECHO_STUB, async (projectRoot) => {
    const r = (await runDelegateFromPlan({ runId: 'rp1', projectRoot })) as Any;
    assert.equal(r.fromPlan, true);
    assert.equal(r.runId, 'rp1');
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
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'opencode_delegate', arguments: { role: 'senior-tester', task: 't', runId: 'r9', projectRoot } } })}\n`);

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
    const resp = (await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'opencode_delegate', arguments: { role: 'r', task: 't', runId: '1', projectRoot } } })) as Any;
    assert.equal(resp.result.isError, true);
    assert.equal(JSON.parse(resp.result.content[0].text).ok, false);
  });
});

test('tools/call with an unknown tool name → -32602', async () => {
  const resp = (await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } })) as Any;
  assert.equal(resp.error.code, -32602);
});
