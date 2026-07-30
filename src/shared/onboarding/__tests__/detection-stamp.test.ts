import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyExistingCodebaseDetection, stampExistingCodebaseDetection } from '../detection-stamp';
import { computeOnboarding } from '../../onboarding-server/flow';
import { recordPluginUseChoice } from '../../state/plugin-use';
import { readState, writeState } from '../../state';
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

test('an undetectable repo is left alone, so it keeps its no-wizard behavior', () => {
  withProject((cwd) => {
    const result = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true });
    assert.equal(result.stamped, false);
    assert.equal(result.reason, 'undetectable');
    assert.equal(readState(cwd).stack, undefined);
    assert.equal(computeOnboarding(cwd).done, true, 'no invented stack → no wizard, exactly as today');
  }, { files: sparseFiles(), consent: true });
});

test('floorMinimal is what invents a stack — and it DOES open a wizard', () => {
  withProject((cwd) => {
    const result = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true, floorMinimal: true });
    assert.equal(result.stamped, true);
    assert.equal(readState(cwd).stack, 'minimal');
    // Documents the hazard: this is why runners never pass floorMinimal.
    assert.equal(computeOnboarding(cwd).step, 'open-code');
  }, { files: sparseFiles(), consent: true });
});

test('a new project is skipped — its stack is owned by the wizard finalize answer', () => {
  withProject((cwd) => {
    const result = stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true, floorMinimal: true });
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

    const result = stampExistingCodebaseDetection(pkg, { requireRecordedConsent: true, floorMinimal: true });
    assert.equal(result.stamped, false);
    assert.equal(result.reason, 'belongs-to-enclosing-project');
    assert.equal(fs.existsSync(path.join(pkg, '.traffic-one')), false);
  }, { files: laravelFiles(), consent: true });
});

test('stamping is idempotent and preserves an existing originalPrompt seed', () => {
  withProject((cwd) => {
    writeState(cwd, { ...readState(cwd), originalPrompt: 'add a batch endpoint' });
    assert.equal(stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true }).stamped, true);
    const first = readState(cwd);
    assert.equal(stampExistingCodebaseDetection(cwd, { requireRecordedConsent: true }).stamped, true);
    const second = readState(cwd);
    assert.equal(second.originalPrompt, 'add a batch endpoint', 'the real request survives — postSetupTriage needs it');
    assert.equal(second.stack, first.stack);
    assert.equal(second.mode, first.mode);
  }, { files: laravelFiles(), consent: true });
});

test('applyExistingCodebaseDetection mutates in place without persisting', () => {
  withProject((cwd) => {
    const state: Record<string, unknown> = {};
    const detected = applyExistingCodebaseDetection(cwd, state, 'existing-codebase', { floorMinimal: true });
    assert.ok(detected);
    assert.equal(state.onboardingComplete, true);
    assert.equal(state.backend, 'laravel');
    // Nothing was written: SessionStart owns the single writeState.
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), false);
  }, { files: laravelFiles(), consent: true });
});

test('applyExistingCodebaseDetection returns null for an undetectable repo without a floor', () => {
  withProject((cwd) => {
    const state: Record<string, unknown> = {};
    assert.equal(applyExistingCodebaseDetection(cwd, state, 'existing-codebase'), null);
    assert.equal(state.stack, undefined);
    assert.equal(state.onboardingComplete, undefined, 'a skip must not half-stamp');
  }, { files: sparseFiles(), consent: true });
});
