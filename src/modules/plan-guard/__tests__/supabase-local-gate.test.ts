import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { SUPABASE_LOCAL_STACK_RE, supabaseLocalGate } from '../supabase-local-gate';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function withProject(stamps: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-supabase-local-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'some code', 'utf8');
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'new-project', ...stamps }), 'utf8');
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

test('SUPABASE_LOCAL_STACK_RE matches local-stack lifecycle, not linked/deploy commands', () => {
  for (const cmd of [
    'pnpm db:start',
    'npm run db:reset',
    'yarn db:stop',
    'pnpm run functions:serve',
    'supabase start',
    'npx supabase start',
    'pnpm dlx supabase stop',
    'supabase db reset',
    'supabase functions serve',
    'cd apps && supabase start',
  ]) {
    assert.ok(SUPABASE_LOCAL_STACK_RE.test(cmd), `expected gated: ${cmd}`);
  }
  for (const cmd of [
    'pnpm db:push',
    'supabase db push --linked',
    'pnpm gen:types',
    'supabase gen types typescript --linked',
    'supabase functions deploy my-fn --linked',
    'pnpm link abcd1234',
    'supabase link --project-ref abcd1234',
    'pnpm dev',
    'git status',
    'supabase migration list',
  ]) {
    assert.ok(!SUPABASE_LOCAL_STACK_RE.test(cmd), `expected benign: ${cmd}`);
  }
});

test('supabase local gate denies local-stack commands on supabase projects with the platform guidance', () => {
  withProject({ backend: 'supabase', frontend: 'react-vite', stack: 'default' }, (cwd) => {
    const r = supabaseLocalGate(ctxFor(cwd, 'pnpm db:start'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes('traffic.io'), 'names the platform connection');
      assert.ok(r.reason.includes('EnvBanner'), 'names the demo-mode contract');
    }
    assert.equal(supabaseLocalGate(ctxFor(cwd, 'supabase start')).kind, 'deny');
    assert.equal(supabaseLocalGate(ctxFor(cwd, 'supabase functions serve')).kind, 'deny');
  });
});

test('supabase local gate ignores non-matching commands and non-supabase projects', () => {
  withProject({ backend: 'supabase', frontend: 'react-vite', stack: 'default' }, (cwd) => {
    assert.equal(supabaseLocalGate(ctxFor(cwd, 'pnpm db:push')).kind, 'noop');
    assert.equal(supabaseLocalGate(ctxFor(cwd, 'pnpm dev')).kind, 'noop');
  });
  withProject({ backend: 'none', frontend: 'react-vite', stack: 'default' }, (cwd) => {
    assert.equal(supabaseLocalGate(ctxFor(cwd, 'supabase start')).kind, 'noop', 'other backends keep their tooling');
  });
});
