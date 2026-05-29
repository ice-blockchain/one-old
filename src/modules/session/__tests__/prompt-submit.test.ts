import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { makeClaudeAdapter } from '../../../adapters/claude';
import { dispatch } from '../../../core/dispatch';
import { runUserPromptSubmit } from '../prompt-submit';
import type { Ctx, Handler, HookInput } from '../../../core/types';
import { initializeToolchainState } from '../../../shared/state/toolchain';

function ctx(cwd: string, prompt: string): Ctx {
  const input: HookInput = { event: 'UserPromptSubmit', host: 'claude', cwd, prompt, raw: { prompt } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

// Fresh local auth → authGateForHook authenticated WITHOUT spawning the CLI.
function withAuthedProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-promptsub-'));
  const env = process.env;
  const prevAuth = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  const prevEndpoint = env.TRAFFIC_ONE_MCP_KEY_ENDPOINT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
    version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
    expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: new Date().toISOString(),
  }), 'utf8');
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  }
  try { fn(dir); } finally {
    if (prevAuth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevAuth;
    if (prevEndpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = prevEndpoint;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TOOLCHAIN = Object.fromEntries(Object.keys(initializeToolchainState({})).map((k) => [k, { installedVersion: '1', installedAt: 'now' }]));
function completeSharedState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: { source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z' },
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
    materializedStack: 'default|react-vite|supabase|none',
    ...extra,
  };
}

function existingSharedState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'existing-codebase',
    stack: 'minimal',
    frontend: 'none',
    backend: 'other',
    realtime: 'none',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function writeLocalPrefs(extra: Record<string, unknown> = {}): void {
  const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  assert.ok(prefsPath, 'test prefs path must be configured');
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    codeGraphProvider: 'graphify',
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', approved: true },
    toolchain: TOOLCHAIN,
    ...extra,
  }), 'utf8');
}

function writeExistingNextCodebase(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'child', dependencies: { next: '15.0.0', react: '19.0.0' } }), 'utf8');
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(cwd, 'src', `page-${i}.tsx`), `export const page${i} = ${i};\n`, 'utf8');
  }
}

test('noop inside the plugin authoring root', () => {
  assert.equal(runUserPromptSubmit(ctx(process.cwd(), 'hello')).kind, 'noop');
});

test('authed + no state file → bootstraps new-project onboarding (mid-session auth)', () => {
  withAuthedProject(null, (cwd) => {
    const r = runUserPromptSubmit(ctx(cwd, 'hi'));
    assert.equal(r.kind, 'context');
    // Greenfield + authenticated (e.g. auth completed mid-session, so SessionStart
    // returned the auth gate and never ran the authed body) → run that body now →
    // the new-project onboarding directive, NOT the old empty "traffic-one active".
    if (r.kind === 'context') {
      assert.ok(
        r.context.includes('Baseline rules') || r.context.toLowerCase().includes('onboarding'),
        'expected the new-project onboarding bootstrap, got an empty/active noop',
      );
    }
  });
});

test('codex prompt mentioning an inner existing app bootstraps Traffic One in the child, not wrapper root', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-promptsub-child-')));
  const child = path.join(root, 'one-nextjs');
  const env = process.env;
  const prevAuth = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  const prevEndpoint = env.TRAFFIC_ONE_MCP_KEY_ENDPOINT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  try {
    env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(root, 'auth.json');
    env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(root, 'prefs.json');
    fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: new Date().toISOString(),
    }), 'utf8');

    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase', stack: 'minimal', rootMarker: true }), 'utf8');
    writeExistingNextCodebase(child);

    const codex = makeClaudeAdapter('codex');
    const handlers: Handler[] = [{ id: 'prompt-submit', event: 'UserPromptSubmit', priority: 0, run: runUserPromptSubmit }];
    const out = await dispatch(codex, handlers, {
      stdin: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: root,
        prompt: 'please continue in "one-nextjs"',
      }),
      argv: [],
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.systemMessage, 'traffic-one [custom-frontend] local preferences required');
    assert.ok(parsed.hookSpecificOutput.additionalContext.includes('local preferences are required'));
    assert.ok(fs.existsSync(path.join(child, '.traffic-one', '.one.json')));
    const childState = JSON.parse(fs.readFileSync(path.join(child, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(childState.stack, 'custom-frontend');
    assert.equal(childState.frontend, 'nextjs');
    const rootState = JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(rootState.rootMarker, true);
    assert.equal(rootState.stack, 'minimal');
  } finally {
    if (prevAuth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevAuth;
    if (prevEndpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = prevEndpoint;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authed + incomplete new project → onboarding reminder + next-step popup', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    const r = runUserPromptSubmit(ctx(cwd, 'build a shop with checkout'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.systemMessage?.includes('onboarding incomplete'));
      assert.ok(r.context.includes('FIRST PROMPT STACK CLASSIFICATION'));
      assert.ok(r.context.includes('onboarding still incomplete'));
      assert.ok(r.promptRequest);
    }
  });
});

test('authed + unapproved subagent line-up → team confirmation required', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs({ performance: { level: 'high', source: 'prompted' }, team: { mode: 'subagents', source: 'prompted', approved: false } });
    const r = runUserPromptSubmit(ctx(cwd, 'continue'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [default] local preferences required');
      assert.equal((r.promptRequest as { id?: string } | undefined)?.id, 'traffic-one.onboarding.team-confirmation');
    }
  });
});

test('local preference hook asks OpenCode before Team Confirmation', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs({ openCode: undefined, performance: { level: 'high', source: 'prompted' }, team: { mode: 'subagents', source: 'prompted', approved: false } });
    const r = runUserPromptSubmit(ctx(cwd, 'continue'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [default] local preferences required');
      assert.equal((r.promptRequest as { id?: string } | undefined)?.id, 'traffic-one.onboarding.open-code');
    }
  });
});

test('authed + complete shared new project but missing local prefs → local-pref prompt', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    const r = runUserPromptSubmit(ctx(cwd, 'add a button'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [default] local preferences required');
      assert.ok(r.context.includes('local preferences are required'));
      assert.equal((r.promptRequest as { id?: string } | undefined)?.id, 'traffic-one.onboarding.open-code');
    }
  });
});

test('authed + complete existing project but missing local prefs → local-pref prompt', () => {
  withAuthedProject(existingSharedState(), (cwd) => {
    const r = runUserPromptSubmit(ctx(cwd, 'add a button'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [minimal] local preferences required');
      assert.ok(r.context.includes('local preferences are required'));
      assert.equal((r.promptRequest as { id?: string } | undefined)?.id, 'traffic-one.onboarding.open-code');
    }
  });
});

test('authed + complete, materialized project, local prefs resolved → plain active-stack context', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs();
    const t1 = path.join(cwd, '.traffic-one');
    fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
    fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
    fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
    fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({ generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'] }), 'utf8');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'see agents', 'utf8');
    const r = runUserPromptSubmit(ctx(cwd, 'add a button'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [default]');
      assert.ok(r.context.includes('[ACTIVE STACK: default]'));
    }
  });
});
