// Pre-consent waiter: exit 2 with the use-plugin question, and do not spawn
// the wizard / print the link / write settings. `--bootstrap-only` is not an
// answer. TRAFFIC_ONE_ASK_USE_PLUGIN is named here because this file reads
// usePluginQuestionPending / projectWritesPermitted via abortIfConsentPending.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { abortIfConsentPending, main } from '../index';
import { usePluginQuestion } from '../../../shared/onboarding-server/wait-command';
import { usePluginQuestionPending } from '../../../shared/onboarding-server/flow';
import {
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../../../shared/state/plugin-use';

const ENV_KEYS = [
  'HOME', 'XDG_STATE_HOME', 'TRAFFIC_ONE_PROJECT_PREFS_PATH',
  'TRAFFIC_ONE_STATE_PATH', 'TRAFFIC_ONE_ASK_USE_PLUGIN',
  'TRAFFIC_ONE_ONBOARDING_NO_SPAWN',
] as const;

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { out.set(`${key}/`, '<dir>'); walk(abs, key); continue; }
      out.set(key, crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
    }
  };
  walk(root, '');
  return out;
}

function drift(before: Map<string, string>, after: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const [p, h] of after) {
    if (!before.has(p)) lines.push(`ADDED    ${p}`);
    else if (before.get(p) !== h) lines.push(`CHANGED  ${p}`);
  }
  for (const p of before.keys()) if (!after.has(p)) lines.push(`REMOVED  ${p}`);
  return lines.sort();
}

function withPendingProject(fn: (project: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-wait-index-')));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# demo\n', 'utf8');
  process.env.HOME = path.join(base, 'home');
  process.env.XDG_STATE_HOME = path.join(base, 'xdg');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  delete process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  resetPluginUseCache();
  try {
    fn(project);
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function runMain(argv: readonly string[]): { code: number | undefined; stdout: string } {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const exit = process.exit;
  let code: number | undefined;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((status?: number): never => {
    code = status ?? 0;
    throw new Error(`__exit_${String(code)}`);
  }) as typeof process.exit;
  try {
    main([...argv]);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('__exit_')) throw error;
  } finally {
    process.stdout.write = write;
    process.exit = exit;
  }
  return { code, stdout: chunks.join('') };
}

test('abortIfConsentPending is true only when the question is open and argv is not the answer', () => {
  withPendingProject((project) => {
    assert.equal(usePluginQuestionPending(project), true);
    assert.equal(abortIfConsentPending(project, [project]), true);
    assert.equal(abortIfConsentPending(project, ['--bootstrap-only', project]), true);
    assert.equal(abortIfConsentPending(project, ['--use', project]), false);
    assert.equal(abortIfConsentPending(project, ['--decline', project]), false);
    assert.equal(abortIfConsentPending(project, ['--reconsider', project]), false);

    recordPluginUseChoice(project, true, 'test');
    resetPluginUseCache();
    assert.equal(usePluginQuestionPending(project), false);
    assert.equal(abortIfConsentPending(project, ['--bootstrap-only', project]), false);
  });
});

test('main exits 2 with the use-plugin question and writes nothing when pending + --bootstrap-only', () => {
  withPendingProject((project) => {
    const before = snapshot(project);
    const { code, stdout } = runMain(['--bootstrap-only', project, '--host=claude']);
    assert.equal(code, 2);
    assert.equal(stdout, `${usePluginQuestion(project, 'claude')}\n`);
    assert.doesNotMatch(stdout, /^TRAFFIC_ONE_SETUP_/m);
    const changed = drift(before, snapshot(project));
    assert.deepEqual(changed, [], `pre-consent bootstrap must not write the project:\n${changed.join('\n')}`);
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);
    assert.equal(fs.existsSync(path.join(project, '.traffic-one')), false);
  });
});

test('main exits 2 with the use-plugin question when pending and argv has no consent flag', () => {
  withPendingProject((project) => {
    const before = snapshot(project);
    const { code, stdout } = runMain([project, '--host=claude']);
    assert.equal(code, 2);
    assert.equal(stdout, `${usePluginQuestion(project, 'claude')}\n`);
    assert.doesNotMatch(stdout, /^TRAFFIC_ONE_SETUP_/m);
    const changed = drift(before, snapshot(project));
    assert.deepEqual(changed, [], `a flagless pending wait must not write the project:\n${changed.join('\n')}`);
  });
});
