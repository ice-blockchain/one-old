// What `seedOriginalPrompt` does with a base it could not read.
//
// The function's own docblock accepts a REFUSED write — a lost seed costs
// prompt-tailored wizard defaults and nothing more. That verdict was measured on
// a refused write and is true of exactly that input. An ILLEGIBLE base is a
// different one: `readState` answers a torn `.one.json` with the same `{}` it
// gives an absent one, so both idempotency guards read "no seed yet" from bytes
// nobody managed to read, and the whole-object spread then published two fields
// over everything the wizard had recorded.
//
// Every case below asserts the WRITABLE, LEGIBLE baseline first, in the same
// helper and with the same prompt. Without it a fenced or unreachable fixture
// "passes" for a reason that has nothing to do with the read under test.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readJsonResult } from '../../fsjson';
import { readEffectiveState, readProjectPrefs, readState, statePath } from '../../state';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';
import { seedOriginalPrompt } from '../seed-prompt';

const fixtures: string[] = [];

// ONE after() hook over a module-level list, never per-test cleanup: a per-test
// call is skipped by exactly the failure it exists to clean up after.
test.after(() => {
  for (const dir of fixtures) {
    try { fs.chmodSync(path.join(dir, '.traffic-one', '.one.json'), 0o600); } catch { /* absent or already open */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// Qualifies as a seed (isLikelyCodingPrompt) AND names a UI library, so both
// fields the function writes are observable.
const SEED = 'build an admin dashboard for freelancers with MUI';

function project(label: string): string {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-seed-prompt-${label}-`)));
  fixtures.push(cwd);
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  recordPluginUseChoice(cwd, true, 'seed-prompt-test');
  return cwd;
}

function withScopedPrefs(fn: () => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-seed-prompt-prefs-')));
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

test('a legible base is merged onto and an ABSENT one is created — the read only refuses what it cannot see', () => {
  withScopedPrefs(() => {
    const legible = project('legible');
    fs.writeFileSync(statePath(legible), JSON.stringify({ mode: 'new-project' }), 'utf8');
    seedOriginalPrompt(legible, SEED);
    const merged = readEffectiveState(legible);
    assert.equal(merged.originalPrompt, SEED, 'writable baseline: the seed lands where every consumer reads it');
    assert.equal(merged.uiLibrary, 'mui', 'writable baseline: and the library derived from the same prompt');
    assert.equal(merged.mode, 'new-project', 'writable baseline: onto the base, not over it');

    // Read back the BYTES, not a helper that strips on read: the committed file
    // is what gets pushed to a shared remote, and a returned `true` from any
    // writer says nothing about which file the value reached.
    assert.ok(!fs.readFileSync(statePath(legible), 'utf8').includes(SEED),
      'the committed state file must not carry the prompt text');
    assert.equal(readProjectPrefs(legible).originalPrompt, SEED,
      'it is in the per-user store, outside the repository');
  });

  // Its OWN prefs scope. One scope is one prefs file shared by every project in
  // it, and the seed is idempotent against that file — so a second project
  // inside the first scope would be refused by the seed the first one recorded,
  // and this case would pass or fail for a reason that is not about the base.
  withScopedPrefs(() => {
    // The brand-new project this function exists for has no `.one.json` at all.
    // `absent` must stay on the writing side of the guard, or the FIRST prompt of
    // every new project is the one that stops being captured.
    const pristine = project('pristine');
    assert.equal(readJsonResult(statePath(pristine)).kind, 'absent', 'fixture guard: nothing is there yet');
    seedOriginalPrompt(pristine, SEED);
    assert.equal(readEffectiveState(pristine).originalPrompt, SEED, 'an absent base is created, not refused');
    assert.ok(!fs.readFileSync(statePath(pristine), 'utf8').includes(SEED),
      'and the `.one.json` the UI-library write creates still carries no prompt');
  });
});

// The prompt left the repository, so it also left the repository write fence that
// used to govern it: `writeState` goes through fsjson, which refuses under a
// pending or declined project's state dir, while the per-user prefs file is
// machine-owned and exempt. Without the explicit fence in seedOriginalPrompt the
// first prompt of a project the user DECLINES is recorded outside the repo and no
// decline can reclaim it — removeDeclinedProjectArtifacts must never touch the
// per-user dir, because that is where the decline itself is stored.
test('a declined project records the prompt nowhere', () => {
  withScopedPrefs(() => {
    const cwd = project('declined');
    fs.writeFileSync(statePath(cwd), JSON.stringify({ mode: 'new-project' }), 'utf8');
    recordPluginUseChoice(cwd, false, 'seed-prompt-test');
    resetPluginUseCache();

    seedOriginalPrompt(cwd, SEED);

    assert.equal(readProjectPrefs(cwd).originalPrompt, undefined,
      'nothing was written to the per-user store for a project the user said no to');
    assert.equal(readEffectiveState(cwd).originalPrompt, undefined, 'and no consumer can read one');
  });
});

test('a torn `.one.json` is refused: byte-identical afterwards, and NOT quarantined', () => {
  withScopedPrefs(() => {
    const cwd = project('torn');
    const torn = '{"mode":"new-project","stack":"default","onboardingComplete":tr';
    fs.writeFileSync(statePath(cwd), torn, 'utf8');
    assert.equal(readJsonResult(statePath(cwd)).kind, 'corrupt', 'fixture guard: the base is unparseable');

    seedOriginalPrompt(cwd, SEED);

    assert.equal(fs.readFileSync(statePath(cwd), 'utf8'), torn, 'the bytes are exactly the ones that were there');
    // The sidecar is the tell. `writeState` quarantines an unparseable file
    // BEFORE replacing it, so a `.one.json.corrupt` here means the seed reached
    // its write and the user's state is in a file nothing reads. Refusing at the
    // read leaves the original in place and repairable — and leaves the healing
    // to flow.ts's `finalize`, which keeps `writeState` because it MEANS to
    // replace the file.
    assert.equal(fs.existsSync(`${statePath(cwd)}.corrupt`), false, 'and nothing was moved aside to replace them');
  });
});

// An empty file is the signature of an O_TRUNC open whose write never landed —
// the likeliest way a real `.one.json` becomes illegible, and the one a
// "does it parse" check written by hand tends to let through.
test('an EMPTY `.one.json` is an illegible base too, not an absent one', () => {
  withScopedPrefs(() => {
    const cwd = project('empty');
    fs.writeFileSync(statePath(cwd), '', 'utf8');
    assert.equal(readJsonResult(statePath(cwd)).kind, 'corrupt', 'fixture guard: empty reads as corrupt, not absent');

    seedOriginalPrompt(cwd, SEED);

    assert.equal(fs.readFileSync(statePath(cwd), 'utf8'), '', 'the empty file is left for a writer that means to replace it');
    assert.equal(fs.existsSync(`${statePath(cwd)}.corrupt`), false, 'nothing was quarantined');
  });
});

// CHARACTERIZATION, and deliberately labelled as one: reverting the `unreadable`
// half of the guard does NOT turn this red. `writeState`'s
// statePreservedBeforeReplace already refuses an `unreadable` base without
// writing or quarantining anything, so the two spellings are indistinguishable
// on disk. The arm stays because the guard's contract is the READ's, not
// writeState's — the same answer `patchState` gives — and pinning it here is
// what will notice if that second line of defence ever moves.
//
// A chmod 000 FILE, not a directory at the path: EISDIR throws through the write
// path and this function wraps its write in `try { … } catch {}`, so a directory
// fixture could be swallowed by that catch and the assertion would hold for a
// reason unrelated to the read. EACCES on a plain file throws nowhere on this
// path. It is read straight through by uid 0, so the guard below is HARD rather
// than a skip: a root run must fail loudly, not pass vacuously.
test('an UNREADABLE `.one.json` (EACCES) is refused, and never fails the caller', () => {
  withScopedPrefs(() => {
    const cwd = project('eacces');
    const original = JSON.stringify({ mode: 'new-project', stack: 'default' });
    fs.writeFileSync(statePath(cwd), original, 'utf8');
    fs.chmodSync(statePath(cwd), 0o000);
    const read = readJsonResult(statePath(cwd));
    assert.equal(read.kind, 'unreadable',
      `fixture guard: the file must be unreadable to this uid (${process.getuid?.() ?? 'unknown'}) — a root run reads `
      + 'straight through it and this case would pass for the wrong reason');
    assert.equal(read.kind === 'unreadable' ? read.errno : '', 'EACCES', 'fixture guard: and by permission, not by shape');

    assert.doesNotThrow(() => seedOriginalPrompt(cwd, SEED), 'a seed never fails the prompt it rode in on');

    fs.chmodSync(statePath(cwd), 0o600);
    assert.equal(fs.readFileSync(statePath(cwd), 'utf8'), original, 'the bytes nobody could read are still there');
    assert.equal(fs.existsSync(`${statePath(cwd)}.corrupt`), false, 'and nothing was quarantined');
  });
});

// The guard sits AHEAD of the idempotency checks, which is the whole point — but
// it must not have replaced them. The first coding prompt is the project
// description; a later one never overwrites it.
test('a legible base that already carries a seed is still never overwritten', () => {
  // An existing user, mid-migration: the value is still in the committed file and
  // the SessionStart scrub has not run yet. The guard has to see it there too, or
  // the release that moves the field also overwrites every existing project's
  // project description with whatever prompt happens to arrive first.
  withScopedPrefs(() => {
    const cwd = project('idempotent-unscrubbed');
    fs.writeFileSync(statePath(cwd), JSON.stringify({ mode: 'new-project', originalPrompt: 'the first request' }), 'utf8');
    seedOriginalPrompt(cwd, SEED);
    assert.equal(readEffectiveState(cwd).originalPrompt, 'the first request');
    assert.equal(readProjectPrefs(cwd).originalPrompt, undefined, 'and no second copy was minted in the store');
  });

  // The same project after the scrub: the value is in the per-user store and the
  // committed file no longer has it. `readState` is blind to it now, so a guard
  // that still asked the raw reader would answer "no seed yet" and overwrite.
  withScopedPrefs(() => {
    const cwd = project('idempotent-migrated');
    // A prompt that QUALIFIES as a seed. 'the first request' does not
    // (isLikelyCodingPrompt is false for it), so using it here recorded nothing
    // and the case passed on the wrong mechanism.
    const first = 'create a booking system for clinics';
    fs.writeFileSync(statePath(cwd), JSON.stringify({ mode: 'new-project' }), 'utf8');
    seedOriginalPrompt(cwd, first);
    assert.equal(readProjectPrefs(cwd).originalPrompt, first, 'fixture guard: the first seed is in the store');
    assert.equal(readState(cwd).originalPrompt, undefined, 'fixture guard: and the raw reader is blind to it');
    seedOriginalPrompt(cwd, SEED);
    assert.equal(readEffectiveState(cwd).originalPrompt, first);
  });

  withScopedPrefs(() => {
    const viaContext = project('idempotent-context');
    fs.writeFileSync(statePath(viaContext), JSON.stringify({
      mode: 'new-project',
      projectContext: { originalPrompt: 'the first request' },
    }), 'utf8');
    seedOriginalPrompt(viaContext, SEED);
    assert.equal(readEffectiveState(viaContext).originalPrompt, undefined,
      'the projectContext guard still fires — nothing was seeded at the top level either');
    assert.equal(readProjectPrefs(viaContext).originalPrompt, undefined, 'nor in the per-user store');
  });
});
