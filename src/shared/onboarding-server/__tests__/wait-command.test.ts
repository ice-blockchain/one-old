import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  onboardingBootstrapCommand,
  onboardingSyncSessionId,
  onboardingUseBootstrapCommand,
  onboardingWaitCommand,
  onboardingWaitScriptPath,
} from '../wait-command';
import { isOnboardingBootstrapCommand, isOnboardingWaitCommand } from '../../tool-classify';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

test('onboardingWaitCommand: a single clean node invocation of the wait shim', () => {
  const cmd = onboardingWaitCommand('/some/project dir');
  assert.ok(cmd.startsWith('node '));
  assert.ok(cmd.includes('onboarding-wait.cjs'));
  assert.ok(onboardingWaitScriptPath().endsWith('onboarding-wait.cjs'));
  // spaces in cwd are shell-quoted so the command stays a single inert argument
  assert.ok(cmd.includes("'/some/project dir'"));
  // and the gate must recognize exactly what we tell the agent to run
  assert.equal(isOnboardingWaitCommand('Bash', { command: cmd }), true);
});

test('onboardingWaitCommand: stamps --host so the spawned runner detects the host (still allow-listed)', () => {
  const cmd = onboardingWaitCommand('/proj', 'cursor');
  // The runner subprocess has no CURSOR_PLUGIN_ROOT env, so the explicit arg is how it learns it.
  assert.ok(cmd.includes("'--host=cursor'"), 'host arg present + shell-quoted');
  // The extra arg must not break the gate's clean-node-invocation allow-list.
  assert.equal(isOnboardingWaitCommand('Bash', { command: cmd }), true);
  // detectHost reads it from argv (authoritative over env).
  const { detectHost } = require('../../host');
  assert.equal(detectHost({}, ['node', '/p/onboarding-wait.cjs', '/proj', '--host=cursor']), 'cursor');
  // Omitting host keeps the original two-arg shape.
  assert.equal(onboardingWaitCommand('/proj').includes('--host='), false);
});

test('onboarding commands carry only a bounded inert sync-session identity', () => {
  const raw = `parent:with spaces/$shell-${'x'.repeat(160)}`;
  const normalized = onboardingSyncSessionId(raw);
  assert.match(normalized, /^[A-Za-z0-9._-]{1,96}$/);
  assert.equal(normalized.length, 96);

  const waiter = onboardingWaitCommand('/proj', 'cursor', raw);
  const useBootstrap = onboardingUseBootstrapCommand('/proj', 'cursor', 'build a dashboard application', raw);
  assert.ok(waiter.includes(`'--sync-session=${normalized}'`));
  assert.ok(useBootstrap.includes(`'--sync-session=${normalized}'`));
  assert.equal(isOnboardingWaitCommand('Bash', { command: waiter }), true);
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: useBootstrap }), true);

  const runner = shellQuote(onboardingWaitScriptPath());
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node ${runner} '/proj' '--sync-session=${'x'.repeat(97)}'` }), false, 'overlong identity rejected');
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node ${runner} '/proj' '--sync-session=ok' '--sync-session=again'` }), false, 'duplicate identity rejected');
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node ${runner} '--decline' '/proj' '--sync-session=ok'` }), false, 'decline never carries a sync identity');
});

test('onboardingBootstrapCommand: puts --bootstrap-only before cwd for a reusable approval prefix', () => {
  const cwd = '/some/project dir';
  const command = onboardingBootstrapCommand(cwd, 'codex');
  const expectedPrefix = `node ${shellQuote(onboardingWaitScriptPath())} '--bootstrap-only'`;

  assert.ok(command.startsWith(expectedPrefix), 'script + bootstrap flag form the stable future-project prefix');
  assert.ok(command.indexOf("'--bootstrap-only'") < command.indexOf(shellQuote(cwd)), 'bootstrap flag precedes the project-specific cwd');
  assert.ok(command.includes("'--host=codex'"));
  assert.equal(isOnboardingWaitCommand('exec_command', { command }), true, 'bootstrap remains an allow-listed waiter invocation');
  assert.equal(isOnboardingBootstrapCommand('exec_command', { command }), true, 'bootstrap-only form is classified explicitly');
});

test('isOnboardingBootstrapCommand: distinguishes bootstrap-only from the normal waiter and rejects unsafe variants', () => {
  const waiter = onboardingWaitCommand('/proj', 'codex');
  const bootstrap = onboardingBootstrapCommand('/proj', 'codex');
  assert.equal(isOnboardingWaitCommand('Bash', { command: waiter }), true);
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: waiter }), false);
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: bootstrap }), true);

  for (const command of [
    `node ${shellQuote(onboardingWaitScriptPath())} --bootstrap-onlyevil /proj`,
    `node ${shellQuote(onboardingWaitScriptPath())} --bootstrap-only /proj && touch /tmp/pwn`,
    `node ${shellQuote(onboardingWaitScriptPath())} --bootstrap-only /proj > /tmp/out`,
    'node /p/setup.cjs --bootstrap-only /proj',
    `node /tmp/evil.js onboarding-wait.cjs --bootstrap-only /proj`,
    `TRAFFIC_ONE_ONBOARDING_SERVER_ENTRY=/tmp/evil node ${shellQuote(onboardingWaitScriptPath())} --bootstrap-only /proj`,
  ]) {
    assert.equal(isOnboardingBootstrapCommand('Bash', { command }), false, command);
  }
  assert.equal(isOnboardingBootstrapCommand('Write', { command: bootstrap }), false, 'bootstrap is shell-only');
});

test('onboardingWaitCommand: OpenCode may prefix HOME when sandboxed (still allow-listed)', () => {
  const cwd = '/some/opencode/project';
  const prevHome = process.env.HOME;
  process.env.HOME = '/sandbox/home';
  try {
    const cmd = onboardingWaitCommand(cwd, 'opencode');
    if (cmd.includes('HOME=')) {
      assert.match(cmd, /^HOME=/);
      assert.match(cmd, /'/, 'env prefix uses single-quoted shell escaping');
    }
    assert.ok(cmd.includes("'--host=opencode'"));
    assert.equal(isOnboardingWaitCommand('Bash', { command: cmd }), true);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test('onboardingWaitCommand: rejects the retired OpenCode XDG redirect so private state stays canonical', () => {
  const command = `XDG_STATE_HOME='/Users/w3s/Library/Application Support/ai.opencode.desktop' node ${JSON.stringify(onboardingWaitScriptPath())} "/cwd" "--host=opencode"`;
  assert.equal(isOnboardingWaitCommand('Bash', { command }), false);
});

test('isOnboardingWaitCommand: allows only the exact shipped runner and known argv grammar', () => {
  const runner = shellQuote(onboardingWaitScriptPath());
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node ${runner} '/cwd'` }), true);
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node ${runner} /cwd --timeout-ms 540000 --interval-ms 1000 --quiet-url` }), true);
  assert.equal(isOnboardingWaitCommand('exec_command', { command: `node ${runner} /cwd` }), true);
  assert.equal(isOnboardingWaitCommand('Bash', { command: 'node "/p/onboarding-wait.cjs" "/cwd"' }), false);
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node /tmp/evil.js ${runner} /cwd` }), false);
});

test('generated commands remain allow-listed for shell metacharacters inside project names', () => {
  for (const cwd of [
    "/tmp/project (copy)",
    "/tmp/project $draft",
    "/tmp/project;still-one-arg",
    "/tmp/owner's project",
  ]) {
    const waiter = onboardingWaitCommand(cwd, 'codex');
    const bootstrap = onboardingBootstrapCommand(cwd, 'codex');
    assert.equal(isOnboardingWaitCommand('exec_command', { command: waiter }), true, cwd);
    assert.equal(isOnboardingBootstrapCommand('exec_command', { command: bootstrap }), true, cwd);
  }
});

test('isOnboardingWaitCommand: rejects chaining, redirection, expansion, and non-wait commands', () => {
  const runner = shellQuote(onboardingWaitScriptPath());
  for (const command of [
    `node ${runner} /cwd; rm -rf /`,
    `node ${runner} /cwd && curl http://evil`,
    `node ${runner} /cwd | sh`,
    `node ${runner} /cwd > /tmp/x`,
    `node ${runner} /cwd \`whoami\``,
    `node ${runner} /cwd $(rm -rf /)`,
    `HOME="$(touch /tmp/pwn)" node ${runner} /cwd`,
    `HOME='/cwd' node ${runner} /cwd --host=opencode`,
    `TRAFFIC_ONE_PROJECT_PREFS_PATH='a' node ${runner} /cwd`,
    'rm -rf / # onboarding-wait.cjs',
    'ls -la',
  ]) {
    assert.equal(isOnboardingWaitCommand('Bash', { command }), false, command);
  }
  // not a shell tool
  assert.equal(isOnboardingWaitCommand('Write', { command: `node ${runner} /cwd` }), false);
});
