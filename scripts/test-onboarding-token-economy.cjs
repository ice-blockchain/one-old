#!/usr/bin/env node
'use strict';

// Tests for the OpenCode "token economy" opt-in:
//   - scripts/hook-runtime/state/state.cjs        (validator + normalizeState + round-trip)
//   - scripts/hook-runtime/directives/directives.cjs   (onboarding directive content)
//   - scripts/hook-runtime/handlers/handlers.cjs     (onboarding gate order + existing-codebase surfacing)
//
// Run: node scripts/test-onboarding-token-economy.cjs
// Endpoint defaults to a dead port so a real mcp-auth server on :8787 cannot
// reject the fake auth fixture and cascade failures (see the auth gotcha).

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK_RUNTIME = path.join(ROOT, 'scripts', 'hook-runtime.cjs');
const AUTH_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-oc-${process.pid}.json`);
const AUTH_CHOICE_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-choice-oc-${process.pid}.json`);
process.env.TRAFFIC_ONE_AUTH_STATE_PATH = AUTH_STATE_PATH;
process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = AUTH_CHOICE_STATE_PATH;
process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || 'http://127.0.0.1:1/mcp';
process.env.TRAFFIC_ONE_AUTH_ALLOW_REMOTE_CHECK_FAILURE = '1';
fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
fs.rmSync(AUTH_CHOICE_STATE_PATH, { force: true });
fs.writeFileSync(AUTH_STATE_PATH, `${JSON.stringify({
  version: 1,
  endpoint: process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
  sessionToken: 'tok_test-session-token.signature',
  expiresAt: '2099-01-01T00:00:00Z',
  keyId: 'test-key',
  authenticatedAt: '2026-05-21T00:00:00Z',
  lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
  lastRemoteCheckOkAt: '2099-01-01T00:00:00Z',
}, null, 2)}\n`, 'utf8');

const {
  hasResolvedOpenCodeState,
  canonicalOpenCodeSource,
  normalizeState,
  writeState,
  readState,
  initializeToolchainState,
} = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
const { onboardingDirectiveNewProject } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'directives', 'directives.cjs'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-oc-'));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function runHook(cwd, subcommand, input = '') {
  const result = spawnSync(process.execPath, [HOOK_RUNTIME, subcommand], {
    cwd,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function parseStdoutJson(result) {
  assert.notEqual(result.stdout.trim(), '', 'expected hook stdout to contain JSON');
  return JSON.parse(result.stdout);
}

function makeExistingProject(cwd) {
  writeJson(path.join(cwd, 'package.json'), { dependencies: { react: '18.0.0' } });
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(path.join(cwd, `file${index}.ts`), 'export const value = 1\n', 'utf8');
  }
}

// A complete new-project state, so tests can isolate a single missing field.
function completeNewProjectState(overrides = {}) {
  return {
    version: '2.9.67',
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    projectContext: {
      source: 'prompted',
      originalPrompt: 'Build a learning platform',
      summary: 'Learning platform with admin tools.',
      answers: { audience: 'students' },
      collectedAt: '2026-05-13T09:59:00Z',
    },
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
    realtime: 'none',
    codeGraphProvider: 'gitnexus',
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-05-13T09:58:00Z' },
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', approved: true },
    toolchain: initializeToolchainState({}),
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-05-13T10:00:00Z',
    ...overrides,
  };
}

// ── Validator ────────────────────────────────────────────────────────────────

test('hasResolvedOpenCodeState requires a strict boolean enabled and a known source', () => {
  assert.equal(hasResolvedOpenCodeState({ enabled: false, source: 'prompted' }), true);
  assert.equal(hasResolvedOpenCodeState({ enabled: true, source: 'explicit' }), true);
  assert.equal(hasResolvedOpenCodeState({ enabled: false, source: 'unavailable' }), true);
  // Unresolved / malformed.
  assert.equal(hasResolvedOpenCodeState(undefined), false);
  assert.equal(hasResolvedOpenCodeState(null), false);
  assert.equal(hasResolvedOpenCodeState({}), false);
  assert.equal(hasResolvedOpenCodeState({ enabled: 'true', source: 'prompted' }), false);
  assert.equal(hasResolvedOpenCodeState({ enabled: true, source: 'bogus' }), false);
  assert.equal(hasResolvedOpenCodeState([{ enabled: true, source: 'prompted' }]), false);
});

test('canonicalOpenCodeSource keeps known sources and defaults unknown to prompted', () => {
  assert.equal(canonicalOpenCodeSource('prompted'), 'prompted');
  assert.equal(canonicalOpenCodeSource('explicit'), 'explicit');
  assert.equal(canonicalOpenCodeSource('unavailable'), 'unavailable');
  assert.equal(canonicalOpenCodeSource('Explicit'), 'explicit');
  assert.equal(canonicalOpenCodeSource('user request'), 'prompted');
  assert.equal(canonicalOpenCodeSource(undefined), 'prompted');
});

// ── normalizeState ─────────────────────────────────────────────────────────

test('normalizeState coerces enabled to a strict boolean, canonicalizes source, fills decidedAt', () => {
  const state = completeNewProjectState({ openCode: { enabled: true, source: 'Explicit' } });
  const changed = normalizeState(state, 'new-project');
  assert.equal(changed, true);
  assert.equal(state.openCode.enabled, true);
  assert.equal(state.openCode.source, 'explicit');
  assert.equal(typeof state.openCode.decidedAt, 'string');
  assert.ok(state.openCode.decidedAt.trim().length > 0);
});

test('normalizeState coerces a non-boolean enabled to false', () => {
  const state = completeNewProjectState({ openCode: { enabled: 'yes', source: 'prompted' } });
  normalizeState(state, 'new-project');
  assert.equal(state.openCode.enabled, false);
});

test('normalizeState leaves a missing openCode untouched (model writes it)', () => {
  const state = completeNewProjectState({ openCode: undefined });
  normalizeState(state, 'new-project');
  assert.equal(state.openCode, undefined);
});

test('openCode round-trips through writeState/readState without being dropped', () => {
  withTempDir((cwd) => {
    writeState(cwd, completeNewProjectState());
    const round = readState(cwd);
    assert.ok(round.openCode, 'openCode survived the write/read cycle');
    assert.equal(round.openCode.enabled, false);
    assert.equal(round.openCode.source, 'prompted');
    assert.equal(typeof round.openCode.decidedAt, 'string');
  });
});

// ── Directive content ─────────────────────────────────────────────────────

test('new-project onboarding directive presents the OpenCode opt-in before Performance', () => {
  const directive = onboardingDirectiveNewProject();
  assert.match(directive, /OPENCODE DELEGATION PREFLIGHT/);
  assert.match(directive, /opencode\.ai\/install/);
  assert.match(directive, /"openCode": \{ "enabled":/);
  assert.match(directive, /First \(before popup 1\): OpenCode delegation opt-in/);
  // Order: the OpenCode block is injected ahead of the Performance popup block.
  assert.ok(
    directive.indexOf('OPENCODE DELEGATION PREFLIGHT') < directive.indexOf('AGENT PERFORMANCE PREFLIGHT'),
    'OpenCode preflight must appear before the Performance preflight',
  );
});

// ── Onboarding gate ordering (new-project) ─────────────────────────────────

test('onboarding gate asks the OpenCode opt-in first, then Performance', () => {
  // Missing both openCode and performance -> OpenCode is surfaced first.
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeNewProjectState({
      openCode: undefined,
      performance: undefined,
      team: { mode: 'subagents', source: 'prompted' },
    }));
    const parsed = parseStdoutJson(runHook(cwd, 'check-onboarding-gate', { tool_input: { command: 'ls -la' } }));
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(parsed.promptRequest.id, 'traffic-one.onboarding.open-code');
    assert.equal(parsed.promptRequest.title, 'OpenCode');
    assert.deepEqual(parsed.promptRequest.options.map((o) => o.id), ['enable', 'not_now']);
    assert.match(parsed.promptRequest.fallbackText, /Save tokens by delegating coding tasks to OpenCode/);
  });

  // OpenCode resolved, performance still missing -> Performance comes next.
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeNewProjectState({
      performance: undefined,
      team: { mode: 'subagents', source: 'prompted' },
    }));
    const parsed = parseStdoutJson(runHook(cwd, 'check-onboarding-gate', { tool_input: { command: 'ls -la' } }));
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(parsed.promptRequest.id, 'traffic-one.onboarding.performance');
  });
});

test('onboarding gate allows once every required choice incl. openCode exists', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeNewProjectState());
    const result = runHook(cwd, 'check-onboarding-gate', { tool_input: { command: 'ls -la' } });
    // A fully complete state is not denied for a missing onboarding answer.
    if (result.stdout.trim() !== '') {
      const parsed = JSON.parse(result.stdout);
      const decision = parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision;
      assert.notEqual(decision, 'deny');
    }
  });
});

// ── Existing-codebase one-time surfacing ────────────────────────────────────

test('existing codebase surfaces the OpenCode opt-in once, then never again', () => {
  withTempDir((cwd) => {
    makeExistingProject(cwd);
    // Auto-detect + materialize the existing project so the second prompt is not
    // intercepted by materialization convergence.
    runHook(cwd, 'session-start');

    const statePath = path.join(cwd, '.traffic-one/.one.json');
    let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.mode, 'existing-codebase');
    assert.equal(hasResolvedOpenCodeState(state.openCode), false, 'auto-detect must not invent an openCode answer');

    const first = parseStdoutJson(runHook(cwd, 'user-prompt-submit', { prompt: 'add a search box to the header' }));
    assert.ok(first.promptRequest, 'expected a one-time opt-in promptRequest');
    assert.equal(first.promptRequest.id, 'traffic-one.onboarding.open-code');
    assert.match(first.hookSpecificOutput.additionalContext, /OPENCODE DELEGATION OPT-IN/);
    assert.match(first.hookSpecificOutput.additionalContext, /opencode\.ai\/install/);

    // Record the choice; the opt-in must not reappear.
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.openCode = { enabled: false, source: 'prompted', decidedAt: '2026-05-25T00:00:00Z' };
    writeJson(statePath, state);

    const second = parseStdoutJson(runHook(cwd, 'user-prompt-submit', { prompt: 'now add a footer' }));
    assert.notEqual(
      second.promptRequest && second.promptRequest.id,
      'traffic-one.onboarding.open-code',
      'opt-in must not reappear once recorded',
    );
  });
});

// ── Runner ──────────────────────────────────────────────────────────────────

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}
console.log(`${failures === 0 ? tests.length + ' test(s) passed.' : failures + ' test(s) failed.'}`);
process.exit(failures === 0 ? 0 : 1);
