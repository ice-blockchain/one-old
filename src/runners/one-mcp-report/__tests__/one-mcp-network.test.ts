import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { EventEmitter } from 'events';
import type { ClientRequest, IncomingMessage } from 'http';

import { prepareReport } from '../prepareReport';
import { runReport } from '../runReport';
import { isLocallyAuthenticated, readSimpleAuth, writeSimpleAuth } from '../../../shared/auth';
import { readOneSettings, writeOneSection } from '../../../shared/one-settings';
import { SAVE_MCP_REPORT } from '../../../config/reporting';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { mcpRequest } from '../lib';

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
  const previous = process.env.TRAFFIC_ONE_AUTH;
  process.env.TRAFFIC_ONE_AUTH = 'off';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  try { fn(dir); } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_AUTH;
    else process.env.TRAFFIC_ONE_AUTH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withProjectAsync(fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-net-'));
  const previous = process.env.TRAFFIC_ONE_AUTH;
  process.env.TRAFFIC_ONE_AUTH = 'off';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  try { await fn(dir); } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_AUTH;
    else process.env.TRAFFIC_ONE_AUTH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withFreshAuth(fn: (dir: string) => void): void {
  withProject((dir) => {
    const env = process.env;
    const prevAuth = env.TRAFFIC_ONE_STATE_PATH;
    const prevEndpoint = env.TRAFFIC_ONE_MCP_KEY_ENDPOINT;
    const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    const prevFlag = env.TRAFFIC_ONE_AUTH;
    env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
    env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'preferences.json');
    env.TRAFFIC_ONE_AUTH = '1';
    // The sole wizard-validated record lives under one.json.auth.
    writeOneSection('auth', {
      version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
    }, env);
    try { fn(dir); } finally {
      if (prevAuth === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevAuth;
      if (prevEndpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = prevEndpoint;
      if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
      if (prevFlag === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevFlag;
    }
  });
}

test('mcpRequest sends canonical one.json.auth as the Bearer credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-bearer-'));
  const env = {
    ...process.env,
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_AUTH: '1',
  } as NodeJS.ProcessEnv;
  let captured: https.RequestOptions = {};
  const requestImpl = ((
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    captured = options;
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setEncoding: () => response,
    }) as unknown as IncomingMessage;
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        callback(response);
        response.emit('data', '{"result":{}}');
        response.emit('end');
      },
      destroy: () => request,
    }) as unknown as ClientRequest;
    return request;
  }) as unknown as typeof https.request;

  try {
    writeSimpleAuth('sk-canonical-bearer', env);
    await mcpRequest('https://example.test/mcp', { report_id: 'rep-bearer' }, 100, env, requestImpl);
    const headers = captured.headers as Record<string, string | number>;
    assert.equal(headers.authorization, 'Bearer sk-canonical-bearer');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

test('runReport: 401 and 403 always delete only canonical auth and reopen the wizard', async () => {
  await withProjectAsync(async (cwd) => {
    const env = process.env;
    const saved = { state: env.TRAFFIC_ONE_STATE_PATH, flag: env.TRAFFIC_ONE_AUTH };
    const processState = path.join(cwd, 'process-one.json');
    const customState = path.join(cwd, 'custom-one.json');
    env.TRAFFIC_ONE_STATE_PATH = processState;
    env.TRAFFIC_ONE_AUTH = '1';
    const customEnv = {
      ...env,
      TRAFFIC_ONE_STATE_PATH: customState,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'custom-preferences.json'),
      TRAFFIC_ONE_AUTH: '1',
    } as NodeJS.ProcessEnv;
    try {
      writeSimpleAuth('sk-process-store', env);
      writeOneSection('codeGraphProvider', 'graphify', customEnv);
      fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
      for (const authFlag of ['1', 'off']) {
        customEnv.TRAFFIC_ONE_AUTH = authFlag;
        for (const statusCode of [401, 403]) {
          const reportId = `rep-${authFlag}-${statusCode}`;
          writeSimpleAuth(`sk-rejected-${authFlag}-${statusCode}`, customEnv);
          assert.equal(isLocallyAuthenticated(customEnv), true);
          fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': reportId }), 'utf8');
          fs.writeFileSync(path.join(cwd, STATUS_REL), JSON.stringify({ status: 'queued', reportId }), 'utf8');
          const transport = async () => {
            const error = new Error(`HTTP ${statusCode}`) as Error & { statusCode?: number };
            error.statusCode = statusCode;
            throw error;
          };
          const result = await runReport(cwd, { transport, env: customEnv });
          assert.equal(result.ok, false);
          assert.equal(isLocallyAuthenticated(customEnv), false, `${statusCode} invalidates auth with TRAFFIC_ONE_AUTH=${authFlag}`);
          const settings = readOneSettings(customEnv);
          assert.equal(settings.auth, undefined);
          assert.equal(settings.codeGraphProvider, 'graphify');
          assert.equal(readSimpleAuth(env)?.apiKey, 'sk-process-store', 'process.env store remains untouched');
        }
      }
    } finally {
      if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
      if (saved.flag === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = saved.flag;
    }
  });
});

test('runReport fails closed before transport when canonical auth is missing', async () => {
  await withProjectAsync(async (cwd) => {
    const env = {
      ...process.env,
      TRAFFIC_ONE_AUTH: 'on',
      TRAFFIC_ONE_STATE_PATH: path.join(cwd, 'one.json'),
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
    } as NodeJS.ProcessEnv;
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'rep-no-auth' }), 'utf8');
    fs.writeFileSync(path.join(cwd, STATUS_REL), JSON.stringify({ status: 'queued', reportId: 'rep-no-auth' }), 'utf8');
    let called = false;

    const result = await runReport(cwd, {
      env,
      transport: async () => {
        called = true;
        return 'ok';
      },
    });

    assert.equal(result.skipped, 'auth-required');
    assert.equal(called, false);
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

test('prepareReport and runReport stand down when pluginUse is declined', async () => {
  let pending: Promise<void> | null = null;
  withFreshAuth((cwd) => {
    recordPluginUseChoice(cwd, false, 'test');
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    assert.equal(prepareReport(cwd, { spawn: false }).reason, 'plugin-use-declined');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false);

    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'rep-declined' }), 'utf8');
    fs.writeFileSync(path.join(cwd, STATUS_REL), JSON.stringify({ status: 'queued', reportId: 'rep-declined' }), 'utf8');
    let called = false;
    pending = runReport(cwd, { transport: async () => { called = true; return 'ok'; } }).then((result) => {
      assert.equal(result.skipped, 'plugin-use-declined');
      assert.equal(called, false);
    });
  });
  await pending;
});

test('prepareReport returns auth-required without an auth state WHEN auth is enforced', () => {
  withProject((cwd) => {
    const env = process.env;
    const prev = env.TRAFFIC_ONE_STATE_PATH;
    const prevEnforce = env.TRAFFIC_ONE_AUTH;
    env.TRAFFIC_ONE_STATE_PATH = path.join(cwd, 'one.json');
    env.TRAFFIC_ONE_AUTH = 'on'; // enforce → a real token is required
    try {
      fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
      assert.equal(prepareReport(cwd, { spawn: false }).reason, 'auth-required');
    } finally {
      if (prev === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prev;
      if (prevEnforce === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevEnforce;
    }
  });
});

test('prepareReport honors an explicit auth-enforcement opt-out for dev/tests', () => {
  withProject((cwd) => {
    const env = process.env;
    const prev = env.TRAFFIC_ONE_STATE_PATH;
    const prevEnforce = env.TRAFFIC_ONE_AUTH;
    env.TRAFFIC_ONE_STATE_PATH = path.join(cwd, 'one.json');
    env.TRAFFIC_ONE_AUTH = 'off'; // not enforced → treated as authenticated
    try {
      fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
      const r = prepareReport(cwd, { spawn: false });
      assert.notEqual(r.reason, 'auth-required'); // bypassed → proceeds to mint
      assert.equal(r.started, true);
    } finally {
      if (prev === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prev;
      if (prevEnforce === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevEnforce;
    }
  });
});
