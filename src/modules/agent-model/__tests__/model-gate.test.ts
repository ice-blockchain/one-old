import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { modelGateAfterShell, modelGateShell } from '../model-gate';
import { isModelCaptureCommand, isModelGateCommand } from '../../../shared/tool-classify';
import { modelCaptureCommand, modelGateCommand } from '../../../shared/model-gate-command';
import { modelGatePromptFresh, readModelChoice, writeModelChoice } from '../model-choice';
import { runModelGate } from '../../../runners/model-gate';
import type { Ctx, ToolClass } from '../../../core/types';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';
import { ensureRunModelPolicy } from '../../../shared/run-model-policy';
import { readEffectiveState } from '../../../shared/state';

function withProj(opts: { models: string[] | null; overrides?: Record<string, string> }, fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-mgate-')));
  const env = process.env;
  const pp = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const pl = env.TRAFFIC_ONE_USER_PLAN;
  const ps = env.TRAFFIC_ONE_STATE_PATH;
  const pm = env.TRAFFIC_ONE_MCP_CACHE_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_MCP_CACHE_PATH = path.join(dir, 'one-mcp.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const prefs = hostScopedPerformancePrefs(
    { level: 'high', source: 'prompted' },
    { mode: 'subagents', source: 'prompted', approved: true, overrides: opts.overrides || {} },
    'pro',
  );
  if (opts.models !== null) withCursorAvailableModels(prefs, opts.models, 'pro');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
  }), 'utf8');
  try { fn(dir); } finally {
    if (pp === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = pp;
    if (pl === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = pl;
    if (ps === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = ps;
    if (pm === undefined) delete env.TRAFFIC_ONE_MCP_CACHE_PATH; else env.TRAFFIC_ONE_MCP_CACHE_PATH = pm;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function freezeCursorPolicy(cwd: string, runId: string): void {
  const env = { ...process.env, TRAFFIC_ONE_HOST: 'cursor' };
  const state = readEffectiveState(cwd, env);
  assert.ok(
    ensureRunModelPolicy(cwd, runId, 'cursor', state, env),
    'the parent fixture must freeze the Cursor policy before simulating after-shell',
  );
}

function ctxFor(cwd: string, command: string, host: 'cursor' | 'claude' = 'cursor'): Ctx {
  const rawName = host === 'cursor' ? 'before-shell-execution' : 'Bash';
  return {
    input: { event: 'PreToolUse', host, cwd, raw: { command }, tool: { class: 'shell' as ToolClass, rawName, command } },
    host, cwd, now: () => 'x',
  } as unknown as Ctx;
}

function afterCtxFor(cwd: string, command: string, rawExtra: Record<string, unknown> = {}): Ctx {
  return {
    input: {
      event: 'PostToolUse',
      host: 'cursor',
      cwd,
      raw: { command, ...rawExtra },
      tool: { class: 'shell' as ToolClass, rawName: 'after-shell-execution', command },
    },
    host: 'cursor', cwd, now: () => 'x',
  } as unknown as Ctx;
}

function captureStdout(fn: () => number): { code: number; out: string } {
  const original = process.stdout.write;
  let out = '';
  (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk: string | Uint8Array): boolean => {
    out += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  };
  try {
    return { code: fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

test('isModelGateCommand recognizes the model-gate command (and rejects others)', () => {
  const root = '/proj';
  assert.equal(isModelGateCommand('Bash', { command: modelGateCommand(root, 'cursor') }, root), true);
  assert.equal(isModelCaptureCommand('Bash', { command: modelCaptureCommand(root, 'cursor') }, root), true);
  assert.equal(isModelGateCommand('Bash', { command: 'node /p/onboarding-wait.cjs /cwd' }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: 'node /p/model-gate.cjs /proj --host=cursor' }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: 'echo node /p/model-gate.cjs /proj --host=cursor' }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: `${modelGateCommand(root, 'cursor')} && rm -rf /` }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: modelGateCommand('/sibling', 'cursor') }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: modelGateCommand(root, 'claude') }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: `node '/p/model-gate.cjs' '/proj' '--host=cursor' '--unknown'` }, root), false);
  assert.equal(isModelCaptureCommand('Bash', { command: `${modelGateCommand(root, 'cursor')} '--capture-models'` }, root), false);
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' 'valid-model' '--unknown'`,
  }, root), false);
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' 'duplicate' 'duplicate'`,
  }, root), false);
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' 'invalid model prose'`,
  }, root), false);
  const tooManyModels = Array.from({ length: 257 }, (_, index) => `'model-${index}'`).join(' ');
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' ${tooManyModels}`,
  }, root), false);
});

test('model-gate generation and strict parsing preserve shell-punctuation project paths', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-model path-')));
  const root = path.join(base, "project ($draft); it's literal");
  fs.mkdirSync(root);
  try {
    const gate = modelGateCommand(root, 'cursor');
    const capture = modelCaptureCommand(root, 'cursor');
    assert.equal(isModelGateCommand('Bash', { command: gate }, root), true);
    assert.equal(isModelCaptureCommand('Bash', { command: capture }, root), true);
    assert.match(gate, /'\\''/, 'an apostrophe is emitted with an inert single-quote splice');
    assert.ok(gate.includes('$draft'), 'the literal dollar text is preserved inside inert quotes');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('modelGateShell always allows the internal capture command to refresh stale availability', () => {
  withProj({ models: ['composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    assert.equal(modelGateShell(ctxFor(cwd, modelCaptureCommand(cwd, 'cursor'))).kind, 'noop');
  });
});

test('modelGateShell: a PICKED model not offered → askUser (permission:ask) naming the model + fallback', () => {
  // architect overridden to balanced (GPT-5.6 Terra), which the captured list LACKS.
  withProj({ models: ['claude-fable-5-thinking-high', 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const r = modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor')));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.equal((r as { askUser?: boolean }).askUser, true, 'is a user APPROVE/REJECT prompt, not a hard deny');
      assert.ok(r.reason.includes('gpt-5.6-terra'), 'names the unavailable picked model');
      assert.ok(r.reason.includes('claude-sonnet-5'), 'names the fallback it would use');
      assert.ok(/approve/i.test(r.reason) && /reject/i.test(r.reason), 'offers approve/reject');
      assert.ok(/fallback.*enable/i.test(r.reason), 'directs chat consent before spawn');
      assert.ok((r as { agentMessage?: string }).agentMessage, 'carries per-branch agent instructions');
    }
  });
});

test('modelGate runner fails closed until explicit chat consent (use-fallback)', () => {
  withProj({ models: ['claude-fable-5-thinking-high', 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentRunId = 'run-model-gate';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

    const closed = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(closed.code, 2, 'without explicit consent the runner refuses');
    assert.match(closed.out, /STOP|model choice required/i);
    assert.equal(readModelChoice(cwd, 'run-model-gate'), null, 'fail-closed path writes no fallback choice');
    assert.equal(modelGatePromptFresh(cwd, 'run-model-gate'), true, 'runner marks that a user-visible choice is required');

    writeModelChoice(cwd, 'run-model-gate', 'use-fallback');
    const approved = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(approved.code, 0);
    assert.match(approved.out, /fallback confirmed/i);
    assert.equal(readModelChoice(cwd, 'run-model-gate'), 'use-fallback', 'explicit chat consent unblocks the runner');
  });
});

test('modelGate after-shell surfaces exit-2 STOP as a Cursor user-visible message', () => {
  withProj({ models: ['claude-fable-5-thinking-high', 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentRunId = 'run-after-shell';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    freezeCursorPolicy(cwd, 'run-after-shell');

    const r = modelGateAfterShell(afterCtxFor(cwd, modelGateCommand(cwd, 'cursor'), { exit_code: 2 }));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(/model choice required/i.test(r.context), 'context carries the STOP table');
      assert.ok(/fallback/i.test(String(r.systemMessage)) && /enable/i.test(String(r.systemMessage)), 'systemMessage is visible to Cursor as user_message');
      assert.ok(String(r.systemMessage).includes('gpt-5.6-terra'), 'visible message names the unavailable picked model');
    }
  });
});

test('modelGate runner fails closed when Cursor model capture is missing', () => {
  withProj({ models: null, overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentRunId = 'run-missing-capture';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

    const closed = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(closed.code, 2, 'missing capture must never be treated as all models available');
    assert.match(closed.out, /STOP|cursor-models\.json|model capture/i);
    assert.doesNotMatch(closed.out, /all picked models are available/i);
    assert.equal(readModelChoice(cwd, 'run-missing-capture'), null, 'missing capture writes no fallback choice');
  });
});

test('modelGateShell: recognizes the real Cursor before-shell-execution shape', () => {
  withProj({ models: ['claude-fable-5-thinking-high', 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const r = modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor')));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.equal((r as { askUser?: boolean }).askUser, true);
  });
});

test('modelGateShell: every picked model offered → noop (the command runs, no prompt)', () => {
  withProj({ models: ['claude-fable-5-thinking-high', 'gpt-5.6-terra-medium', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    assert.equal(modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor'))).kind, 'noop');
  });
});

test('modelGate runner prints the local spawn map while project agent contracts stay model-agnostic', () => {
  withProj({ models: ['claude-fable-5-thinking-high', 'gpt-5.6-terra-medium', 'composer-2.5-fast'], overrides: {} }, (cwd) => {
    const approved = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(approved.code, 0);
    assert.match(approved.out, /spawn map/i);
    assert.match(approved.out, /senior-architect → subagent_type: "senior-architect", model: claude-fable-5-thinking-high/);
    // The rejected-enum recovery must travel with the map, not only in the gate.
    assert.match(approved.out, /retry that one spawn with `subagent_type: "generalPurpose"`/);
    const architect = fs.readFileSync(path.join(cwd, '.cursor', 'agents', 'senior-architect.md'), 'utf8');
    assert.doesNotMatch(architect, /^model:/m);
    assert.match(architect, /senior-architect/);
  });
});

test('modelGateShell: non-cursor host and non-model-gate commands → noop', () => {
  withProj({ models: ['claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    assert.equal(modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor'), 'claude')).kind, 'noop', 'claude → inert');
    assert.equal(modelGateShell(ctxFor(cwd, 'ls -la')).kind, 'noop', 'unrelated command → inert');
  });
});
