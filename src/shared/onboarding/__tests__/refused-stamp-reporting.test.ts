// What onboarding REPORTS when the fence refuses its state write.
//
// Four publishers, one subject: the decision that turns a directory into a
// Traffic One project. Each returned an outcome describing state it had not
// managed to persist — `stamped: true`, `ok: true`, a materialize outcome — and
// each of the four is read by something that then finds the field missing and
// re-asks for it, with nothing in either message naming the write that failed.
//
// FENCING: one named path per case, always MOVE-ASIDE for `.one.json`. `writeState`
// re-reads the file it replaces (preserveCurrentRunId) and every publisher here
// reads it before that, so a dangling link would make the READ fail and the
// publisher would bail on its own precondition — a vacuous pass the writable
// baseline cannot catch, because the baseline is a different directory.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readState, statePath, writeState } from '../../state';
import { recordPluginUseChoice } from '../../state/plugin-use';
import { applyAgentTechClassification, stampExistingCodebaseDetection } from '../detection-stamp';
import { repairNewProjectOnboardingState } from '../repair';
import { initializeToolchainState } from '../../state/toolchain';
import { applyAnswer } from '../../onboarding-server/flow';

const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function project(label: string): string {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-refused-stamp-${label}-`)));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  return cwd;
}

/** Fence a path whose CONTENT the writer reads before writing it. */
function fenceMoveAside(target: string): void {
  const aside = `${target}.aside`;
  const before = fs.readFileSync(target, 'utf8');
  fs.renameSync(target, aside);
  fs.symlinkSync(aside, target);
  assert.ok(fs.lstatSync(target).isSymbolicLink(), 'fixture guard: a link is planted');
  assert.equal(fs.readFileSync(target, 'utf8'), before,
    'fixture guard: reads still resolve through the link, so the writer reaches its write');
}

function withScopedPrefs(fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-refused-stamp-prefs-'));
  fixtures.push(dir);
  const previous = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previous;
  }
}

// ── detection-stamp.ts#stampExistingCodebaseDetection ───────────────────────
// `write-failed` already existed in the result type and was reachable only from
// the catch — so the commonest way this write does not happen came back as
// `stamped: true` over a `.one.json` with no mode, no stack and no
// onboardingComplete: the exact state materializeProjectIfNeeded bails on and
// isOnboardedProjectRoot rejects, which is the pair the module header says it
// exists to close.

function seedDetectableProject(label: string): string {
  const cwd = project(label);
  recordPluginUseChoice(cwd, true, 'refused-stamp-test');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'detectable', private: true,
    dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0', express: '^4.18.0' },
    devDependencies: { vite: '^5.0.0' },
  }), 'utf8');
  fs.writeFileSync(statePath(cwd), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
  return cwd;
}

test('a detection stamp the fence refused is not reported as stamped', () => {
  withScopedPrefs(() => {
    const open = seedDetectableProject('detect-baseline');
    const baseline = stampExistingCodebaseDetection(open);
    assert.equal(baseline.stamped, true, 'writable baseline: an unfenced stamp lands');
    assert.equal(readState(open).onboardingComplete, true,
      'writable baseline: and .one.json carries the onboardingComplete the result claims');

    const fenced = seedDetectableProject('detect-fenced');
    fenceMoveAside(statePath(fenced));
    assert.equal(readState(fenced).mode, 'existing-codebase',
      'fixture guard: the read still resolves, so detection reaches its write');

    const result = stampExistingCodebaseDetection(fenced);
    assert.equal(result.stamped, false,
      'a stamp the fence refused must not be reported as stamped');
    assert.equal(result.reason, 'write-failed',
      'and the reason the result type already had for this is the one it gets');
    assert.ok(result.detected?.stack,
      'the detection itself is still handed back — only the persist failed');
    assert.equal(readState(fenced).onboardingComplete, undefined,
      'fixture guard: the project really is still unonboarded on disk');
  });
});

// ── detection-stamp.ts#applyAgentTechClassification ─────────────────────────
// `ok: true` told the agent its classification was committed; the very next call
// re-reads a stack-less state and routes the same codebase back to 'tech-detect',
// so the agent is asked to classify it again with no explanation.

test('an agent tech classification the fence refused is not reported ok', () => {
  withScopedPrefs(() => {
    const submission = { frontend: 'react-vite', backend: 'node', evidence: 'express in package.json' };

    const seed = (label: string): string => {
      const cwd = project(label);
      recordPluginUseChoice(cwd, true, 'refused-stamp-test');
      // A project in its OWN right, or the eligibility guards decline before the
      // write and the case proves nothing.
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: label, private: true }), 'utf8');
      fs.writeFileSync(statePath(cwd), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
      return cwd;
    };

    const open = seed('classify-baseline');
    const baseline = applyAgentTechClassification(open, submission);
    assert.equal(baseline.ok, true, 'writable baseline: an unfenced classification is committed');
    assert.equal(typeof readState(open).stack, 'string',
      'writable baseline: and .one.json carries the stack the result names');

    const fenced = seed('classify-fenced');
    fenceMoveAside(statePath(fenced));
    assert.equal(readState(fenced).mode, 'existing-codebase',
      'fixture guard: the read still resolves, so the classification reaches its write');

    const result = applyAgentTechClassification(fenced, submission);
    assert.equal(result.ok, false,
      'a classification the fence refused must not be reported as committed');
    assert.equal(result.ok === false ? result.reason : '', 'write-failed');
    assert.equal(readState(fenced).stack, undefined,
      'fixture guard: the next caller really would route this codebase back to tech-detect');
  });
});

// ── repair.ts#repairNewProjectOnboardingState ───────────────────────────────
// The repair IS the canonical rewrite; materializing is what FOLLOWS from it. A
// refused write left the noncanonical state on disk and still handed back a
// materialize outcome, which the gate reads as "repaired, retry".

// The same repairable shape repair.test.ts pins as repairable, so this case
// cannot drift into proving "unrepairable state returns null" instead.
const REPAIRABLE_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: false, framework: 'none', source: 'prompted' },
  technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
  projectContext: {
    source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z',
  },
  openCode: { enabled: false, source: 'prompted' },
  codeGraphProvider: 'graphify',
  team: { mode: 'subagents', source: 'prompted', approved: true },
  performance: { level: 'high', source: 'prompted' },
  toolchain: Object.fromEntries(
    Object.keys(initializeToolchainState({})).map((key) => [key, { installedVersion: '1', installedAt: 'now' }]),
  ),
  confirmed: true,
  onboardingComplete: true,
  confirmedAt: '2026-01-01T00:00:00Z',
};

test('a repair whose canonical rewrite was refused is reported as unrepairable', () => {
  withScopedPrefs(() => {
    const open = project('repair-baseline');
    recordPluginUseChoice(open, true, 'refused-stamp-test');
    fs.writeFileSync(statePath(open), JSON.stringify(REPAIRABLE_STATE), 'utf8');
    const baseline = repairNewProjectOnboardingState(open, REPAIRABLE_STATE, 'baseline');
    assert.ok(baseline, 'writable baseline: a repairable state is repaired and materialized');

    const fenced = project('repair-fenced');
    recordPluginUseChoice(fenced, true, 'refused-stamp-test');
    fs.writeFileSync(statePath(fenced), JSON.stringify(REPAIRABLE_STATE), 'utf8');
    fenceMoveAside(statePath(fenced));

    assert.equal(repairNewProjectOnboardingState(fenced, REPAIRABLE_STATE, 'fenced'), null,
      'a repair whose rewrite the fence refused is not a repair, and null is what this function already says that with');
  });
});

// ── onboarding-server/flow.ts#applyAnswer('finalize') ──────────────────────
// `finalize` is the wizard's commit: the write IS the stack decision. `{ ok: true }`
// over a refused one told the user their project was set up while `.one.json`
// carried no stack — after which every gate reads an unonboarded project and
// re-opens the wizard, with nothing anywhere naming the refused write.

test('a wizard finalize the fence refused is not reported ok', () => {
  withScopedPrefs(() => {
    const seed = (label: string): string => {
      const cwd = project(label);
      recordPluginUseChoice(cwd, true, 'refused-stamp-test');
      assert.ok(writeState(cwd, {
        mode: 'new-project',
        projectContext: { originalPrompt: 'build a saas with users, billing and an admin dashboard' },
      }), 'fixture guard: the pre-finalize wizard state is on disk');
      return cwd;
    };

    const open = seed('finalize-baseline');
    assert.deepEqual(applyAnswer(open, 'finalize', true), { ok: true },
      'writable baseline: an unfenced finalize commits');
    assert.equal(typeof readState(open).stack, 'string',
      'writable baseline: and the stack it derived is on disk — the decision this step exists for');

    const fenced = seed('finalize-fenced');
    fenceMoveAside(statePath(fenced));
    assert.equal(readState(fenced).mode, 'new-project',
      'fixture guard: the read still resolves, so finalize reaches its write');

    const outcome = applyAnswer(fenced, 'finalize', true);
    assert.equal(outcome.ok, false,
      'a finalize the fence refused must not report the project as set up');
    assert.match(String(outcome.error), /\.one\.json/,
      'and the error names the exact refused path, so the user can act on it');
    assert.equal(readState(fenced).stack, undefined,
      'fixture guard: the stack really was not committed');
  });
});

// ── onboarding-server/flow.ts#applyAnswer — the three steps behind patchSharedState ──
// Same function, same defect, one indirection deeper: `patchSharedState` was
// `void`, so writeState's refusal died in the helper and these three steps
// returned `{ ok: true }` over it. The scanner cannot see through a void helper
// (that is the shape that hid all fifteen sites), so guarding only `finalize`
// would have made this function look clean while three of its steps still
// fabricated success — hence they are pinned here, per step.
//
// `open-code` is the expensive one: the field it fails to write is the durable
// authorization the spawn gate cites, so delegation is later denied as "not
// explicitly authorized" for a permission the user did grant.

test('every wizard step whose answer the fence refused reports it, not ok', () => {
  withScopedPrefs(() => {
    const steps: Array<{ step: string; value: unknown; field: string }> = [
      { step: 'open-code', value: true, field: 'openCodeDelegation' },
      { step: 'project-context', value: { originalPrompt: 'build a saas', answers: { audience: 'small teams' } }, field: 'projectContext' },
      { step: 'mobile', value: 'web_only', field: 'mobile' },
    ];

    for (const { step, value, field } of steps) {
      const seed = (label: string): string => {
        const cwd = project(label);
        recordPluginUseChoice(cwd, true, 'refused-stamp-test');
        assert.ok(writeState(cwd, { mode: 'new-project' }), 'fixture guard: the wizard state is on disk');
        return cwd;
      };

      const open = seed(`${step}-baseline`);
      assert.deepEqual(applyAnswer(open, step, value), { ok: true }, `writable baseline: ${step} is accepted`);
      assert.notEqual(readState(open)[field], undefined,
        `writable baseline: ${step} really records ${field} — the thing the refused direction loses`);

      const fenced = seed(`${step}-fenced`);
      fenceMoveAside(statePath(fenced));
      assert.equal(readState(fenced).mode, 'new-project',
        `fixture guard: the read still resolves, so ${step} reaches its write`);

      const outcome = applyAnswer(fenced, step, value);
      assert.equal(outcome.ok, false, `${step} must not report an answer the fence refused as accepted`);
      assert.match(String(outcome.error), /\.one\.json/, `and ${step}'s error names the exact refused path`);
      assert.equal(readState(fenced)[field], undefined, `fixture guard: ${field} really was not recorded`);
    }
  });
});
