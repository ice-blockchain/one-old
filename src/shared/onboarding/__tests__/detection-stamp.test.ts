import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyAgentTechClassification, applyExistingCodebaseDetection, stampExistingCodebaseDetection } from '../detection-stamp';
import { computeOnboarding } from '../../onboarding-server/flow';
import { recordPluginUseChoice } from '../../state/plugin-use';
import { readEffectiveState, readState, writeState } from '../../state';
import { writeSimpleAuth } from '../../auth';

// A project onboarded in ONE sitting used to keep a bare `{originalPrompt, version}`
// seed: SessionStart writes nothing while the use-plugin question is pending, and the
// wizard only writes local prefs. That left materializeProjectIfNeeded bailing forever
// and a mode-less `.one.json` unable to anchor root resolution.

function withProject(
  fn: (cwd: string) => void,
  opts: { files?: Record<string, string>; consent?: boolean | 'declined' } = {},
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stamp-'));
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  writeSimpleAuth('sk-stamp-fixture');
  try {
    for (const [rel, body] of Object.entries(opts.files || {})) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, 'utf8');
    }
    if (opts.consent === true) recordPluginUseChoice(dir, true, 'command');
    if (opts.consent === 'declined') recordPluginUseChoice(dir, false, 'command');
    fn(dir);
  } finally {
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// >5 source files so detectMode says existing-codebase, plus a Laravel manifest so
// detectStackFromCodebase resolves a real stack.
function laravelFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
    'resources/views/welcome.blade.php': '<h1>hi</h1>',
  };
  for (let i = 0; i < 7; i += 1) files[`app/Model${i}.php`] = '<?php\n';
  return files;
}

// Same file count, no framework manifest → detectStackFromCodebase finds nothing.
function sparseFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < 7; i += 1) files[`scripts/util${i}.py`] = 'print(1)\n';
  return files;
}

test('stamps a detectable existing codebase once consent is recorded', () => {
  withProject((cwd) => {
    const result = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true });
    assert.equal(result.stamped, true);
    const state = readState(cwd);
    assert.equal(state.mode, 'existing-codebase');
    assert.equal(state.backend, 'laravel');
    assert.equal(state.confirmed, true);
    assert.equal(state.onboardingComplete, true);
    assert.equal(state.autoDetected, true);
    assert.ok(String(state.confirmedAt || '').length > 0);
    assert.equal((state.lifecycle as Record<string, unknown>)?.source, 'existing-detected');
    assert.equal((state.lifecycle as Record<string, unknown>)?.phase, 'maintenance');
    // toolchain is a LOCAL pref — it must not leak into the committed .one.json.
    assert.equal('toolchain' in state, false);
  }, { files: laravelFiles(), consent: true });
});

test('writes nothing before consent is recorded, and never for a declined project', () => {
  withProject((cwd) => {
    const pending = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true });
    assert.equal(pending.stamped, false);
    assert.equal(pending.reason, 'consent-missing');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'a pending answer must leave the repo byte-identical');
  }, { files: laravelFiles() });

  withProject((cwd) => {
    const declined = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true });
    assert.equal(declined.stamped, false);
    assert.equal(declined.reason, 'declined');
  }, { files: laravelFiles(), consent: 'declined' });
});

test('an undetectable repo is left unstamped and routes to AGENT classification', () => {
  withProject((cwd) => {
    const result = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true });
    assert.equal(result.stamped, false);
    assert.equal(result.reason, 'undetectable');
    assert.ok(result.detected, 'the partial detection rides the skip as classification hints');
    assert.equal(readState(cwd).stack, undefined);
    const view = computeOnboarding(cwd);
    assert.equal(view.done, false, 'undetectable no longer reads as done — that was the half-onboarded hole');
    assert.equal(view.step, 'tech-detect');
  }, { files: sparseFiles(), consent: true });
});

test('agent classification stamps the submitted surfaces with autoDetected:false', () => {
  withProject((cwd) => {
    const result = applyAgentTechClassification(cwd, {
      frontend: 'none',
      backend: 'node',
      realtime: 'light',
      evidence: 'express + mongoose in package.json',
    }, { requireRecordedConsent: true });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.stack, 'custom-backend', 'stack DERIVED from surfaces, never agent-supplied');
      assert.equal(result.alreadyClassified, false);
    }
    const state = readState(cwd);
    assert.equal(state.mode, 'existing-codebase');
    assert.equal(state.backend, 'node');
    assert.equal(state.realtime, 'light');
    assert.equal(state.autoDetected, false);
    assert.equal(state.onboardingComplete, true);
    assert.equal((state.lifecycle as Record<string, unknown>)?.phase, 'maintenance');
    assert.match(String((state.evidence as string[])[0]), /agent-classified: .*express \+ mongoose/);
    // The classification unblocks the SHORT wizard (local preference steps).
    assert.equal(computeOnboarding(cwd).step, 'open-code');
  }, { files: sparseFiles(), consent: true });
});

test('agent classification rejects unknown ids, all-none, and never overwrites a committed stack', () => {
  withProject((cwd) => {
    const badId = applyAgentTechClassification(cwd, { frontend: 'reactjs', backend: 'node' });
    assert.equal(badId.ok, false);
    if (!badId.ok) assert.equal(badId.reason, 'invalid-submission');

    const allNone = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'none' });
    assert.equal(allNone.ok, false);
    if (!allNone.ok) assert.match(String(allNone.issues?.[0]), /at least one surface/);

    const first = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'go' });
    assert.equal(first.ok && first.stack, 'custom-backend');
    const second = applyAgentTechClassification(cwd, { frontend: 'react-vite', backend: 'none' });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.alreadyClassified, true, 'a committed stack wins — deterministic-first, race-safe');
      assert.equal(second.stack, 'custom-backend');
    }
    assert.equal(readState(cwd).backend, 'go');
  }, { files: sparseFiles(), consent: true });
});

// The correction path. Without it the FIRST writer is the last, and the first
// writer is normally `detectStackFromCodebase` — which stamps `confirmed: true`
// with nobody asked, the wizard's existing-codebase branch never revisits the
// stack, and `finalize` preserves whatever is already committed. So a
// misdetection was durable and indistinguishable from a user's own answer.
test('--force lets an explicit submission CORRECT a stack a probe committed', () => {
  withProject((cwd) => {
    // The probe gets there first, exactly as the runner does on every call.
    assert.equal(stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true }).stamped, true);
    assert.equal(readState(cwd).backend, 'laravel');
    assert.equal(readState(cwd).autoDetected, true, 'the premise: this identity came from a probe, not from anyone being asked');

    const refused = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'go' });
    assert.equal(refused.ok, true);
    if (refused.ok) {
      assert.equal(refused.alreadyClassified, true, 'without --force the committed stack still wins — the race guard is unchanged');
      assert.equal(
        refused.discardedStack,
        'custom-backend',
        'a submission DROPPED for disagreeing must report the stack it would have set — "you agree" and "you are overruled" cannot both be a bare ok:true',
      );
    }
    assert.equal(readState(cwd).backend, 'laravel', 'and nothing was written');

    const forced = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'go', evidence: 'go.mod at the root' }, { force: true });
    assert.equal(forced.ok, true);
    if (forced.ok) {
      assert.equal(forced.stack, 'custom-backend', '--force applies the submission');
      assert.equal(forced.alreadyClassified, false);
      assert.equal(forced.discardedStack, undefined, 'nothing was discarded — the submission won');
    }
    const state = readState(cwd);
    assert.equal(state.backend, 'go', 'the correction reached .one.json');
    assert.equal(state.frontend, 'none');
    assert.equal(state.autoDetected, false, 'the corrected identity is no longer a probe guess');
    assert.match(String((state.evidence as string[])[0]), /agent-classified: .*go\.mod at the root/);
  }, { files: laravelFiles(), consent: true });
});

test('a resubmission that AGREES with the record is not reported as a discarded correction', () => {
  withProject((cwd) => {
    const first = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'go' });
    assert.equal(first.ok && first.stack, 'custom-backend');
    const again = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'go' });
    assert.equal(again.ok, true);
    if (again.ok) {
      assert.equal(again.alreadyClassified, true);
      assert.equal(again.discardedStack, undefined, 'agreement must stay distinguishable from being overruled');
    }
  }, { files: sparseFiles(), consent: true });
});

test('agent classification enforces the same consent/decline/mode guards as the stamp', () => {
  withProject((cwd) => {
    const pending = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'node' }, { requireRecordedConsent: true });
    assert.equal(pending.ok, false);
    if (!pending.ok) assert.equal(pending.reason, 'consent-missing');
  }, { files: sparseFiles() });

  withProject((cwd) => {
    const declined = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'node' });
    assert.equal(declined.ok, false);
    if (!declined.ok) assert.equal(declined.reason, 'declined');
  }, { files: sparseFiles(), consent: 'declined' });

  withProject((cwd) => {
    const newProject = applyAgentTechClassification(cwd, { frontend: 'none', backend: 'node' });
    assert.equal(newProject.ok, false);
    if (!newProject.ok) assert.equal(newProject.reason, 'not-existing-mode');
  }, { files: { 'README.md': '# empty' }, consent: true });
});

test('a new project is skipped — its stack is owned by the wizard finalize answer', () => {
  withProject((cwd) => {
    const result = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true });
    assert.equal(result.stamped, false);
    assert.equal(result.reason, 'not-existing-mode');
  }, { files: { 'README.md': '# empty' }, consent: true });
});

// A subdirectory of a repo is not a project: it belongs to the repo, which is where
// the stamp (and the whole onboarding) has to happen.
test('a directory that belongs to an enclosing project is skipped', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
    const pkg = path.join(cwd, 'strategies');
    fs.mkdirSync(pkg, { recursive: true });
    // >5 sources so detectMode says existing-codebase — otherwise the mode check
    // short-circuits first and this would not exercise membership at all.
    for (let i = 0; i < 7; i += 1) {
      fs.writeFileSync(path.join(pkg, `s${i}.go`), 'package strategies\n', 'utf8');
    }

    const result = stampExistingCodebaseDetection(pkg, { requireRecordedConsent: true });
    assert.equal(result.stamped, false);
    assert.equal(result.reason, 'belongs-to-enclosing-project');
    assert.equal(fs.existsSync(path.join(pkg, '.traffic-one')), false);
  }, { files: laravelFiles(), consent: true });
});

// `originalPrompt` is a routed local preference now (state/local-prefs/
// pref-schema.ts): the user's raw first prompt is private, and `.one.json` is
// committed. So this reads it back through readEffectiveState — the reader every
// production consumer uses — rather than through readState, which by design no
// longer returns it. The survival claim is unchanged and still the point of the
// test: postSetupTriage needs the request after SETUP_COMPLETE.
test('stamping is idempotent and preserves an existing originalPrompt seed', () => {
  withProject((cwd) => {
    writeState(cwd, { ...readState(cwd), originalPrompt: 'add a batch endpoint' });
    assert.equal(readEffectiveState(cwd).originalPrompt, 'add a batch endpoint',
      'fixture guard: the write routed the prompt into the per-user store rather than dropping it');
    assert.equal(stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true }).stamped, true);
    const first = readState(cwd);
    assert.equal(stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true }).stamped, true);
    const second = readState(cwd);
    assert.equal(readEffectiveState(cwd).originalPrompt, 'add a batch endpoint',
      'the real request survives two stamps — postSetupTriage needs it');
    assert.equal(second.originalPrompt, undefined, 'and it is never restored into the committed file');
    assert.ok(!fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8').includes('batch endpoint'),
      'the file the user pushes carries no prompt text');
    assert.equal(second.stack, first.stack);
    assert.equal(second.mode, first.mode);
  }, { files: laravelFiles(), consent: true });
});

test('applyExistingCodebaseDetection mutates in place without persisting', () => {
  withProject((cwd) => {
    const state: Record<string, unknown> = {};
    const detected = applyExistingCodebaseDetection(cwd, state, 'existing-codebase');
    assert.ok(detected.stack);
    assert.equal(state.onboardingComplete, true);
    assert.equal(state.backend, 'laravel');
    // Nothing was written: SessionStart owns the single writeState.
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), false);
  }, { files: laravelFiles(), consent: true });
});

test('applyExistingCodebaseDetection returns the stack-less detection for an undetectable repo without stamping', () => {
  withProject((cwd) => {
    const state: Record<string, unknown> = {};
    const detected = applyExistingCodebaseDetection(cwd, state, 'existing-codebase');
    assert.equal(detected.stack, null, 'the detection itself is returned — its evidence becomes the agent hints');
    assert.equal(state.stack, undefined);
    assert.equal(state.onboardingComplete, undefined, 'a skip must not half-stamp');
  }, { files: sparseFiles(), consent: true });
});
