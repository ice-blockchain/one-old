import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { libraryAllowlistGate } from '../handler';
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
