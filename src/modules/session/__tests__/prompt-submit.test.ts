import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runUserPromptSubmit } from '../prompt-submit';
import type { Ctx, HookInput } from '../../../core/types';
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
function completeState(): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: { source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z' },
    openCode: { enabled: false, source: 'prompted' }, codeGraphProvider: 'graphify',
    team: { mode: 'subagents', source: 'prompted', approved: true }, performance: { level: 'high', source: 'prompted' },
    toolchain: TOOLCHAIN, confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
    materializedStack: 'default|react-vite|supabase|none',
  };
}

test('noop inside the plugin authoring root', () => {
  assert.equal(runUserPromptSubmit(ctx(process.cwd(), 'hello')).kind, 'noop');
});

test('authed + no state file → "traffic-one active"', () => {
  withAuthedProject(null, (cwd) => {
    const r = runUserPromptSubmit(ctx(cwd, 'hi'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.equal(r.systemMessage, 'traffic-one active');
  });
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
  withAuthedProject({ mode: 'new-project', performance: { level: 'high', source: 'prompted' }, team: { mode: 'subagents', source: 'prompted', approved: false } }, (cwd) => {
    const r = runUserPromptSubmit(ctx(cwd, 'continue'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.systemMessage?.includes('team confirmation required'));
      assert.ok(r.promptRequest);
    }
  });
});

test('authed + complete, materialized project, openCode resolved → plain active-stack context', () => {
  withAuthedProject(completeState(), (cwd) => {
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
