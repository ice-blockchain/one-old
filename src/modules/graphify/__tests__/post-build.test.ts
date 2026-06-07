import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  __resetCodeGraphBootstraps,
  __setCodeGraphBootstraps,
  postBuildCodeGraphHint,
} from '../index';
import type { CodeGraphResult } from '../post-build';
import type { Ctx, HookInput } from '../../../core/types';

function withProject(
  opts: { provider?: string; mode?: string; onboardingComplete?: boolean; authed?: boolean; freshArtefact?: boolean },
  fn: (cwd: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cgpost-'));
  const env = process.env;
  const saved = { auth: env.TRAFFIC_ONE_AUTH_STATE_PATH, endpoint: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  // one.json (the TRAFFIC_ONE_AUTH_STATE_PATH alias) holds BOTH the auth session and
  // the machine-wide codeGraphProvider now.
  const oneSettings: Record<string, unknown> = { version: 1 };
  if (opts.authed !== false) {
    oneSettings.auth = {
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
    };
  }
  if (opts.provider) oneSettings.codeGraphProvider = opts.provider;
  fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify(oneSettings), 'utf8');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const state: Record<string, unknown> = {
    stack: 'default',
    mode: opts.mode ?? 'new-project',
    onboardingComplete: opts.onboardingComplete ?? true,
  };
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  if (opts.freshArtefact) {
    if (opts.provider === 'gitnexus') fs.mkdirSync(path.join(dir, '.gitnexus'), { recursive: true });
    else { fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true }); fs.writeFileSync(path.join(dir, 'graphify-out', 'GRAPH_REPORT.md'), '# g\n', 'utf8'); }
  }
  try {
    fn(dir);
  } finally {
    __resetCodeGraphBootstraps();
    if (saved.auth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = saved.auth;
    if (saved.endpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = saved.endpoint;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string): Ctx {
  const input: HookInput = {
    event: 'PostToolUse', host: 'claude', cwd, raw: {},
    tool: { class: 'shell', rawName: 'Bash', command },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('post-build code-graph hint is silent for non-build commands', () => {
  withProject({ provider: 'graphify' }, (cwd) => {
    __setCodeGraphBootstraps({ graphify: () => { throw new Error('should not run'); } });
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'ls -la')).kind, 'noop');
  });
});

test('post-build code-graph hint is silent when unauthenticated', () => {
  withProject({ provider: 'graphify', authed: false }, (cwd) => {
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
  });
});

test('post-build code-graph hint is silent outside new-project / incomplete onboarding', () => {
  withProject({ provider: 'graphify', mode: 'existing-codebase' }, (cwd) => {
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
  });
  withProject({ provider: 'graphify', onboardingComplete: false }, (cwd) => {
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
  });
});

test('post-build code-graph hint is silent without a provider', () => {
  withProject({}, (cwd) => {
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
  });
});

test('post-build code-graph hint is silent when the artefact is fresh', () => {
  withProject({ provider: 'graphify', freshArtefact: true }, (cwd) => {
    __setCodeGraphBootstraps({ graphify: () => { throw new Error('should not run'); } });
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
  });
});

test('post-build code-graph hint runs graphify bootstrap + emits the success banner', () => {
  withProject({ provider: 'graphify' }, (cwd) => {
    let called = 0;
    __setCodeGraphBootstraps({ graphify: () => { called += 1; return { ok: true, action: 'installed-pipx', durationMs: 1200 }; } });
    const r = postBuildCodeGraphHint(ctxFor(cwd, 'pnpm build'));
    assert.equal(called, 1);
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('[graphify] Codebase graph built'));
      assert.ok(r.context.includes('installed `graphifyy` via pipx'));
    }
  });
});

test('post-build code-graph hint surfaces the gitnexus nvm-install-needed branch', () => {
  withProject({ provider: 'gitnexus' }, (cwd) => {
    const result: CodeGraphResult = { ok: false, action: 'nvm-install-needed', error: 'GitNexus needs Node >=22.' };
    __setCodeGraphBootstraps({ gitnexus: () => result });
    const r = postBuildCodeGraphHint(ctxFor(cwd, 'npm run build'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('Node 22 not installed yet'));
      assert.ok(r.context.includes('No user-run install command is required'));
    }
  });
});

test('post-build code-graph hint stamps the cooldown so a second build is throttled', () => {
  withProject({ provider: 'graphify' }, (cwd) => {
    let called = 0;
    __setCodeGraphBootstraps({ graphify: () => { called += 1; return { ok: true, action: 'used-existing', durationMs: 5 }; } });
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'context');
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
    assert.equal(called, 1);
  });
});

test('post-build rebuilds a fresh-but-EMPTY gitnexus graph (files:0) — reindex after scaffold', () => {
  withProject({ provider: 'gitnexus', freshArtefact: true }, (cwd) => {
    // graph built pre-scaffold on the empty project: fresh mtime, but 0 files.
    fs.writeFileSync(path.join(cwd, '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 0, nodes: 0 } }), 'utf8');
    let called = 0;
    __setCodeGraphBootstraps({ gitnexus: () => { called += 1; return { ok: true, action: 'used-managed', durationMs: 5 }; } });
    const r = postBuildCodeGraphHint(ctxFor(cwd, 'npm run build'));
    assert.equal(called, 1); // rebuilt despite the fresh mtime, because the graph was empty
    assert.equal(r.kind, 'context');
  });
});

test('post-build skips a fresh NON-empty gitnexus graph (no needless rebuild)', () => {
  withProject({ provider: 'gitnexus', freshArtefact: true }, (cwd) => {
    fs.writeFileSync(path.join(cwd, '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 12, nodes: 40 } }), 'utf8');
    let called = 0;
    __setCodeGraphBootstraps({ gitnexus: () => { called += 1; return { ok: true, action: 'used-managed', durationMs: 5 }; } });
    const r = postBuildCodeGraphHint(ctxFor(cwd, 'npm run build'));
    assert.equal(called, 0); // fresh + non-empty → noop
    assert.equal(r.kind, 'noop');
  });
});
