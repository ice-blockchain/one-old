import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';

import { startOnboardingServer, type RunningServer } from '../server';

type Json = Record<string, unknown> | null;

interface Resp {
  status: number;
  json: Json;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function call(port: number, method: string, p: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method,
        headers: { 'x-t1-token': 'secret', ...(payload ? { 'content-type': 'application/json' } : {}) },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let json: Json = null;
          try {
            json = text ? (JSON.parse(text) as Json) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(
  committed: Record<string, unknown> | null,
  fn: (server: RunningServer, cwd: string) => Promise<void>,
  taskCmd: string = 'noop',
  trafficHost: string = 'claude',
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-routes-'));
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  const prevTask = process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD;
  const prevAuth = process.env.TRAFFIC_ONE_AUTH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // code-graph answers write the machine-wide provider — isolate one.json.
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD = taskCmd;
  process.env.TRAFFIC_ONE_AUTH = 'off';
  if (committed) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(committed), 'utf8');
  }
  const server = await startOnboardingServer({ cwd: dir, token: 'secret', standalone: false, idleMs: 60_000, trafficHost });
  try {
    await fn(server, dir);
  } finally {
    await server.close();
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevTask === undefined) delete process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD;
    else process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD = prevTask;
    if (prevAuth === undefined) delete process.env.TRAFFIC_ONE_AUTH;
    else process.env.TRAFFIC_ONE_AUTH = prevAuth;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const existing = {
  mode: 'existing-codebase',
  stack: 'minimal',
  frontend: 'none',
  backend: 'other',
  realtime: 'none',
  confirmed: true,
  onboardingComplete: true,
  confirmedAt: '2026-01-01T00:00:00Z',
};

async function waitForTask(port: number, id: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const res = await call(port, 'GET', `/task/${id}`);
    const status = rec(res.json).status;
    if (res.status === 200 && (status === 'done' || status === 'error')) return String(status);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 'timeout';
}

test('routes: /state reports the first unresolved step', async () => {
  await withServer(existing, async (server) => {
    const res = await call(server.port, 'GET', '/state');
    assert.equal(res.status, 200);
    assert.equal(rec(res.json).mode, 'existing-codebase');
    assert.equal(rec(res.json).step, 'open-code');
    assert.equal(rec(res.json).done, false);
  });
});

test('routes: validated API key persists through the server ctx.env custom state path', async () => {
  const authServer = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // The intake probe is `tools/call` on `updates` — the authenticated
      // mount's only tool — not `tools/list`. Pinned here as well as in
      // runners/auth/__tests__/validate-key.test.ts because this is the route
      // that decides whether a key gets STORED.
      const envelope = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const probesUpdates = envelope.method === 'tools/call' && envelope.params?.name === 'updates';
      if (req.headers.authorization !== 'Bearer sk-custom' || !probesUpdates) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'invalid_token' } }));
        return;
      }
      const payload = { items: [], nextCursor: null, hasMore: false };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload },
      }));
    });
  });
  await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-routes-auth-env-'));
  const customState = path.join(dir, 'custom', 'one.json');
  const processState = path.join(dir, 'process', 'one.json');
  const previousProcessState = process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.TRAFFIC_ONE_STATE_PATH = processState;
  const authPort = (authServer.address() as AddressInfo).port;
  const customEnv = {
    ...process.env,
    TRAFFIC_ONE_AUTH: '1',
    TRAFFIC_ONE_STATE_PATH: customState,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json'),
  } as NodeJS.ProcessEnv;
  const server = await startOnboardingServer({
    cwd: dir,
    env: customEnv,
    authEndpoint: `http://127.0.0.1:${authPort}/mcp`,
    token: 'secret',
    standalone: false,
    idleMs: 60_000,
  });

  try {
    const malformed = await call(server.port, 'POST', '/answer', { step: 'api-key', value: 'sk-custom' });
    assert.equal(malformed.status, 400);
    assert.equal(fs.existsSync(customState), false, 'non-canonical answer shape writes no auth state');

    const rejected = await call(server.port, 'POST', '/answer', { step: 'api-key', value: { apiKey: 'sk-rejected' } });
    assert.equal(rejected.status, 400);
    assert.equal(fs.existsSync(customState), false, 'rejected validation writes no auth state');

    const response = await call(server.port, 'POST', '/answer', { step: 'api-key', value: { apiKey: 'sk-custom' } });
    assert.equal(response.status, 200);
    const stored = JSON.parse(fs.readFileSync(customState, 'utf8')) as Record<string, unknown>;
    assert.equal((stored.auth as Record<string, unknown>).apiKey, 'sk-custom');
    assert.equal(fs.existsSync(processState), false, 'server never falls back to process.env state');
  } finally {
    await server.close();
    await new Promise<void>((resolve) => authServer.close(() => resolve()));
    if (previousProcessState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = previousProcessState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('routes: answering steps advances; code-graph runs a task; complete acknowledges', async () => {
  await withServer(existing, async (server) => {
    let res = await call(server.port, 'POST', '/answer', { step: 'open-code', value: 'enable' });
    assert.equal(res.status, 200);
    assert.equal(rec(rec(res.json).view).step, 'performance');

    res = await call(server.port, 'POST', '/answer', { step: 'performance', value: 'low' });
    assert.equal(rec(rec(res.json).view).step, 'code-graph');

    res = await call(server.port, 'POST', '/answer', { step: 'code-graph', value: 'gitnexus' });
    assert.equal(res.status, 200);
    const taskId = rec(res.json).taskId;
    assert.equal(typeof taskId, 'string');
    assert.equal(rec(rec(res.json).view).done, true);

    const taskStatus = await waitForTask(server.port, String(taskId));
    assert.equal(taskStatus, 'done');

    const done = await call(server.port, 'POST', '/complete');
    assert.equal(done.status, 200);
    assert.equal(rec(done.json).ok, true);
  });
});

test('routes: a failed install task surfaces as error so the frontend withholds /complete', async () => {
  await withServer(existing, async (server) => {
    await call(server.port, 'POST', '/answer', { step: 'open-code', value: 'enable' });
    await call(server.port, 'POST', '/answer', { step: 'performance', value: 'low' });
    const res = await call(server.port, 'POST', '/answer', { step: 'code-graph', value: 'gitnexus' });
    const taskId = rec(res.json).taskId;
    assert.equal(typeof taskId, 'string');

    // Completion truth is the state predicates; the frontend re-offers the
    // install on 'error' instead of proceeding to POST /complete.
    const taskStatus = await waitForTask(server.port, String(taskId));
    assert.equal(taskStatus, 'error');
  }, 'fail');
});

test('routes: NDJSON progress snapshots surface on /task/:id while running; the final action still parses', async () => {
  // A stand-in for the toolchain runner's progress protocol: one snapshot line,
  // a pause (the poll window), a second snapshot, then the result summary as the
  // LAST stdout line — exactly the interleaving actionFrom must tolerate.
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't1-progress-')), 'task.cjs');
  const snapshot = (status: string) => JSON.stringify({
    t1Progress: {
      steps: [
        { id: 'graph-install', label: 'Installing GitNexus', status, weight: 40 },
        { id: 'graph-scan', label: 'Scanning your codebase', status: status === 'done' ? 'done' : 'pending', weight: 30 },
      ],
    },
  });
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    `fs.writeSync(1, ${JSON.stringify(snapshot('running'))} + '\\n');`,
    'setTimeout(() => {',
    `  fs.writeSync(1, ${JSON.stringify(snapshot('done'))} + '\\n');`,
    "  fs.writeSync(1, JSON.stringify({ action: 'progress-script' }) + '\\n');",
    '}, 400);',
  ].join('\n'), 'utf8');
  try {
    await withServer(existing, async (server) => {
      await call(server.port, 'POST', '/answer', { step: 'open-code', value: 'not_now' });
      await call(server.port, 'POST', '/answer', { step: 'performance', value: 'low' });
      const res = await call(server.port, 'POST', '/answer', { step: 'code-graph', value: 'gitnexus' });
      const taskId = String(rec(res.json).taskId);

      // The first snapshot must be visible WHILE the task is still running —
      // that is the entire point of the progress channel.
      let sawRunningProgress = false;
      for (let i = 0; i < 100; i += 1) {
        const poll = await call(server.port, 'GET', `/task/${taskId}`);
        const state = rec(poll.json);
        if (state.status !== 'running') break;
        const steps = rec(state.progress).steps;
        if (Array.isArray(steps) && steps.length === 2) {
          assert.equal(rec(steps[0]).id, 'graph-install');
          assert.equal(rec(steps[0]).status, 'running');
          sawRunningProgress = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(sawRunningProgress, true);

      assert.equal(await waitForTask(server.port, taskId), 'done');
      const done = await call(server.port, 'GET', `/task/${taskId}`);
      // Last-line parsing: the summary action survives the interleaved
      // progress lines, and the final snapshot stays on the finished task.
      assert.equal(rec(done.json).action, 'progress-script');
      const doneSteps = rec(rec(done.json).progress).steps;
      assert.ok(Array.isArray(doneSteps) && doneSteps.every((s) => rec(s).status === 'done'));
    }, script);
  } finally {
    fs.rmSync(path.dirname(script), { recursive: true, force: true });
  }
});

test('routes: /complete acknowledges regardless of the server active host', async () => {
  await withServer(existing, async (server) => {
    const done = await call(server.port, 'POST', '/complete');
    assert.equal(done.status, 200);
    assert.equal(rec(done.json).ok, true);
  }, 'noop', 'cursor');
});

test('routes: /verify-toolchain reports the provider + a boolean graphMissing', async () => {
  await withServer(existing, async (server) => {
    await call(server.port, 'POST', '/answer', { step: 'open-code', value: 'not_now' });
    await call(server.port, 'POST', '/answer', { step: 'performance', value: 'low' });
    await call(server.port, 'POST', '/answer', { step: 'code-graph', value: 'graphify' });

    const res = await call(server.port, 'GET', '/verify-toolchain');
    assert.equal(res.status, 200);
    assert.equal(rec(res.json).provider, 'graphify');
    assert.equal(typeof rec(res.json).graphMissing, 'boolean');
    assert.equal(rec(res.json).ok, !rec(res.json).graphMissing);
  });
});

test('routes: invalid answer → 400; unknown task → 404', async () => {
  await withServer(existing, async (server) => {
    await call(server.port, 'POST', '/answer', { step: 'open-code', value: 'not_now' });
    const bad = await call(server.port, 'POST', '/answer', { step: 'performance', value: 'turbo' });
    assert.equal(bad.status, 400);
    const missing = await call(server.port, 'GET', '/task/does-not-exist');
    assert.equal(missing.status, 404);
  });
});
