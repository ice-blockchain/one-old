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
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';

function withProject(
  opts: { provider?: string; mode?: string; onboardingComplete?: boolean; authed?: boolean; freshArtefact?: boolean },
  fn: (cwd: string) => void,
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cgpost-'));
  const env = process.env;
  const saved = { state: env.TRAFFIC_ONE_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, auth: env.TRAFFIC_ONE_AUTH };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_AUTH = '1';
  const oneSettings: Record<string, unknown> = { schemaVersion: 3, hosts: {} };
  if (opts.authed !== false) {
    oneSettings.auth = {
      version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
    };
  }
  if (opts.provider) oneSettings.codeGraphProvider = opts.provider;
  fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH, JSON.stringify(oneSettings), 'utf8');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const state: Record<string, unknown> = {
    stack: 'default',
    mode: opts.mode ?? 'new-project',
    onboardingComplete: opts.onboardingComplete ?? true,
  };
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  if (opts.freshArtefact) {
    if (opts.provider === 'gitnexus') fs.mkdirSync(path.join(dir, '.traffic-one', '.gitnexus'), { recursive: true });
    else { fs.mkdirSync(path.join(dir, '.traffic-one', 'graphify-out'), { recursive: true }); fs.writeFileSync(path.join(dir, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '# g\n', 'utf8'); }
  }
  try {
    fn(dir);
  } finally {
    __resetCodeGraphBootstraps();
    if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    if (saved.auth === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = saved.auth;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string, workspaceRoot?: string): Ctx {
  const input: HookInput = {
    event: 'PostToolUse', host: 'claude', cwd, raw: {},
    ...(workspaceRoot ? { workspaceRoot } : {}),
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

test('post-build code-graph hint stands down when pluginUse is declined', () => {
  withProject({ provider: 'graphify' }, (cwd) => {
    recordPluginUseChoice(cwd, false, 'test');
    __setCodeGraphBootstraps({ graphify: () => { throw new Error('should not run'); } });
    assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
  });
});

test('post-build code-graph hint is silent when unauthenticated AND auth is enforced', () => {
  withProject({ provider: 'graphify', authed: false }, (cwd) => {
    const saved = process.env.TRAFFIC_ONE_AUTH;
    process.env.TRAFFIC_ONE_AUTH = '1';
    try {
      assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'noop');
    } finally {
      if (saved === undefined) delete process.env.TRAFFIC_ONE_AUTH;
      else process.env.TRAFFIC_ONE_AUTH = saved;
    }
  });
});

// The explicit enforcement override remains useful for hermetic development.
test('post-build code-graph hint runs without canonical auth when enforcement is explicitly off', () => {
  withProject({ provider: 'graphify', authed: false }, (cwd) => {
    const saved = process.env.TRAFFIC_ONE_AUTH;
    process.env.TRAFFIC_ONE_AUTH = '0';
    try {
      __setCodeGraphBootstraps({ graphify: () => ({ ok: true, action: 'installed', report: 'r', error: null, durationMs: 100 }) as unknown as CodeGraphResult });
      assert.equal(postBuildCodeGraphHint(ctxFor(cwd, 'npm run build')).kind, 'context');
    } finally {
      if (saved === undefined) delete process.env.TRAFFIC_ONE_AUTH;
      else process.env.TRAFFIC_ONE_AUTH = saved;
    }
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

test('post-build code-graph bootstrap resolves a nested monorepo build to the workspace root', () => {
  withProject({ provider: 'graphify' }, (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }), 'utf8');
    const app = path.join(cwd, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{}', 'utf8');
    let bootstrapCwd = '';
    __setCodeGraphBootstraps({
      graphify: (root) => {
        bootstrapCwd = root;
        return { ok: true, action: 'installed-pipx', durationMs: 10 };
      },
    });

    const r = postBuildCodeGraphHint(ctxFor(app, 'pnpm build', cwd));

    assert.equal(r.kind, 'context');
    assert.equal(bootstrapCwd, cwd);
    assert.equal(fs.existsSync(path.join(app, '.traffic-one')), false);
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

test('post-build code-graph hint bypasses cooldown when source is newer than the graph', () => {
  withProject({ provider: 'gitnexus', freshArtefact: true }, (cwd) => {
    const memoryDir = ['.traffic', '-one'].join('');
    const graphDir = path.join(cwd, memoryDir, '.gitnexus');
    fs.writeFileSync(path.join(graphDir, 'meta.json'), JSON.stringify({ stats: { files: 12, nodes: 40 } }), 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(graphDir, old, old);
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'late-fix.ts'), 'export const late = true;\n', 'utf8');
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH || '', JSON.stringify({ graphifyLastHintedAt: new Date().toISOString() }), 'utf8');

    let called = 0;
    __setCodeGraphBootstraps({ gitnexus: () => { called += 1; return { ok: true, action: 'used-managed', durationMs: 5 }; } });

    const r = postBuildCodeGraphHint(ctxFor(cwd, 'npm run build'));
    assert.equal(called, 1);
    assert.equal(r.kind, 'context');
  });
});

test('post-build rebuilds a fresh-but-EMPTY gitnexus graph (files:0) — reindex after scaffold', () => {
  withProject({ provider: 'gitnexus', freshArtefact: true }, (cwd) => {
    // graph built pre-scaffold on the empty project: fresh mtime, but 0 files.
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 0, nodes: 0 } }), 'utf8');
    let called = 0;
    __setCodeGraphBootstraps({ gitnexus: () => { called += 1; return { ok: true, action: 'used-managed', durationMs: 5 }; } });
    const r = postBuildCodeGraphHint(ctxFor(cwd, 'npm run build'));
    assert.equal(called, 1); // rebuilt despite the fresh mtime, because the graph was empty
    assert.equal(r.kind, 'context');
  });
});

test('post-build skips a fresh NON-empty gitnexus graph (no needless rebuild)', () => {
  withProject({ provider: 'gitnexus', freshArtefact: true }, (cwd) => {
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.gitnexus', 'meta.json'), JSON.stringify({ stats: { files: 12, nodes: 40 } }), 'utf8');
    let called = 0;
    __setCodeGraphBootstraps({ gitnexus: () => { called += 1; return { ok: true, action: 'used-managed', durationMs: 5 }; } });
    const r = postBuildCodeGraphHint(ctxFor(cwd, 'npm run build'));
    assert.equal(called, 0); // fresh + non-empty → noop
    assert.equal(r.kind, 'noop');
  });
});
