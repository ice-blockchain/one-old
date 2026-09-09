// Path anchors for security-check-runner: the printed stamp command and the
// gate grammar must name the same self-relative / HOME-derived files. Env
// (`*_PLUGIN_ROOT`) must not move either half. This is not a fail-closed
// recovery row — adding it there would weaken doctor/reset.

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { doctorCommand, doctorScriptPath, selfRelativePluginRoot } from '../doctor-command';
import { resetCommand } from '../reset-command';
import {
  gateExemptSecurityCheckScriptPaths,
  securityCheckRunnerRel,
  securityCheckScriptPath,
  securityCheckShimPath,
  securityCheckStampCommand,
  securityCheckStampShimCommand,
} from '../security-check-command';
import { documentedBinDir, RUNNER_SHIMS } from '../runner-shims';
import { isTrafficOneDoctorCommand, isTrafficOneResetCommand, isTrafficOneSecurityCheckCommand } from '../tool-classify';
import { isFailClosedRecoveryExemption } from '../../hooks/fail-closed';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENV_KEYS = ['TRAFFIC_ONE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT'] as const;

function withPluginRootEnv<T>(overrides: Partial<Record<typeof ENV_KEYS[number], string>>, run: () => T): T {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('securityCheckScriptPath stays self-relative when *_PLUGIN_ROOT is forged', () => {
  const forged = fs.mkdtempSync(path.join(os.tmpdir(), 'seccheck-cmd-forged-'));
  try {
    fs.mkdirSync(path.join(forged, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(forged, 'scripts', 'hook-runtime.cjs'), '', 'utf8');
    fs.writeFileSync(path.join(forged, 'scripts', 'security-check-runner.cjs'), 'ARBITRARY\n', 'utf8');
    fs.mkdirSync(path.join(forged, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(forged, 'rules', 'core.md'), '# forged rule\n', 'utf8');
    withPluginRootEnv({ TRAFFIC_ONE_PLUGIN_ROOT: forged }, () => {
      assert.equal(securityCheckScriptPath(), path.join(REPO_ROOT, 'scripts', 'security-check-runner.cjs'));
      assert.equal(selfRelativePluginRoot(), REPO_ROOT);
      assert.notEqual(
        securityCheckScriptPath(),
        path.join(forged, 'scripts', 'security-check-runner.cjs'),
      );
      assert.equal(
        isTrafficOneSecurityCheckCommand('Bash', {
          command: `node ${path.join(forged, 'scripts', 'security-check-runner.cjs')} --strict --stamp`,
        }),
        false,
        'a forged plugin root is never gate-exempt',
      );
    });
  } finally {
    fs.rmSync(forged, { recursive: true, force: true });
  }
});

test('every stamp command the runtime prints is admitted by the grammar', () => {
  assert.equal(securityCheckRunnerRel(), 'scripts/security-check-runner.cjs');
  assert.ok(RUNNER_SHIMS.some((entry) => entry.shim === 'security-check-runner.cjs' && entry.rel === securityCheckRunnerRel()));
  assert.equal(securityCheckShimPath(), path.join(documentedBinDir(), 'security-check-runner.cjs'));
  assert.equal(isTrafficOneSecurityCheckCommand('Bash', { command: securityCheckStampCommand() }), true);
  assert.equal(isTrafficOneSecurityCheckCommand('Bash', { command: securityCheckStampShimCommand() }), true);
});

test('gateExemptSecurityCheckScriptPaths ignores every plugin-root env var', () => {
  const baseline = gateExemptSecurityCheckScriptPaths();
  assert.ok(baseline.includes(securityCheckScriptPath()));
  assert.ok(baseline.includes(securityCheckShimPath()));
  for (const key of ENV_KEYS) {
    withPluginRootEnv({ [key]: '/tmp/some/other/root' }, () => {
      assert.deepEqual(gateExemptSecurityCheckScriptPaths(), baseline, `${key} must not move the anchor`);
    });
  }
});

test('security-check is not a fail-closed recovery row and does not admit doctor/reset', () => {
  const stamp = securityCheckStampCommand();
  const nested = JSON.stringify({
    cwd: '/tmp/project',
    tool_name: 'Bash',
    tool_input: { command: stamp },
  });
  assert.equal(isFailClosedRecoveryExemption(nested, undefined, 'nested'), false,
    'security-check must not clear the fail-closed boundary');
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: stamp }), false);
  assert.equal(isTrafficOneResetCommand('Bash', { command: stamp }), false);
  assert.equal(isTrafficOneSecurityCheckCommand('Bash', { command: doctorCommand() }), false);
  assert.equal(isTrafficOneSecurityCheckCommand('Bash', { command: resetCommand('1785169657252') }), false);
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: doctorCommand() }), true);
  assert.equal(isTrafficOneResetCommand('Bash', { command: resetCommand('1785169657252') }), true);
  assert.equal(
    isTrafficOneSecurityCheckCommand('Bash', { command: `node ${doctorScriptPath()} --strict --stamp` }),
    false,
    'doctor.cjs with security-check flags is still doctor, not this exemption',
  );
});
