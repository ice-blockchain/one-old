import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { startOnboardingServer, type RunningServer } from '../server';
import { completionSentinelExists } from '../../../shared/onboarding-server/registry';

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
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-routes-'));
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevTask = process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD = 'noop';
  if (committed) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(committed), 'utf8');
  }
  const server = await startOnboardingServer({ cwd: dir, token: 'secret', standalone: false, idleMs: 60_000 });
  try {
    await fn(server, dir);
  } finally {
    await server.close();
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevTask === undefined) delete process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD;
    else process.env.TRAFFIC_ONE_ONBOARDING_TASK_CMD = prevTask;
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

test('routes: answering steps advances; code-graph runs a task; complete writes the sentinel', async () => {
  await withServer(existing, async (server, cwd) => {
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
    assert.equal(completionSentinelExists(cwd), true);
  });
});

test('routes: invalid answer → 400; unknown task → 404', async () => {
  await withServer(existing, async (server) => {
    const bad = await call(server.port, 'POST', '/answer', { step: 'performance', value: 'turbo' });
    assert.equal(bad.status, 400);
    const missing = await call(server.port, 'GET', '/task/does-not-exist');
    assert.equal(missing.status, 404);
  });
});
