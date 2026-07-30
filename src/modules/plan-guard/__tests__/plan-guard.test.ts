import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { libraryAllowlistGate } from '../handler';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function withProject(stateObj: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-plan-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(stateObj), 'utf8');
  try {
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: {}, tool: { class: 'shell' as ToolClass, rawName: 'Bash', command } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('web stack: denies a forbidden library install', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, (cwd) => {
    const r = libraryAllowlistGate(ctxFor(cwd, 'pnpm add mobx'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('mobx'));
  });
});

test('web stack: allows an approved library install', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add zod')).kind, 'noop');
  });
});

test('resolved shadcn adapter is allowed while a second UI system is denied', () => {
  withProject({ mode: 'new-project', stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @mui/material')).kind, 'deny');
  });
  withProject({ mode: 'new-project', stack: 'custom-frontend', frontend: 'vue' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn-vue')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn')).kind, 'deny');
  });
});

test('explicit or detected external UI library wins and blocks parallel shadcn', () => {
  withProject({
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'react-vite',
    uiLibrary: 'mui',
  }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @mui/material @emotion/react')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn')).kind, 'deny');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @chakra-ui/react')).kind, 'deny');
  });

  withProject({
    mode: 'existing-codebase',
    stack: 'custom-frontend',
    frontend: 'react-vite',
  }, (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0', vite: '7.0.0', '@mui/material': '7.0.0' },
    }));
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @mui/material')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn')).kind, 'deny');
  });
});

test('explicit framework-native choice rejects adding a component library', () => {
  withProject({
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'angular',
    uiLibrary: 'framework-native',
  }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add @angular/material')).kind, 'deny');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D shadcn')).kind, 'deny');
  });
});

test('ignores non-install commands', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm build')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'ls -la')).kind, 'noop');
  });
});

test('native stack: denies react-router-dom (Expo Router instead)', () => {
  withProject({ stack: 'custom-frontend', frontend: 'none', mobile: { framework: 'react-native-expo' } }, (cwd) => {
    const r = libraryAllowlistGate(ctxFor(cwd, 'pnpm add react-router-dom'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('Expo Router'));
  });
});

test('forbidden-library gate stands down inside the plugin authoring repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authoring-lib-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'gen', 'index.ts'), 'export {};\n', 'utf8');
    resetAuthoringRootCache();
    // mobx is denied in every end-user stack table; the authoring repo is exempt.
    assert.equal(libraryAllowlistGate(ctxFor(dir, 'pnpm add mobx')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(dir, 'pnpm add vitest')).kind, 'noop');
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('react/vite stack: allows vitest installs (Vitest is the web runner)', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D @vitest/coverage-v8')).kind, 'noop');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add vitest')).kind, 'noop');
  });
});

test('nextjs frontend: still allows vitest', () => {
  withProject({ stack: 'default', frontend: 'nextjs' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D @vitest/ui')).kind, 'noop');
  });
});

test('native stack: denies vitest (Jest is the native runner)', () => {
  withProject({ stack: 'custom-frontend', frontend: 'none', mobile: { framework: 'react-native-expo' } }, (cwd) => {
    const r = libraryAllowlistGate(ctxFor(cwd, 'pnpm add -D @vitest/coverage-v8'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('Jest'));
  });
});

// Stack-aware Next.js gating (ported behaviors from the legacy core-onboarding suite).
test('react/vite stack: denies next packages (Next.js not chosen)', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, (cwd) => {
    const r = libraryAllowlistGate(ctxFor(cwd, 'pnpm add next'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('NextAuth/Auth.js'));
  });
});

test('explicit nextjs frontend: allows next', () => {
  withProject({ stack: 'default', frontend: 'nextjs' }, (cwd) => {
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add next')).kind, 'noop');
  });
});

test('existing next dependency: allows next-auth', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }), 'utf8');
    assert.equal(libraryAllowlistGate(ctxFor(cwd, 'pnpm add next-auth')).kind, 'noop');
  });
});
