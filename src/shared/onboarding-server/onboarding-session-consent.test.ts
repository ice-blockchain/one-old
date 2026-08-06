// The pre-consent half of the contract for the onboarding main-session store.
//
// This store was the last writer creating `<project>/.traffic-one/` before the
// user had answered "do you want to use Traffic One here?". Its caller
// (modules/agent-model/subagent-bind.ts) stands down on pluginUseDeclined and had
// NO check for the pending state, and the record itself used raw
// `fs.mkdirSync` + `fs.writeFileSync`, so it went straight past the write fence.
// Measured over every hook entry point × subcommand, a PENDING pristine project
// came back with two paths ADDED — `.traffic-one/` and
// `.traffic-one/.onboarding-main-sessions.json` — on 4 of 7 hosts, showing up as
// untracked in `git status` because the generated .gitignore block is correctly
// NOT written before consent. DECLINED was clean. The state that mattered was the
// one nobody tested.
//
// PENDING is therefore tested FIRST-CLASS here, beside declined and consented: a
// regression that special-cased `enabled === false` — which is exactly the shape
// of the original defect — passes a declined-only suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runClaudeHook } from '../../hooks/claude-entry';
import {
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../state/plugin-use';
import { isForeignOnboardingThread, recordMainOnboardingSession } from './onboarding-session';

const STORE_REL = path.join('.traffic-one', '.onboarding-main-sessions.json');
type Consent = 'pending' | 'declined' | 'consented';

const ENV_KEYS = [
  'HOME', 'XDG_STATE_HOME', 'TRAFFIC_ONE_PROJECT_PREFS_PATH',
  'TRAFFIC_ONE_STATE_PATH', 'TRAFFIC_ONE_ASK_USE_PLUGIN',
] as const;

/** Recursive path + content hash: empty directories count, which is what a raw mkdir leaves. */
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

function withProject(consent: Consent, fn: (project: string) => void | Promise<void>): Promise<void> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbsess-consent-')));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const project = path.join(base, 'project');
  process.env.HOME = path.join(base, 'home');
  process.env.XDG_STATE_HOME = path.join(base, 'xdg');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  delete process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1'; // the shipped default; the preload pins it off suite-wide
  // A pristine project: ordinary source files, NO `.traffic-one/` at all. The
  // regression created the directory, which an existsSync check on an
  // already-populated fixture would never notice.
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# demo\n', 'utf8');
  fs.writeFileSync(path.join(project, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  resetPluginUseCache();
  if (consent !== 'pending') recordPluginUseChoice(project, consent === 'consented', 'test');
  resetPluginUseCache();

  return Promise.resolve(fn(project)).finally(() => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  });
}

for (const consent of ['pending', 'declined'] as const) {
  test(`consent ${consent.toUpperCase()}: recordMainOnboardingSession writes nothing and creates no state dir`, async () => {
    await withProject(consent, (project) => {
      const before = snapshot(project);

      recordMainOnboardingSession(project, 'orchestrator-conv');

      const changed = drift(before, snapshot(project));
      assert.deepEqual(changed, [], `the project must stay byte-identical:\n${changed.join('\n')}`);
      assert.equal(fs.existsSync(path.join(project, '.traffic-one')), false, 'not even an empty state dir');
      // The documented degradation, asserted rather than assumed: with no record,
      // nobody is classified as foreign, so a prematurely-spawned subagent may see
      // the wizard. That is the pre-fix behaviour this function's catch block
      // already accepts as the cost of a failed record.
      assert.equal(isForeignOnboardingThread(project, 'architect-subagent-conv'), false);
    });
  });

  test(`consent ${consent.toUpperCase()}: the real SubagentStart entry point leaves a pristine project byte-identical`, async () => {
    await withProject(consent, async (project) => {
      const before = snapshot(project);

      const result = await runClaudeHook('subagent-start', JSON.stringify({
        hook_event_name: 'SubagentStart',
        cwd: project,
        session_id: 'parent-sess-1',
        subagent_id: 'tool_abc',
        subagent_type: 'senior-backend',
      }));

      assert.equal(result.exitCode, 0, 'SubagentStart must always exit 0');
      const changed = drift(before, snapshot(project));
      assert.deepEqual(changed, [], `a ${consent} project must not be written to:\n${changed.join('\n')}`);
      assert.equal(fs.existsSync(path.join(project, STORE_REL)), false);
    });
  });
}

// The other half, and the reason the two above are not vacuous: with the answer
// on record the store IS written, through the same call. If a change ever makes
// the refusal unconditional, this fails instead of quietly disabling the
// subagent-recognition the store exists for.
test('consent CONSENTED: the record lands and the subagent-recognition it enables works', async () => {
  await withProject('consented', (project) => {
    recordMainOnboardingSession(project, 'orchestrator-conv');

    const store = path.join(project, STORE_REL);
    assert.equal(fs.existsSync(store), true, 'a consented project DOES get the record');
    assert.deepEqual(
      Object.keys((JSON.parse(fs.readFileSync(store, 'utf8')) as { sessions: Record<string, number> }).sessions),
      ['orchestrator-conv'],
    );
    assert.equal(isForeignOnboardingThread(project, 'orchestrator-conv'), false, 'the orchestrator is not foreign');
    assert.equal(isForeignOnboardingThread(project, 'architect-subagent-conv'), true, 'its subagent is');
  });
});

// Answering the question mid-process must take effect immediately: the record is
// refused while pending and lands the moment consent exists, with no new process.
test('recording consent turns the refusal into a write in the same process', async () => {
  await withProject('pending', (project) => {
    recordMainOnboardingSession(project, 'orchestrator-conv');
    assert.equal(fs.existsSync(path.join(project, STORE_REL)), false, 'pending refuses');

    recordPluginUseChoice(project, true, 'test');
    recordMainOnboardingSession(project, 'orchestrator-conv');
    assert.equal(fs.existsSync(path.join(project, STORE_REL)), true, 'consent lands');
  });
});
