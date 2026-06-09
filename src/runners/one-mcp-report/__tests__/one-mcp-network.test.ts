import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { prepareReport } from '../prepareReport';
import { runReport } from '../runReport';
import { SAVE_MCP_REPORT } from '../../../config/reporting';

const STATUS_REL = path.join('.traffic-one', 'one-mcp-report.json');

// On-disk status tracking is gated by SAVE_MCP_REPORT (fire-and-forget mode turns
// it off). The behavioral guarantees (POST happened, started/spawned, one-uid
// minted) hold regardless; only the persisted status file is conditional — so
// assert its contents only when saving is enabled.
function statusStatus(cwd: string): string {
  return JSON.parse(fs.readFileSync(path.join(cwd, STATUS_REL), 'utf8')).status;
}

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-net-'));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function withProjectAsync(fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-net-'));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function withFreshAuth(fn: (dir: string) => void): void {
  withProject((dir) => {
    const env = process.env;
    const prevAuth = env.TRAFFIC_ONE_AUTH_STATE_PATH;
    const prevEndpoint = env.TRAFFIC_ONE_MCP_KEY_ENDPOINT;
    env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
    env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
    fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: new Date().toISOString(),
    }), 'utf8');
    try { fn(dir); } finally {
      if (prevAuth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevAuth;
      if (prevEndpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = prevEndpoint;
    }
  });
}

test('runReport posts the queued report via an injected transport → status ok', async () => {
  await withProjectAsync(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }), 'utf8');
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'rep-1' }), 'utf8');
    fs.writeFileSync(path.join(cwd, STATUS_REL), JSON.stringify({ status: 'queued', reportId: 'rep-1' }), 'utf8');
    let posted: unknown = null;
    const r = await runReport(cwd, { transport: async (_e, payload) => { posted = payload; return 'ok'; } });
    assert.equal(r.ok, true);
    if (SAVE_MCP_REPORT) assert.equal(statusStatus(cwd), 'ok');
    assert.equal((posted as { report_id: string }).report_id, 'rep-1');
  });
});

test('runReport records a failed status when the transport rejects', async () => {
  await withProjectAsync(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'rep-2' }), 'utf8');
    fs.writeFileSync(path.join(cwd, STATUS_REL), JSON.stringify({ status: 'queued', reportId: 'rep-2' }), 'utf8');
    const r = await runReport(cwd, { transport: async () => { throw new Error('boom'); } });
    assert.equal(r.ok, false);
    if (SAVE_MCP_REPORT) assert.equal(statusStatus(cwd), 'failed');
  });
});

test('runReport skips when no report id / not queued', async () => {
  await withProjectAsync(async (cwd) => {
    assert.equal((await runReport(cwd, { transport: async () => 'x' })).skipped, 'missing-report-id');
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'rep-3' }), 'utf8');
    // The "not-queued" gate only runs when on-disk tracking is enabled; with
    // saving off the report has no queued status to check and proceeds to POST.
    const r = await runReport(cwd, { transport: async () => 'x' });
    if (SAVE_MCP_REPORT) assert.equal(r.skipped, 'not-queued');
    else assert.equal(r.ok, true);
  });
});

test('prepareReport skips when disabled / unauthenticated / no codebase, and queues when ready', () => {
  withFreshAuth((cwd) => {
    process.env.TRAFFIC_ONE_DISABLE_ONE_MCP = '1';
    assert.equal(prepareReport(cwd, { spawn: false }).reason, 'disabled');
    delete process.env.TRAFFIC_ONE_DISABLE_ONE_MCP;
    // authed but no codebase markers → no-codebase
    assert.equal(prepareReport(cwd, { spawn: false }).reason, 'no-codebase');
    // real codebase → queues (no spawn) + writes status + mints one-uid
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    const r = prepareReport(cwd, { spawn: false });
    assert.equal(r.started, true);
    assert.equal(r.spawned, false);
    if (SAVE_MCP_REPORT) assert.equal(statusStatus(cwd), 'queued');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.ok(typeof state['one-uid'] === 'string' && state['one-uid'].length > 0);
  });
});

test('prepareReport returns auth-required without an auth state WHEN auth is enforced', () => {
  withProject((cwd) => {
    const env = process.env;
    const prev = env.TRAFFIC_ONE_AUTH_STATE_PATH;
    const prevEnforce = env.TRAFFIC_ONE_AUTH;
    env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(cwd, 'no-auth.json');
    env.TRAFFIC_ONE_AUTH = 'on'; // enforce → a real token is required
    try {
      fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
      assert.equal(prepareReport(cwd, { spawn: false }).reason, 'auth-required');
    } finally {
      if (prev === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prev;
      if (prevEnforce === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevEnforce;
    }
  });
});

test('prepareReport treats auth-not-enforced (AUTH_ENABLED off) as authenticated — bypass for dev/tests', () => {
  withProject((cwd) => {
    const env = process.env;
    const prev = env.TRAFFIC_ONE_AUTH_STATE_PATH;
    const prevEnforce = env.TRAFFIC_ONE_AUTH;
    env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(cwd, 'no-auth.json');
    env.TRAFFIC_ONE_AUTH = 'off'; // not enforced → treated as authenticated
    try {
      fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
      const r = prepareReport(cwd, { spawn: false });
      assert.notEqual(r.reason, 'auth-required'); // bypassed → proceeds to mint
      assert.equal(r.started, true);
    } finally {
      if (prev === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prev;
      if (prevEnforce === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevEnforce;
    }
  });
});

test('prepareReport can queue an explicit architect PLAN_READY report without auth', () => {
  withProject((cwd) => {
    const env = process.env;
    const prev = env.TRAFFIC_ONE_AUTH_STATE_PATH;
    env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(cwd, 'no-auth.json');
    try {
      fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
      const r = prepareReport(cwd, {
        spawn: false,
        trigger: 'architect PLAN_READY',
        allowUnauthenticated: true,
      });
      assert.equal(r.started, true);
      assert.equal(r.spawned, false);
      if (SAVE_MCP_REPORT) {
        const status = JSON.parse(fs.readFileSync(path.join(cwd, STATUS_REL), 'utf8'));
        assert.equal(status.status, 'queued');
        assert.equal(status.trigger, 'architect PLAN_READY');
      }
      const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
      assert.ok(typeof state['one-uid'] === 'string' && state['one-uid'].length > 0);
    } finally {
      if (prev === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prev;
    }
  });
});
