// The teeth of the fixture write funnels in fixtures.ts.
//
// Those funnels used to drop the boolean their writers hand back, which is the
// worst failure shape this corpus has: the case still runs, the gate it names is
// never reached, and the snapshot records a verdict belonging to whichever
// earlier gate caught the un-onboarded project. Both directions of the
// expectation are covered here, because both are reachable:
//
//   'landed' — an onboarded fixture whose write the fence refused. Mutated with
//     MOVE-ASIDE plus link, not a dangling link: writeState READS .one.json
//     before writing it, so a dangling link makes it bail on its own
//     precondition and the test would pass vacuously. The read is asserted to
//     still resolve before anything is asserted about the write.
//
//   'refused' — a pre-consent fence fixture whose writes LANDED, i.e. one that
//     silently stopped being a fence detector. Mutated by opening the fence with
//     the documented TRAFFIC_ONE_ASK_USE_PLUGIN='0' override, which is exactly
//     the "neuter projectWritesPermitted" break fixtures.ts's own comment says
//     these three fixtures exist to catch.
//
// Each case asserts an unmutated baseline through the SAME funnel first;
// without it, a funnel that stopped checking anything would pass identically.

import './env';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';

import { cleanupReplayTempTrees, existingCodebaseUndetectable, preConsentWritesThenConsented, stampFixtureOnboardingCompletion } from './fixtures';
import { readState } from '../../src/shared/state';
import { resetPluginUseCache } from '../../src/shared/state/plugin-use';

test.after(cleanupReplayTempTrees);

// Rename the real state file and leave a symlink at the original name: reads
// resolve through the link, writes are refused because the target IS a link
// (shared/fsjson.ts's path fence). See plan-readiness.test.ts:870-873.
function fenceMoveAside(dir: string): string {
  const file = path.join(dir, '.traffic-one', '.one.json');
  const aside = path.join(dir, '.traffic-one', '.one.json.real');
  fs.renameSync(file, aside);
  fs.symlinkSync(aside, file);
  return file;
}

test('the onboarding-completion funnel refuses to hand back a fixture whose stamp the fence rejected', () => {
  // Baseline: the same funnel on an unfenced project. existingCodebaseUndetectable
  // is the cheapest consented fixture that already HAS a .one.json (it writes
  // `mode` and nothing else), which is what the move-aside variant needs.
  const baseline = existingCodebaseUndetectable('claude');
  stampFixtureOnboardingCompletion(baseline);
  assert.ok(
    readState(baseline).technologies,
    'writable baseline: an unfenced onboarding-completion stamp lands, so a throw below is the fence and not a broken fixture',
  );

  const dir = existingCodebaseUndetectable('claude');
  const file = fenceMoveAside(dir);

  // The fixture guard the move-aside variant exists for: if the READ stopped
  // resolving, writeState would bail on its own precondition and the assertion
  // below would pass without ever reaching the write.
  assert.equal(readState(dir).mode, 'existing-codebase', 'the fenced path still READS through the link');

  assert.throws(
    () => stampFixtureOnboardingCompletion(dir),
    (err: Error) => err.message.includes('onboarding-completion stamp')
      && err.message.includes(file)
      && err.message.includes('not the project it claims to be'),
    'a refused completion stamp must abort the fixture build, naming the path the fence refused',
  );

  // The consequence the throw prevents, read back off disk: this is the project
  // the funnel would otherwise have returned. `technologies` is what
  // hasTechnologyArrays (shared/state/validate.ts) requires, so without it
  // isNewProjectOnboardingIncomplete stays true, onboarding-gate never stands
  // down, and every case built on this fixture characterizes ITS deny instead of
  // the gate the case names.
  assert.equal(readState(dir).technologies, undefined, 'the refused stamp left no technology arrays — the fixture is not onboarded');
});

test('a pre-consent fence fixture that silently starts landing its writes aborts instead of being scored', () => {
  // Baseline, in the direction the fixture claims: with the shipped ask-first
  // default (env.ts leaves it at ASK_USE_PLUGIN_FIRST) every onboarding write in
  // the builder is refused, so the project reaches the gates byte-identical to
  // one the plugin never touched.
  const intact = preConsentWritesThenConsented('claude');
  assert.deepEqual(fs.readdirSync(intact), ['package.json'], 'fence intact: the builder returns a bare project, its own package.json and nothing else');

  const prev = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';
  resetPluginUseCache();
  try {
    assert.throws(
      () => preConsentWritesThenConsented('claude'),
      (err: Error) => err.message.includes('preseed')
        && err.message.includes('.one.json')
        && err.message.includes('no longer detects the fence'),
      'with the fence open the pre-seed LANDS, and the funnel must say so: this fixture is scored as a fence detector',
    );
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prev;
    resetPluginUseCache();
  }

  // And the fence is back: the same builder is a bare project again, so this
  // case leaves no state behind for the corpus that may run after it.
  assert.deepEqual(fs.readdirSync(preConsentWritesThenConsented('claude')), ['package.json'], 'the override was undone — the fixture detects the fence again');
});
