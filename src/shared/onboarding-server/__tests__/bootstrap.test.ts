import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { HOST_IDS } from '../../../config/model-tiers';
import type { HostId } from '../../../core/types';
import { onboardingStartFailureReason, prepareOnboardingServer } from '../bootstrap';
import {
  onboardingBootstrapCommand,
  onboardingWaitCommand,
  onboardingWaitScriptPath,
} from '../wait-command';

const CWD = path.join(path.sep, 'workspace', 'project with spaces');
const COMPACT_HOSTS = new Set<HostId>(['opencode', 'kilo', 'windsurf']);

function errno(code: 'EPERM' | 'EACCES'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: onboarding runtime is not writable`), { code });
}

test('prepareOnboardingServer: every host turns EPERM/EACCES into an exact actionable bootstrap recipe', () => {
  for (const host of HOST_IDS) {
    for (const code of ['EPERM', 'EACCES'] as const) {
      let ensureCall: { cwd: string; host: string } | null = null;
      const result = prepareOnboardingServer(CWD, host, {
        ensure: (cwd, options) => {
          ensureCall = { cwd, host: options.host };
          throw errno(code);
        },
      });

      assert.deepEqual(ensureCall, { cwd: CWD, host }, `${host}/${code}: launcher receives the active host and project`);
      assert.equal(result.kind, 'bootstrap-required', `${host}/${code}: permission failure must never throw or become ready`);
      if (result.kind !== 'bootstrap-required') continue;

      const bootstrapCommand = onboardingBootstrapCommand(CWD, host);
      const waitCommand = onboardingWaitCommand(CWD, host);
      assert.equal(result.errorCode, code, `${host}: preserves the filesystem error code`);
      assert.equal(result.bootstrapCommand, bootstrapCommand, `${host}: exposes the canonical bootstrap command`);
      assert.equal(result.waitCommand, waitCommand, `${host}: exposes the canonical waiter command`);
      assert.ok(result.reason.includes(`(${code})`), `${host}: reason names ${code}`);
      assert.ok(result.reason.includes(bootstrapCommand), `${host}: reason embeds the exact bootstrap command`);
      assert.ok(result.reason.includes(waitCommand), `${host}: reason embeds the exact normal waiter command`);
      assert.match(result.reason, /Building(?:, installs, and subagent work)? remains? blocked/, `${host}: recovery remains fail-closed`);

      if (COMPACT_HOSTS.has(host)) {
        assert.ok(result.reason.includes('Run with approval:'), `${host}: compact recipe keeps the approval action`);
        assert.ok(!result.reason.includes('Your NEXT action'), `${host}: compact host does not receive the long multi-host recipe`);
        assert.ok(!result.reason.includes('Codex:'), `${host}: compact host does not receive Codex instructions`);
      } else {
        assert.ok(result.reason.includes('~/.traffic-one/projects'), `${host}: long recipe preserves the canonical private state path`);
        assert.ok(result.reason.includes('do not create'), `${host}: long recipe explicitly forbids a project-local fallback`);
      }
    }
  }
});

test('prepareOnboardingServer: recovery never redirects private state into the project', () => {
  for (const host of HOST_IDS) {
    const result = prepareOnboardingServer(CWD, host, {
      ensure: () => { throw errno('EPERM'); },
    });
    assert.equal(result.kind, 'bootstrap-required');
    if (result.kind !== 'bootstrap-required') continue;

    const forbiddenProjectPaths = [
      path.join(CWD, '.traffic-one', 'preferences.json'),
      path.join(CWD, '.traffic-one', 'machine.json'),
      path.join(CWD, '.traffic-one', 'onboarding'),
    ];
    for (const forbidden of forbiddenProjectPaths) {
      assert.ok(!result.reason.includes(forbidden), `${host}: reason must not contain project-local runtime path ${forbidden}`);
      assert.ok(!result.bootstrapCommand.includes(forbidden), `${host}: bootstrap must not target ${forbidden}`);
      assert.ok(!result.waitCommand.includes(forbidden), `${host}: waiter must not target ${forbidden}`);
    }
    assert.ok(!result.bootstrapCommand.includes('TRAFFIC_ONE_PROJECT_PREFS_PATH='), `${host}: bootstrap must not override preferences into the project`);
    assert.ok(!result.waitCommand.includes('TRAFFIC_ONE_PROJECT_PREFS_PATH='), `${host}: waiter must not override preferences into the project`);
  }
});

test('prepareOnboardingServer: Codex recipe requests escalation with the exact future-project prefix', () => {
  const result = prepareOnboardingServer(CWD, 'codex', {
    ensure: () => { throw errno('EPERM'); },
  });
  assert.equal(result.kind, 'bootstrap-required');
  if (result.kind !== 'bootstrap-required') return;

  const prefix = `["node",${JSON.stringify(onboardingWaitScriptPath())},"--bootstrap-only"]`;
  assert.ok(result.reason.includes('`exec_command`'));
  assert.ok(result.reason.includes('`sandbox_permissions: "require_escalated"`'));
  assert.ok(result.reason.includes('`workdir`'));
  assert.ok(result.reason.includes(`\`${prefix}\``), 'Codex reason carries the narrow reusable approval prefix verbatim');
  assert.ok(result.bootstrapCommand.startsWith(`node '${onboardingWaitScriptPath()}' '--bootstrap-only' `));
  assert.ok(result.bootstrapCommand.includes("'--host=codex'"));
});

test('prepareOnboardingServer: non-permission launcher failures are terminal and never prescribe bootstrap again', () => {
  for (const code of ['ENOENT', 'ENOTDIR', 'START_FAILED']) {
    const error = Object.assign(new Error(`${code}: broken installed runner`), { code });
    const result = prepareOnboardingServer(CWD, 'codex', {
      ensure: () => { throw error; },
    });
    assert.equal(result.kind, 'start-failed', code);
    if (result.kind !== 'start-failed') continue;
    assert.equal(result.errorCode, code);
    assert.match(result.reason, /plugin\/runtime failure/);
    assert.match(result.reason, /doctor|reinstall\/update/);
    assert.doesNotMatch(result.reason, /TRAFFIC_ONE_SETUP_READY|Run this exact bootstrap|sandbox_permissions/);
  }

  const reason = onboardingStartFailureReason(Object.assign(new Error('missing child'), { code: 'ENOENT' }));
  assert.match(reason, /Do NOT rerun `--bootstrap-only`/);
  assert.doesNotMatch(reason, /onboardingBootstrapCommand|TRAFFIC_ONE_SETUP_READY/);

  for (const host of COMPACT_HOSTS) {
    const compact = onboardingStartFailureReason(Object.assign(new Error('missing child'), { code: 'ENOENT' }), host);
    assert.match(compact, /plugin\/runtime failure/);
    assert.match(compact, /doctor|reinstall\/update/);
    assert.doesNotMatch(compact, /Do NOT|TRAFFIC_ONE_SETUP_READY|--bootstrap-only/);
  }
});
