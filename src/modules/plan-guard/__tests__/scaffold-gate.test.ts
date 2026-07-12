import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { SCAFFOLD_RE, scaffoldGate } from '../scaffold-gate';
import type { Ctx, HookInput, HostId, ToolClass } from '../../../core/types';

function withProject(state: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-scaffold-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writePlan(cwd: string): void {
  fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');
}

function ctxFor(cwd: string, command: string, host: HostId = 'windsurf'): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host, cwd, workspaceRoot: cwd, raw: {},
    tool: { class: 'shell' as ToolClass, rawName: 'run_command', command },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

const NEW_REACT_VITE = { mode: 'new-project', stack: 'default', frontend: 'react-vite', onboardingComplete: true };

test('SCAFFOLD_RE matches app scaffolders, not benign commands', () => {
  for (const cmd of [
    'npx create-next-app@latest learning-platform',
    'npx create-react-app app',
    'npm create vite@latest apps/web',
    'pnpm create next-app',
    'yarn create react-app x',
    'npx create-expo-app app',
    'nest new api',
    'ng new app',
    'vue create app',
  ]) {
    assert.ok(SCAFFOLD_RE.test(cmd), `expected scaffolder: ${cmd}`);
  }
  for (const cmd of ['npm install react', 'pnpm build', 'npm run dev', 'ls -la', 'git clone https://x/y']) {
    assert.ok(!SCAFFOLD_RE.test(cmd), `expected benign: ${cmd}`);
  }
});

test('scaffold gate: create-next-app on a React/Vite new project is denied (off-stack)', () => {
  withProject(NEW_REACT_VITE, (cwd) => {
    writePlan(cwd); // even with a plan, Next.js is off-stack
    const r = scaffoldGate(ctxFor(cwd, 'npx create-next-app@latest learning-platform --typescript'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(/React\/Vite|apps\/web/.test(r.reason));
  });
});

test('scaffold gate: create-react-app is denied (off-stack) on React/Vite', () => {
  withProject(NEW_REACT_VITE, (cwd) => {
    writePlan(cwd);
    assert.equal(scaffoldGate(ctxFor(cwd, 'npx create-react-app app')).kind, 'deny');
  });
});

test('scaffold gate: an on-stack scaffolder before plan.md is denied (architect-first)', () => {
  withProject(NEW_REACT_VITE, (cwd) => {
    const r = scaffoldGate(ctxFor(cwd, 'npm create vite@latest apps/web -- --template react-ts'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(/senior-architect|plan\.md/.test(r.reason));
  });
});

test('scaffold gate: Low/main-agent projects are told to write the plan locally, never to spawn Windsurf profiles', () => {
  withProject({
    ...NEW_REACT_VITE,
    team: { mode: 'main-agent' },
    performance: { level: 'low' },
  }, (cwd) => {
    const r = scaffoldGate(ctxFor(cwd, 'npm create vite@latest apps/web -- --template react-ts'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.match(r.reason, /Low\/main-agent mode/);
      assert.match(r.reason, /Do NOT call `run_subagent`/);
      assert.doesNotMatch(r.reason, /profile `senior-architect`/);
    }
  });
});

test('scaffold gate: an on-stack scaffolder AFTER plan.md exists is allowed', () => {
  withProject(NEW_REACT_VITE, (cwd) => {
    writePlan(cwd);
    assert.equal(scaffoldGate(ctxFor(cwd, 'npm create vite@latest apps/web -- --template react-ts')).kind, 'noop');
  });
});

test('scaffold gate: benign commands are ignored', () => {
  withProject(NEW_REACT_VITE, (cwd) => {
    assert.equal(scaffoldGate(ctxFor(cwd, 'npm run dev')).kind, 'noop');
    assert.equal(scaffoldGate(ctxFor(cwd, 'npm install zod')).kind, 'noop');
  });
});

test('scaffold gate: existing-codebase projects are not governed', () => {
  withProject({ mode: 'existing-codebase', stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(scaffoldGate(ctxFor(cwd, 'npx create-next-app@latest app')).kind, 'noop');
  });
});

test('scaffold gate: nextjs-frontend projects may scaffold Next.js', () => {
  withProject({ mode: 'new-project', stack: 'custom-stack', frontend: 'nextjs' }, (cwd) => {
    writePlan(cwd);
    assert.equal(scaffoldGate(ctxFor(cwd, 'npx create-next-app@latest app')).kind, 'noop');
  });
});

test('scaffold gate: NON-windsurf hosts are untouched (create-next-app noops)', () => {
  withProject(NEW_REACT_VITE, (cwd) => {
    for (const host of ['claude', 'cursor', 'codex', 'opencode'] as const) {
      assert.equal(scaffoldGate(ctxFor(cwd, 'npx create-next-app@latest app', host)).kind, 'noop', `host ${host} must noop`);
    }
  });
});
