import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ensureOnboardingWaitPermission, stripOnboardingWaitPermission } from '../wait-permission';
import { onboardingWaitScriptPath } from '../wait-command';
import { shellQuote } from '../../shell-quote';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';
import { declineOutput } from '../../../runners/onboarding-wait/wizard-output';

const RULE = `Bash(node ${shellQuote(onboardingWaitScriptPath())}:*)`;

function withDir(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-wait-perm-'));
  try { fn(dir); } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readSettings(cwd: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
}

test('writes the wait-runner prefix allow rule for claude and stays idempotent', () => {
  withDir((cwd) => {
    ensureOnboardingWaitPermission(cwd, 'claude');
    const settings = readSettings(cwd);
    const allow = (settings.permissions as Record<string, unknown>).allow as unknown[];
    assert.deepEqual(allow, [RULE]);
    ensureOnboardingWaitPermission(cwd, 'claude');
    const again = (readSettings(cwd).permissions as Record<string, unknown>).allow as unknown[];
    assert.deepEqual(again, [RULE], 'second call adds nothing');
  });
});

test('preserves existing settings keys and allow entries', () => {
  withDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      `${JSON.stringify({ env: { KEEP: '1' }, permissions: { allow: ['Bash(ls:*)'], deny: ['WebFetch'] } }, null, 2)}\n`,
      'utf8',
    );
    ensureOnboardingWaitPermission(cwd, 'claude');
    const settings = readSettings(cwd);
    assert.deepEqual(settings.env, { KEEP: '1' });
    const permissions = settings.permissions as Record<string, unknown>;
    assert.deepEqual(permissions.allow, ['Bash(ls:*)', RULE]);
    assert.deepEqual(permissions.deny, ['WebFetch']);
  });
});

test('does nothing on non-claude hosts', () => {
  withDir((cwd) => {
    ensureOnboardingWaitPermission(cwd, 'codex');
    ensureOnboardingWaitPermission(cwd, 'windsurf');
    assert.equal(fs.existsSync(path.join(cwd, '.claude', 'settings.local.json')), false);
  });
});

const CONSENT_ENV = [
  'TRAFFIC_ONE_ASK_USE_PLUGIN', 'TRAFFIC_ONE_PROJECT_PREFS_PATH', 'HOME', 'XDG_STATE_HOME',
] as const;

function withConsentEnv(askFirst: '0' | '1', fn: (cwd: string) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-wait-perm-consent-'));
  const saved = Object.fromEntries(CONSENT_ENV.map((key) => [key, process.env[key]]));
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = askFirst;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  process.env.HOME = path.join(base, 'home');
  process.env.XDG_STATE_HOME = path.join(base, 'xdg');
  resetPluginUseCache();
  const cwd = path.join(base, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    fn(cwd);
  } finally {
    for (const key of CONSENT_ENV) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('skips the write while the use-plugin question is pending (TRAFFIC_ONE_ASK_USE_PLUGIN=1)', () => {
  withConsentEnv('1', (cwd) => {
    ensureOnboardingWaitPermission(cwd, 'claude');
    assert.equal(fs.existsSync(path.join(cwd, '.claude')), false, 'settings.local.json is not created pre-consent');
  });
});

test('skips the write after a recorded decline', () => {
  withConsentEnv('1', (cwd) => {
    recordPluginUseChoice(cwd, false, 'test');
    resetPluginUseCache();
    ensureOnboardingWaitPermission(cwd, 'claude');
    assert.equal(fs.existsSync(path.join(cwd, '.claude')), false);
  });
});

test('skips the write when existing settings.local.json cannot be parsed', () => {
  withDir((cwd) => {
    const file = path.join(cwd, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const broken = '{ not json';
    fs.writeFileSync(file, broken, 'utf8');
    ensureOnboardingWaitPermission(cwd, 'claude');
    assert.equal(fs.readFileSync(file, 'utf8'), broken, 'unparseable settings are left byte-identical');
  });
});

test('stripOnboardingWaitPermission removes the wait-runner rule and leaves other allow entries', () => {
  withDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)', RULE] } }, null, 2)}\n`,
      'utf8',
    );
    stripOnboardingWaitPermission(cwd);
    const allow = (readSettings(cwd).permissions as Record<string, unknown>).allow as unknown[];
    assert.deepEqual(allow, ['Bash(ls:*)']);
  });
});

test('declineOutput strips the wait-runner rule', () => {
  withConsentEnv('1', (cwd) => {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      `${JSON.stringify({ permissions: { allow: [RULE] } }, null, 2)}\n`,
      'utf8',
    );
    const out = declineOutput(cwd, 'claude');
    assert.match(out, /^TRAFFIC_ONE_DISABLED\n/);
    const allow = (readSettings(cwd).permissions as Record<string, unknown>).allow as unknown[];
    assert.deepEqual(allow, []);
  });
});
