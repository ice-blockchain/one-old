import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { preGraphifyHint, resetGraphifyHintThrottle } from '../handler';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function withGraphProject(opts: { provider?: string; makeArtefact?: boolean; authed?: boolean }, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-graphify-'));
  const env = process.env;
  const saved = { auth: env.TRAFFIC_ONE_AUTH_STATE_PATH, endpoint: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH };
  const provider = opts.provider || 'graphify';
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  // one.json (the TRAFFIC_ONE_AUTH_STATE_PATH alias) holds BOTH the auth session and
  // the machine-wide codeGraphProvider now.
  const oneSettings: Record<string, unknown> = { version: 1, codeGraphProvider: provider };
  if (opts.authed !== false) {
    oneSettings.auth = {
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
    };
  }
  fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify(oneSettings), 'utf8');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ stack: 'default' }), 'utf8');
  if (opts.makeArtefact) {
    if (provider === 'gitnexus') {
      fs.mkdirSync(path.join(dir, '.traffic-one', '.gitnexus'), { recursive: true });
    } else {
      fs.mkdirSync(path.join(dir, '.traffic-one', 'graphify-out'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '# graph\n', 'utf8');
    }
  }
  resetGraphifyHintThrottle();
  try {
    fn(dir);
  } finally {
    if (saved.auth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = saved.auth;
    if (saved.endpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = saved.endpoint;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: {}, tool: { class: 'search' as ToolClass, rawName: 'Grep' } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('graphify hint fires when the gitnexus artefact is present + authed', () => {
  withGraphProject({ provider: 'gitnexus', makeArtefact: true }, (cwd) => {
    const r = preGraphifyHint(ctxFor(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(r.context.includes('[graph: gitnexus]'));
  });
});

test('graphify hint is silent when the artefact is missing', () => {
  withGraphProject({ provider: 'graphify', makeArtefact: false }, (cwd) => {
    assert.equal(preGraphifyHint(ctxFor(cwd)).kind, 'noop');
  });
});

test('graphify hint is silent when unauthenticated', () => {
  withGraphProject({ provider: 'gitnexus', makeArtefact: true, authed: false }, (cwd) => {
    assert.equal(preGraphifyHint(ctxFor(cwd)).kind, 'noop');
  });
});

test('graphify hint throttles to once per cwd per process', () => {
  withGraphProject({ provider: 'graphify', makeArtefact: true }, (cwd) => {
    assert.equal(preGraphifyHint(ctxFor(cwd)).kind, 'context');
    assert.equal(preGraphifyHint(ctxFor(cwd)).kind, 'noop');
  });
});
