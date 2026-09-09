// src/shared/auth/__tests__/revalidation-state.test.ts
// The machine-level record of "when did this machine last ask about its key,
// and what did the authority say?" — and the two things about it that are
// load-bearing elsewhere: the previous outcome survives a new attempt stamp (or
// the session advisory goes blank while a probe is in flight), and the hook's
// attempt instant survives the worker's outcome write (or the worker extends
// its own cadence slot).
//
// Every write here answers with a boolean whose `false` means REFUSED, and the
// refusals are injected the way they actually happen: something that is not a
// writable file sitting at the sidecar path. That refusal is DURABLE — retrying
// inside one run answers the same — which is why a boolean is the right channel
// and why every caller is expected to spend it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { machineSidecarPath } from '../machine-sidecar';
import { AUTH_GATE_DRIFT_FILE } from '../auth-gate-drift';
import {
  REVALIDATION_STATE_FILE,
  readRevalidationState,
  recordRevalidationOutcome,
  revalidationStatePath,
  stampRevalidationAttempt,
} from '../revalidation-state';
import { UPDATES_STORE_FILE } from '../updates-store';
import {
  projectRootForStatePath,
  projectStateWriteAllowed,
  resetPluginUseCache,
} from '../../state/plugin-use';

const T0 = Date.parse('2026-08-08T10:00:00Z');
const T1 = Date.parse('2026-08-09T11:22:33Z');

function machine(): { env: NodeJS.ProcessEnv; file: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-revalidation-state-'));
  const env = { ...process.env, TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json') };
  return {
    env,
    file: revalidationStatePath(env),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A DURABLE refusal of exactly one sidecar: a directory where the file belongs.
 * The atomic writer's rename lands on it with EISDIR and answers false, while
 * the reader folds the same EISDIR to its cold start — which is precisely the
 * shape an unwritable state dir produces, without chmod'ing a directory the
 * other sidecar also lives in.
 */
function refuseWrites(file: string): void {
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file, { recursive: true });
}

test('the record lives beside one.json, follows the state-path override, and is 0600', () => {
  const m = machine();
  try {
    assert.equal(path.dirname(m.file), path.dirname(m.env.TRAFFIC_ONE_STATE_PATH as string));
    assert.equal(path.basename(m.file), REVALIDATION_STATE_FILE);
    assert.equal(readRevalidationState(m.env), null, 'absent is "no usable history", which the cadence reads as due');

    assert.equal(stampRevalidationAttempt(T0, null, m.env), true);
    assert.equal(fs.statSync(m.file).mode & 0o777, 0o600, 'the machine dir is the 0600 neighbourhood of the key itself');
    assert.deepEqual(readRevalidationState(m.env), { attemptedAt: '2026-08-08T10:00:00Z' });
  } finally { m.dispose(); }
});

test('an unreadable, downgraded or half-written record is a cold start, never a throw', () => {
  const m = machine();
  try {
    fs.mkdirSync(path.dirname(m.file), { recursive: true });
    for (const raw of [
      '',
      'not json',
      '[]',
      'null',
      JSON.stringify({ version: 99, attemptedAt: '2026-08-08T10:00:00Z' }),  // a newer schema
      JSON.stringify({ version: 1 }),                                        // no attempt at all
      JSON.stringify({ version: 1, attemptedAt: '   ' }),
      JSON.stringify({ version: 1, attemptedAt: 42 }),
    ]) {
      fs.writeFileSync(m.file, raw);
      assert.equal(readRevalidationState(m.env), null, raw);
    }
    // …and the file it could not parse is left exactly as it was.
    assert.equal(fs.readFileSync(m.file, 'utf8'), JSON.stringify({ version: 1, attemptedAt: 42 }));
  } finally { m.dispose(); }
});

test('an outcome this runtime does not recognise is dropped, and takes its instant with it', () => {
  const m = machine();
  try {
    fs.mkdirSync(path.dirname(m.file), { recursive: true });
    fs.writeFileSync(m.file, JSON.stringify({
      version: 1,
      attemptedAt: '2026-08-08T10:00:00Z',
      outcome: 'invented-by-a-newer-build',
      outcomeAt: '2026-08-08T10:00:01Z',
    }));
    // The attempt still counts (the cadence is measured from it); the verdict
    // does not, because the session advisory switches on exactly five values and
    // a sixth would fall through every one of them.
    assert.deepEqual(readRevalidationState(m.env), { attemptedAt: '2026-08-08T10:00:00Z' });
  } finally { m.dispose(); }
});

test('a new attempt CARRIES FORWARD the last conclusion instead of blanking it', () => {
  const m = machine();
  try {
    assert.equal(recordRevalidationOutcome('revoke-refused', T0, m.env), true);
    assert.equal(stampRevalidationAttempt(T1, readRevalidationState(m.env), m.env), true);

    // Clearing the outcome here would blank the advisory for every session
    // between this stamp and the worker's own write — permanently, if the worker
    // never completes. An attempt in flight BESIDE the last conclusion is what
    // the advisory should be reading.
    assert.deepEqual(readRevalidationState(m.env), {
      attemptedAt: '2026-08-09T11:22:33Z',
      outcome: 'revoke-refused',
      outcomeAt: '2026-08-08T10:00:00Z',
    });
  } finally { m.dispose(); }
});

test('the worker records its verdict WITHOUT extending the cadence slot the hook charged', () => {
  const m = machine();
  try {
    stampRevalidationAttempt(T0, null, m.env);
    assert.equal(recordRevalidationOutcome('confirmed', T1, m.env), true);
    assert.deepEqual(readRevalidationState(m.env), {
      attemptedAt: '2026-08-08T10:00:00Z',
      outcome: 'confirmed',
      outcomeAt: '2026-08-09T11:22:33Z',
    });
  } finally { m.dispose(); }
});

test('a record that vanished underneath the worker is re-created erring toward WAITING', () => {
  const m = machine();
  try {
    // No stamp at all: the state was cleared or relocated mid-probe. The only
    // timestamp that still exists is the outcome instant, which is LATER than
    // the real attempt — so the next cadence is measured generously rather than
    // hammering a 60/min per-user budget.
    assert.equal(recordRevalidationOutcome('unreachable', T1, m.env), true);
    assert.deepEqual(readRevalidationState(m.env), {
      attemptedAt: '2026-08-09T11:22:33Z',
      outcome: 'unreachable',
      outcomeAt: '2026-08-09T11:22:33Z',
    });
  } finally { m.dispose(); }
});

test('a refused write is REPORTED by both writers, and neither leaves a temp file behind', () => {
  const m = machine();
  try {
    refuseWrites(m.file);
    assert.equal(
      stampRevalidationAttempt(T0, null, m.env), false,
      'a caller that ignores this spawns a probe it could not charge to the cadence, on every session',
    );
    assert.equal(
      recordRevalidationOutcome('revoked', T1, m.env), false,
      'a caller that ignores this lets an unrecorded outcome read as a recorded one',
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(m.file)).filter((name) => name.endsWith('.tmp')),
      [],
      'the atomic writer must clean up the temp it could not rename',
    );
  } finally { m.dispose(); }
});

// ── auth sidecars are MACHINE-owned, and the two lists must move together ────
// machine-sidecar.ts writes through raw `fs`, the sanctioned opt-out from the
// write fence, so nothing here is fenced today. The names are ALSO declared in
// state/plugin-use.ts's MACHINE_OWNED_ENTRIES.files, and that second line is
// what the next writer reaching for fsjson.ts's guarded helpers gets: without
// it, such a writer is silently refused on a $HOME-rooted session, where the
// machine dir IS the "project's" state dir.
//
// MACHINE_OWNED_ENTRIES is not exported, so this pins the exported PREDICATE
// that consults it, and keys off the file-name constants rather than off
// string literals — a rename that moved only one of the two lists would
// otherwise leave this test green while the fence closed on the renamed file.
test('the auth sidecars stay writable on a $HOME-rooted session whose consent is PENDING', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'one-machine-owned-'));
  const env = {
    HOME: home,
    // Pinned rather than inherited: the whole assertion turns on the $HOME
    // project's use-plugin question being unanswered.
    TRAFFIC_ONE_ASK_USE_PLUGIN: '1',
    TRAFFIC_ONE_STATE_PATH: path.join(home, '.traffic-one', 'one.json'),
  } as NodeJS.ProcessEnv;
  resetPluginUseCache();
  try {
    for (const file of [REVALIDATION_STATE_FILE, UPDATES_STORE_FILE, AUTH_GATE_DRIFT_FILE]) {
      const target = machineSidecarPath(file, env);
      assert.ok(
        target.startsWith(`${path.join(home, '.traffic-one')}${path.sep}`),
        `${target} must be inside the machine dir for this assertion to mean anything`,
      );
      assert.equal(projectRootForStatePath(target, env), null, `${file} is machine state, not project state`);
      assert.equal(projectStateWriteAllowed(target, env), true, `${file} must stay writable`);
    }

    // The control, and the reason this is keyed off the constants: a name that
    // is NOT on the allowlist, in the same directory, is fenced. So the two
    // assertions above are about the declared exemption rather than about a
    // fence that happened to be open — and a rename that updated
    // revalidation-state.ts without updating plugin-use.ts turns the loop above
    // into this line.
    const renamed = path.join(path.dirname(machineSidecarPath(REVALIDATION_STATE_FILE, env)), `${REVALIDATION_STATE_FILE}-renamed`);
    assert.equal(projectRootForStatePath(renamed, env), home, 'an undeclared sibling belongs to the $HOME project');
    assert.equal(projectStateWriteAllowed(renamed, env), false, 'and is refused while that project\'s question is pending');
  } finally {
    resetPluginUseCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
