import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { HOST_IDS } from '../../../config/model-tiers';
import type { HostId } from '../../../core/types';
import { onboardingStartFailureReason, prepareOnboardingServer } from '../bootstrap';
import { ONBOARDING_START_TIMEOUT_CODE } from '../ensure';
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

test('prepareOnboardingServer: sync-session reaches ready and permission-fallback commands', () => {
  const syncSession = 'parent-session-42';
  const ready = prepareOnboardingServer(CWD, 'cursor', {
    syncSession,
    ensure: () => ({
      redirectUrl: 'http://127.0.0.1:55174/?t=tok',
      localWizardUrl: 'http://127.0.0.1:55174/local?t=tok',
      dashboardUrl: 'https://traffic.io/onboarding/agent#p=55174&t=tok',
      port: 55174,
      token: 'tok',
      started: true,
    }),
  });
  assert.equal(ready.kind, 'ready');
  if (ready.kind === 'ready') {
    assert.ok(ready.waitCommand.includes(`'--sync-session=${syncSession}'`));
  }

  const fallback = prepareOnboardingServer(CWD, 'codex', {
    syncSession,
    ensure: () => { throw errno('EACCES'); },
  });
  assert.equal(fallback.kind, 'bootstrap-required');
  if (fallback.kind === 'bootstrap-required') {
    assert.ok(fallback.bootstrapCommand.includes(`'--sync-session=${syncSession}'`));
    assert.ok(fallback.waitCommand.includes(`'--sync-session=${syncSession}'`));
    assert.ok(fallback.reason.includes(`'--sync-session=${syncSession}'`));
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

function timeout(): NodeJS.ErrnoException {
  return Object.assign(
    new Error('traffic-one onboarding server did not become ready (another launcher holds the lock)'),
    { code: ONBOARDING_START_TIMEOUT_CODE },
  );
}

test('prepareOnboardingServer: a launcher TIMEOUT is retryable, and says so instead of prescribing a reinstall', () => {
  // The whole point of the split. A timeout used to land in the terminal
  // packaging branch, so routine lock contention — which ensure.ts documents as
  // normal — told the user their plugin was broken and to reinstall it.
  for (const host of HOST_IDS) {
    const result = prepareOnboardingServer(CWD, host, { ensure: () => { throw timeout(); } });
    assert.equal(result.kind, 'start-timeout', `${host}: a timeout is its own classification`);
    if (result.kind !== 'start-timeout') continue;
    assert.equal(result.errorCode, ONBOARDING_START_TIMEOUT_CODE);

    // The retryable half prescribes exactly one retry and rules out the wrong diagnosis.
    assert.match(result.reason, /did not finish starting in time/, `${host}: names the timeout`);
    assert.match(result.reason, /[Rr]etry this exact tool call/, `${host}: prescribes the retry`);
    assert.match(result.reason, /\bonce\b/i, `${host}: bounds it at one`);
    // The compact hosts state it by omission, the rest say it outright; either
    // way the text must never ASSERT a plugin failure the way the terminal one does.
    assert.doesNotMatch(result.reason, /(?<!not a )plugin\/runtime failure/, `${host}: a timeout is not a plugin failure`);
    assert.doesNotMatch(result.reason, /Reinstall\/update/, `${host}: never prescribes a reinstall for a clock`);
    assert.match(result.reason, /will not help|do not reinstall/i, `${host}: says reinstalling is the wrong move`);
    assert.doesNotMatch(result.reason, /Stop and report this error/, `${host}: not terminal`);
    assert.ok(!result.reason.includes(onboardingBootstrapCommand(CWD, host)), `${host}: never re-prescribes bootstrap`);

    // The terminal half is carried alongside, for the surface that BLOCKS to use
    // once the one retry is spent — and it is a different message, not the
    // packaging one, because nothing here says the installation is broken.
    assert.match(result.terminalReason, /timed out again/, `${host}: names what changed`);
    assert.match(result.terminalReason, /[Ss]top/, `${host}: terminal half says stop`);
    assert.match(result.terminalReason, /doctor/, `${host}: keeps the recovery route`);
    assert.doesNotMatch(result.terminalReason, /Retry this exact tool call/, `${host}: terminal half prescribes no retry`);
    assert.notEqual(result.reason, result.terminalReason, `${host}: the two halves are different messages`);
  }
});

test('prepareOnboardingServer: permission and packaging failures are UNAFFECTED by the timeout split', () => {
  // The split must move exactly one population. A sandbox permission error still
  // gets the approved bootstrap recipe, and a broken install is still terminal.
  const permission = prepareOnboardingServer(CWD, 'claude', { ensure: () => { throw errno('EPERM'); } });
  assert.equal(permission.kind, 'bootstrap-required');

  for (const code of ['ENOENT', 'ENOTDIR', 'START_FAILED']) {
    const result = prepareOnboardingServer(CWD, 'claude', {
      ensure: () => { throw Object.assign(new Error(`${code}: broken installed runner`), { code }); },
    });
    assert.equal(result.kind, 'start-failed', `${code} stays terminal`);
    if (result.kind !== 'start-failed') continue;
    assert.match(result.reason, /plugin\/runtime failure/);
    assert.doesNotMatch(result.reason, /Retry this exact tool call/);
  }
});
