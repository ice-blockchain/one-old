import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { writeSimpleAuth } from '../../auth';
import { readJsonResult } from '../../fsjson';
import { readProjectPrefs, readState, statePath, writeState } from '../../state';
import { recordPluginUseChoice } from '../../state/plugin-use';
import { applyAnswer, computeOnboarding } from '../flow';
import {
  classifyWizardStateWriteRefusal,
  persistWizardSharedFields,
  tornBytesCarryCommittedStack,
  wizardSharedWriteWillNotHeal,
  wizardStateWriteRefused,
} from '../wizard-state-write';

const HOST_ENV_KEYS = [
  'TRAFFIC_ONE_HOST',
  'CURSOR_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_THREAD_ID',
  'TRAFFIC_ONE_WINDSURF_BACKEND',
] as const;

const STACKED_TORN = '{"mode":"new-project","stack":"default","onboardingComplete":tr';
const FIRST_TIME_TORN = '{"mode":"new';

const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function isolate(cwd: string): () => void {
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  for (const key of HOST_ENV_KEYS) setEnv(key, undefined);
  setEnv('TRAFFIC_ONE_PROJECT_PREFS_PATH', path.join(cwd, 'prefs.json'));
  setEnv('TRAFFIC_ONE_STATE_PATH', path.join(cwd, 'one.json'));
  setEnv('XDG_STATE_HOME', path.join(cwd, 'state'));
  setEnv('TRAFFIC_ONE_USER_PLAN', 'max');
  writeSimpleAuth('sk-wizard-state-write-fixture');
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function project(label: string): { cwd: string; restore: () => void } {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-wizard-state-${label}-`)));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  const restore = isolate(cwd);
  recordPluginUseChoice(cwd, true, 'wizard-state-write-test');
  return { cwd, restore };
}

function fenceMoveAside(target: string): void {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the writer reaches its write');
}

function delegationOf(cwd: string): Record<string, unknown> | null {
  const raw = readState(cwd).openCodeDelegation;
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
}

test('tornBytesCarryCommittedStack inspects raw text, not a parsed object', () => {
  assert.equal(tornBytesCarryCommittedStack(STACKED_TORN), true,
    'the stacked-torn example the contract names must match');
  assert.equal(tornBytesCarryCommittedStack('{"mode":"new-project","stack":"defa'), true,
    'a torn value that has already started is still a committed stack');
  assert.equal(tornBytesCarryCommittedStack('{"stack":"default"}'), true);
  assert.equal(tornBytesCarryCommittedStack(''), false);
  assert.equal(tornBytesCarryCommittedStack('   '), false);
  assert.equal(tornBytesCarryCommittedStack('""'), false);
  assert.equal(tornBytesCarryCommittedStack('{'), false);
  assert.equal(tornBytesCarryCommittedStack(FIRST_TIME_TORN), false);
  assert.equal(tornBytesCarryCommittedStack('{"stack":""}'), false);
  assert.equal(tornBytesCarryCommittedStack('{"stack":"   "}'), false);
  assert.equal(tornBytesCarryCommittedStack('{"stack":null}'), false);
});

test('persistWizardSharedFields heals first-time empty/torn and refuses stacked-torn', () => {
  const empty = project('persist-empty');
  try {
    fs.writeFileSync(statePath(empty.cwd), '', 'utf8');
    assert.equal(readJsonResult(statePath(empty.cwd)).kind, 'corrupt');
    assert.equal(persistWizardSharedFields(empty.cwd, { openCodeDelegation: { approved: true } }), true);
    assert.equal(delegationOf(empty.cwd)?.approved, true);
    assert.equal(fs.readFileSync(`${statePath(empty.cwd)}.corrupt`, 'utf8'), '');
  } finally {
    empty.restore();
  }

  const torn = project('persist-first-torn');
  try {
    fs.writeFileSync(statePath(torn.cwd), FIRST_TIME_TORN, 'utf8');
    assert.equal(persistWizardSharedFields(torn.cwd, { openCodeDelegation: { approved: true } }), true);
    assert.equal(delegationOf(torn.cwd)?.approved, true);
    assert.equal(fs.readFileSync(`${statePath(torn.cwd)}.corrupt`, 'utf8'), FIRST_TIME_TORN);
  } finally {
    torn.restore();
  }

  const stacked = project('persist-stacked-torn');
  try {
    fs.writeFileSync(statePath(stacked.cwd), STACKED_TORN, 'utf8');
    assert.equal(persistWizardSharedFields(stacked.cwd, { openCodeDelegation: { approved: true } }), false);
    assert.equal(fs.readFileSync(statePath(stacked.cwd), 'utf8'), STACKED_TORN);
    assert.equal(fs.existsSync(`${statePath(stacked.cwd)}.corrupt`), false);
  } finally {
    stacked.restore();
  }
});

test('classifyWizardStateWriteRefusal names `.one.json` / `.traffic-one` on every arm', () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizard-state-pending-')));
  fixtures.push(bare);
  const pendingEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TRAFFIC_ONE_ASK_USE_PLUGIN: '1',
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(bare, 'prefs.json'),
  };
  const pendingMessage = classifyWizardStateWriteRefusal(bare, pendingEnv);
  assert.match(String(pendingMessage), /Use Traffic One here/);
  assert.match(String(pendingMessage), /\.one\.json|\.traffic-one/);

  const stacked = project('classify-stacked');
  try {
    fs.writeFileSync(statePath(stacked.cwd), STACKED_TORN, 'utf8');
    const message = classifyWizardStateWriteRefusal(stacked.cwd);
    assert.match(String(message), /could not be read/);
    assert.match(String(message), /\.one\.json/);
    assert.equal(wizardSharedWriteWillNotHeal(stacked.cwd), true);
    assert.match(wizardStateWriteRefused('your OpenCode delegation answer', stacked.cwd).error,
      /was not recorded/);
  } finally {
    stacked.restore();
  }

  const empty = project('classify-empty');
  try {
    fs.writeFileSync(statePath(empty.cwd), '', 'utf8');
    assert.match(String(classifyWizardStateWriteRefusal(empty.cwd)), /could not be read/);
    assert.equal(wizardSharedWriteWillNotHeal(empty.cwd), false,
      'first-time empty is the one classifier hit that still heals');
  } finally {
    empty.restore();
  }

  const enclosedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizard-state-enclose-')));
  fixtures.push(enclosedRoot);
  const restore = isolate(enclosedRoot);
  try {
    fs.writeFileSync(path.join(enclosedRoot, 'package.json'), JSON.stringify({ name: 'outer', private: true }), 'utf8');
    const child = path.join(enclosedRoot, 'pkg');
    fs.mkdirSync(child);
    const message = classifyWizardStateWriteRefusal(child);
    assert.match(String(message), /inside another project/);
    assert.match(String(message), new RegExp(enclosedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(String(message), /\.one\.json|\.traffic-one/);
  } finally {
    restore();
  }
});

test('applyAnswer(open-code) refuses a child inside another project before prefs land', () => {
  const parent = project('creation-veto-parent');
  try {
    fs.writeFileSync(path.join(parent.cwd, 'package.json'), JSON.stringify({ name: 'outer', private: true }), 'utf8');
    const child = path.join(parent.cwd, 'pkg');
    fs.mkdirSync(child);
    assert.equal(fs.existsSync(statePath(child)), false, 'fixture guard: the child has no .one.json');
    const outcome = applyAnswer(child, 'open-code', true);
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.error), /inside another project/);
    assert.match(String(outcome.error), new RegExp(parent.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(readProjectPrefs(child).openCode, undefined,
      'prefs must not answer the step when the creation veto refused the shared write');
  } finally {
    parent.restore();
  }
});

test('applyAnswer(open-code) does not write prefs when the `.one.json` fence refuses', () => {
  const { cwd, restore } = project('write-order');
  try {
    assert.ok(writeState(cwd, { mode: 'new-project' }), 'fixture guard: the wizard state is on disk');
    fenceMoveAside(statePath(cwd));
    const outcome = applyAnswer(cwd, 'open-code', true);
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.error), /\.one\.json/);
    assert.equal(readProjectPrefs(cwd).openCode, undefined,
      'prefs must not answer the step when the shared authorization never landed');
    assert.equal(computeOnboarding(cwd).step, 'open-code');
    assert.equal(delegationOf(cwd), null);
  } finally {
    restore();
  }
});

test('applyAnswer(open-code) creates `.one.json` on a consented existing-codebase with no state file', () => {
  const { cwd, restore } = project('absent-existing');
  try {
    fs.rmSync(path.join(cwd, '.traffic-one'), { recursive: true, force: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'existing', private: true }), 'utf8');
    assert.equal(readJsonResult(statePath(cwd)).kind, 'absent', 'fixture guard: there is no .one.json yet');
    assert.equal(applyAnswer(cwd, 'open-code', 'enable').ok, true);
    const onDisk = JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')) as { openCodeDelegation?: { approved?: boolean } };
    assert.equal(onDisk.openCodeDelegation?.approved, true);
  } finally {
    restore();
  }
});

test('applyAnswer(open-code) heals an empty first-time `.one.json` and quarantines the old bytes', () => {
  const { cwd, restore } = project('empty-heal');
  try {
    fs.writeFileSync(statePath(cwd), '', 'utf8');
    assert.equal(readJsonResult(statePath(cwd)).kind, 'corrupt', 'fixture guard: empty reads as corrupt');
    assert.equal(applyAnswer(cwd, 'open-code', true).ok, true);
    assert.equal(delegationOf(cwd)?.approved, true);
    assert.equal(fs.existsSync(`${statePath(cwd)}.corrupt`), true);
    assert.equal(fs.readFileSync(`${statePath(cwd)}.corrupt`, 'utf8'), '');
    assert.equal(readProjectPrefs(cwd).openCode != null, true);
  } finally {
    restore();
  }
});

test('applyAnswer(open-code) heals a torn first-time `.one.json` that has no stack', () => {
  const { cwd, restore } = project('first-torn-heal');
  try {
    fs.writeFileSync(statePath(cwd), FIRST_TIME_TORN, 'utf8');
    assert.equal(applyAnswer(cwd, 'open-code', true).ok, true);
    assert.equal(delegationOf(cwd)?.approved, true);
    assert.equal(fs.readFileSync(`${statePath(cwd)}.corrupt`, 'utf8'), FIRST_TIME_TORN);
  } finally {
    restore();
  }
});

test('applyAnswer(open-code) refuses a torn `.one.json` whose raw bytes already carry a stack', () => {
  const { cwd, restore } = project('stacked-torn-refuse');
  try {
    fs.writeFileSync(statePath(cwd), STACKED_TORN, 'utf8');
    const outcome = applyAnswer(cwd, 'open-code', true);
    assert.equal(outcome.ok, false);
    assert.match(String(outcome.error), /could not be read|\.one\.json/);
    assert.equal(fs.readFileSync(statePath(cwd), 'utf8'), STACKED_TORN);
    assert.equal(fs.existsSync(`${statePath(cwd)}.corrupt`), false);
    assert.equal(readProjectPrefs(cwd).openCode, undefined);
    assert.equal(computeOnboarding(cwd).step, 'open-code');
  } finally {
    restore();
  }
});
