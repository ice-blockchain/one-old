import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { EventEmitter } from 'events';
import type { ClientRequest, IncomingMessage } from 'http';

import { DEFAULT_PUBLIC_ENDPOINT } from '../../../config/one-mcp';
import { ONE_MCP_REPORT, SAVE_MCP_REPORT, STATUS_FILE } from '../../../config/reporting';
import { clearPluginUseChoice, recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { mcpRequest } from '../lib';
import { prepareReport } from '../prepareReport';
import { runReport } from '../runReport';

interface SavedHome {
  HOME?: string;
  XDG_STATE_HOME?: string;
}

function isolateUserState(dir: string): () => void {
  const saved: SavedHome = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  process.env.HOME = path.join(dir, 'home');
  process.env.XDG_STATE_HOME = path.join(dir, 'state');
  return () => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved.XDG_STATE_HOME;
  };
}

function withProject(fn: (cwd: string) => void, pluginEnabled = true): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-net-'));
  const restoreUserState = isolateUserState(dir);
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  if (pluginEnabled) recordPluginUseChoice(dir, true, 'test');
  try {
    fn(dir);
  } finally {
    restoreUserState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withProjectAsync(
  fn: (cwd: string) => Promise<void>,
  pluginEnabled = true,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onemcp-net-'));
  const restoreUserState = isolateUserState(dir);
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  if (pluginEnabled) recordPluginUseChoice(dir, true, 'test');
  try {
    await fn(dir);
  } finally {
    restoreUserState();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('reporting defaults to active fire-and-forget mode', () => {
  assert.equal(ONE_MCP_REPORT, true);
  assert.equal(SAVE_MCP_REPORT, false);
});

test('mcpRequest sends an anonymous JSON-RPC POST', async () => {
  let captured: https.RequestOptions = {};
  const requestImpl = ((
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    captured = options;
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      setEncoding: () => response,
    }) as unknown as IncomingMessage;
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        callback(response);
        response.emit('data', '{"jsonrpc":"2.0","id":1,"result":{}}');
        response.emit('end');
      },
      destroy: () => request,
    }) as unknown as ClientRequest;
    return request;
  }) as unknown as typeof https.request;

  await mcpRequest(
    'https://example.test/public-mcp',
    { report_id: 'rep-anonymous' },
    100,
    requestImpl,
  );

  const headers = captured.headers as Record<string, string | number>;
  assert.equal(captured.method, 'POST');
  assert.equal(headers.authorization, undefined);
  assert.equal(typeof headers['content-length'], 'number');
});

test('runReport posts to DEFAULT_PUBLIC_ENDPOINT and never writes status in fire-and-forget mode', async () => {
  await withProjectAsync(async (cwd) => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { react: '18' } }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', '.one.json'),
      JSON.stringify({ 'one-uid': 'rep-default-endpoint' }),
      'utf8',
    );
    let postedEndpoint = '';
    let posted: unknown = null;

    const result = await runReport(cwd, {
      transport: async (endpoint, payload) => {
        postedEndpoint = endpoint;
        posted = payload;
        return 'ok';
      },
    });

    assert.equal(result.ok, true);
    assert.equal(postedEndpoint, DEFAULT_PUBLIC_ENDPOINT);
    assert.equal((posted as { report_id: string }).report_id, 'rep-default-endpoint');
    assert.equal(fs.existsSync(path.join(cwd, STATUS_FILE)), false);
  });
});

test('runReport keeps endpoint and transport as explicit test seams', async () => {
  await withProjectAsync(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', '.one.json'),
      JSON.stringify({ 'one-uid': 'rep-injected-endpoint' }),
      'utf8',
    );
    const endpoint = 'https://report.example.test/public-mcp';
    let seenEndpoint = '';

    const result = await runReport(cwd, {
      endpoint,
      transport: async (target) => {
        seenEndpoint = target;
        return 'ok';
      },
    });

    assert.equal(result.ok, true);
    assert.equal(seenEndpoint, endpoint);
  });
});

test('runReport returns transport failures without persisting a status file', async () => {
  await withProjectAsync(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', '.one.json'),
      JSON.stringify({ 'one-uid': 'rep-failed' }),
      'utf8',
    );

    const result = await runReport(cwd, {
      transport: async () => {
        throw new Error('boom');
      },
    });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /boom/);
    assert.equal(fs.existsSync(path.join(cwd, STATUS_FILE)), false);
  });
});

test('featureEnabled can disable prepareReport and runReport without side effects', async () => {
  await withProjectAsync(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    let called = false;

    assert.equal(
      prepareReport(cwd, { featureEnabled: false, spawn: false }).reason,
      'reporting-inactive',
    );
    const result = await runReport(cwd, {
      featureEnabled: false,
      transport: async () => {
        called = true;
      },
    });

    assert.equal(result.skipped, 'reporting-inactive');
    assert.equal(called, false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, STATUS_FILE)), false);
  });
});

test('prepareReport requires a real codebase, mints one-uid once, and supports spawn:false', () => {
  withProject((cwd) => {
    assert.equal(prepareReport(cwd, { spawn: false }).reason, 'no-codebase');
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');

    const first = prepareReport(cwd, { spawn: false });
    assert.equal(first.started, true);
    assert.equal(first.spawned, false);
    assert.equal(typeof first.reportId, 'string');
    assert.equal(fs.existsSync(path.join(cwd, STATUS_FILE)), false);

    const state = JSON.parse(
      fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(state['one-uid'], first.reportId);

    const second = prepareReport(cwd, { spawn: false });
    assert.equal(second.started, false);
    assert.equal(second.reason, 'already-registered');
    assert.equal(second.reportId, first.reportId);
  });
});

test('prepareReport and runReport require pluginUse.enabled exactly true', async () => {
  await withProjectAsync(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf8');
    assert.equal(
      prepareReport(cwd, { spawn: false }).reason,
      'plugin-use-not-enabled',
    );

    recordPluginUseChoice(cwd, false, 'test');
    assert.equal(
      prepareReport(cwd, { spawn: false }).reason,
      'plugin-use-not-enabled',
    );

    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', '.one.json'),
      JSON.stringify({ 'one-uid': 'rep-not-enabled' }),
      'utf8',
    );
    let called = false;
    const result = await runReport(cwd, {
      transport: async () => {
        called = true;
      },
    });

    assert.equal(result.skipped, 'plugin-use-not-enabled');
    assert.equal(called, false);

    clearPluginUseChoice(cwd);
  }, false);
});

test('runReport skips when one-uid is missing', async () => {
  await withProjectAsync(async (cwd) => {
    let called = false;
    const result = await runReport(cwd, {
      transport: async () => {
        called = true;
      },
    });

    assert.equal(result.skipped, 'missing-report-id');
    assert.equal(called, false);
  });
});
