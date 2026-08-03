import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { postBuildPageSpeed } from '../handler';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { compileArchitecture } from '../../../shared/architecture-contract';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { compileVerificationContract } from '../../../shared/verification-contract';

function withProject(stateObj: Record<string, unknown>, authed: boolean, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pagespeed-'));
  const env = process.env;
  const saved = { state: env.TRAFFIC_ONE_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, auth: env.TRAFFIC_ONE_AUTH };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_AUTH = '1';
  if (authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH, JSON.stringify({
      schemaVersion: 3,
      auth: {
        version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
      },
      hosts: {},
    }), 'utf8');
  }
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(stateObj), 'utf8');
  try {
    fn(dir);
  } finally {
    if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    if (saved.auth === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = saved.auth;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string, raw: Record<string, unknown> = {}, workspaceRoot?: string): Ctx {
  const input: HookInput = {
    event: 'PostToolUse',
    host: 'claude',
    cwd,
    raw,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    tool: { class: 'shell' as ToolClass, rawName: 'Bash', command },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function writePerformanceContract(cwd: string, state: Record<string, unknown>, runId = 'R'): void {
  const architecture = compileArchitecture(cwd, runId, state, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'app-shell', name: 'App', kind: 'app-shell' }],
  });
  compileVerificationContract(cwd, runId, state, architecture, {
    changedPaths: [],
    performanceRisk: true,
  });
}

test('page-speed fires after a web production build (authed)', () => {
  const state = { stack: 'default', frontend: 'react-vite', currentRunId: 'R' };
  withProject(state, true, (cwd) => {
    writePerformanceContract(cwd, state);
    const r = postBuildPageSpeed(ctxFor(cwd, 'pnpm build'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('Lighthouse'));
      assert.equal(r.systemMessage, 'traffic-one page-speed gate pending after build');
    }
  });
});

test('page-speed is silent after a normal web build without a performance contract', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('page-speed resolves a nested monorepo build to the onboarded workspace root', () => {
  const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', currentRunId: 'R' };
  withProject(state, true, (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }), 'utf8');
    const app = path.join(cwd, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{}', 'utf8');
    writePerformanceContract(cwd, state);

    const r = postBuildPageSpeed(ctxFor(app, 'pnpm build', {}, cwd));

    assert.equal(r.kind, 'context');
    assert.equal(fs.existsSync(path.join(app, '.traffic-one')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', '.once', 'pagespeed-advisory-nosession')), true);
  });
});

test('page-speed surfaces structured Lighthouse blocked statuses after runner calls', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const runnerOutput = [
      'BUILD_ID_PRESENT',
      JSON.stringify({
        status: 'blocked:sandbox',
        error: 'listen EPERM: operation not permitted "127.0.0.1"',
      }, null, 2),
    ].join('\n');
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${runnerOutput}\n` } },
    ));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('blocked:sandbox'));
      assert.ok(r.context.includes('"127.0.0.1"'));
      assert.ok(r.context.includes('unverified'));
      assert.equal(r.systemMessage, 'traffic-one page-speed blocked:sandbox');
    }
  });
});

test('a lighthouse runner call sweeps superseded reports for that route', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    // Retention capped these correctly, but its only trigger was SessionStart,
    // so a run that measured repeatedly kept every pair (observed 10co: six
    // pairs for `home`, a 14.7 MB reports dir, inside one session).
    const t1 = '.traffic' + '-one';
    const lh = path.join(cwd, t1, 'reports', 'lighthouse');
    fs.mkdirSync(lh, { recursive: true });
    fs.writeFileSync(path.join(cwd, t1, 'retention.json'),
      JSON.stringify({ lighthouseKeepPerRoute: 2, orphanTtlDays: 3650 }), 'utf8');
    const stamps = [
      '2026-07-30T12-15-01-470Z', '2026-07-30T12-16-24-888Z',
      '2026-07-30T12-56-15-024Z', '2026-07-30T13-06-29-955Z',
    ];
    for (const stamp of stamps) {
      for (const ext of ['report.json', 'report.html']) {
        fs.writeFileSync(path.join(lh, `home-${stamp}.${ext}`), 'x', 'utf8');
      }
    }
    assert.equal(fs.readdirSync(lh).length, 8);

    postBuildPageSpeed(ctxFor(cwd, 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /'));

    const left = fs.readdirSync(lh).sort();
    assert.equal(left.length, 4, 'the sweep runs at the lighthouse boundary, not only at SessionStart');
    for (const stamp of stamps.slice(-2)) {
      assert.ok(left.includes(`home-${stamp}.report.json`), 'the newest pairs survive');
    }
  });
});

test('codex blocked:sandbox prescribes the escalated re-run recipe', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const runnerOutput = JSON.stringify({
      status: 'blocked:sandbox',
      error: 'listen EPERM: operation not permitted "127.0.0.1"',
    }, null, 2);
    const input: HookInput = {
      event: 'PostToolUse', host: 'codex', cwd,
      raw: { tool_response: { stdout: `${runnerOutput}\n` } },
      tool: { class: 'shell' as ToolClass, rawName: 'exec_command', command: 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /' },
    };
    const r = postBuildPageSpeed({ input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('require_escalated'), 'codex sandbox denial names the escalation recipe');
      assert.ok(r.context.includes('lighthouse-runner.cjs'));
      assert.ok(r.context.includes('unverified'));
    }
    // non-codex hosts keep the plain unverified message
    const claude = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${runnerOutput}\n` } },
    ));
    assert.equal(claude.kind, 'context');
    if (claude.kind === 'context') assert.ok(!claude.context.includes('require_escalated'));
  });
});

test('page-speed surfaces a Lighthouse runner timeout as blocked:timeout', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const runnerOutput = JSON.stringify({
      status: 'blocked:timeout',
      error: 'Lighthouse runner exceeded 240000ms budget; aborting to avoid a silent hang.',
    }, null, 2);
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${runnerOutput}\n` } },
    ));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('blocked:timeout'));
      assert.ok(r.context.includes('unverified'));
      assert.equal(r.systemMessage, 'traffic-one page-speed blocked:timeout');
    }
  });
});

test('page-speed is silent for non-build commands', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm install build-tools')).kind, 'noop');
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'ls')).kind, 'noop');
  });
});

test('page-speed is silent for React Native-only stacks', () => {
  withProject({ stack: 'custom-frontend', frontend: 'none', mobile: { framework: 'react-native-expo' } }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('page-speed stands down when pluginUse is declined', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    recordPluginUseChoice(cwd, false, 'test');
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('page-speed is silent when unauthenticated AND auth is enforced', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, false, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});
