import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ensureOnboardingWaitPermission } from '../wait-permission';
import { onboardingWaitScriptPath } from '../wait-command';
import { shellQuote } from '../../shell-quote';

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
