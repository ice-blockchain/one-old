// What the three lock/ledger writers do when the consent fence refuses to create
// their directory.
//
// All three used to reach `<project>/.traffic-one/` with a raw `fs.mkdirSync`
// ahead of any consent check, and between them they were the ENTIRE residue a
// pending project carried away from a full hook drive: `.traffic-one/`,
// `.traffic-one/runs/` and `.traffic-one/runs/<id>/`, empty. Removing the
// directories is the easy half. The half that needs a test is what each one does
// with the refusal, because a lock that believes it was acquired when it was not
// is far worse than the empty directory it no longer creates: it hands its caller
// a mutual exclusion that does not exist.
//
// So each case below asserts the DECISION, not the absence of a directory:
//   - project-state-lock: no lease is fabricated, and the body still runs
//     (unserialized is safe only because the file the lock protects cannot be
//     written either);
//   - run-agent/locks: `withOwnedDirLock` reports false and never runs `mutate`;
//   - run-agent/ledger: the transition reports null rather than a record no
//     reader could ever load.
// Each is paired with its consented twin, so a fence that starts refusing
// unconditionally fails here instead of silently disabling the product.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_FILE } from '../../../config/paths';
import { withOwnedDirLock } from '../run-agent/locks';
import { ensureRunLedger, transitionRunStatus } from '../run-agent/ledger';
import { runDir, runLedgerFile } from '../run-agent/run-paths';
import { withProjectStateLock } from '../project-state-lock';
import { writeState } from '../normalize';
import { readJson } from '../../fsjson';
import { recordPluginUseChoice, resetPluginUseCache } from '../plugin-use';

type Consent = 'pending' | 'consented';

// A project with NO `.traffic-one/`, so every path this file asserts about is one
// the code under test would have to create.
function withProject(consent: Consent, fn: (project: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-lockfence-')));
  const project = path.join(base, 'project');
  const env = process.env;
  const saved = {
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    ask: env.TRAFFIC_ONE_ASK_USE_PLUGIN,
    home: env.HOME,
    xdg: env.XDG_STATE_HOME,
  };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1'; // the shipped default, pinned explicitly
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"demo"}\n', 'utf8');
  resetPluginUseCache();
  if (consent === 'consented') recordPluginUseChoice(project, true, 'test');
  resetPluginUseCache();
  try {
    fn(project);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ASK_USE_PLUGIN: saved.ask,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function stateDir(project: string): string {
  return path.join(project, '.traffic-one');
}

// The lock path is derived exactly as project-state-lock.ts derives it, so this
// observes the real directory rather than a guess about its name.
function projectStateLockPath(project: string): string {
  return `${path.join(path.resolve(project), STATE_FILE)}.report-id.lock`;
}

// Staging dirs are `<lock>.<token>.pending`; a leaked one is how a refused
// acquisition would show up even if the lock itself never appeared.
function lockResidue(project: string): string[] {
  try {
    return fs.readdirSync(stateDir(project)).filter((name) => name.includes('.report-id.lock')).sort();
  } catch {
    return [];
  }
}

// ── site 1: state/project-state-lock.ts ──────────────────────────────────────

test('project-state lock, PENDING: no lease is fabricated, the body still runs, and nothing is staged on disk', () => {
  withProject('pending', (project) => {
    let heldDuringBody: boolean | null = null;
    const returned = withProjectStateLock(project, () => {
      // The on-disk lock directory is the ground truth for "am I holding it".
      heldDuringBody = fs.existsSync(projectStateLockPath(project));
      return 'body-ran';
    });

    assert.equal(returned, 'body-ran', 'the body must still run: pending is not "plugin off"');
    assert.equal(heldDuringBody, false, 'no lock directory exists, so no lease may claim one');
    assert.equal(fs.existsSync(stateDir(project)), false, 'the state dir itself is not created');
    assert.deepEqual(lockResidue(project), [], 'no leaked `.pending` staging dir either');
  });
});

test('project-state lock, PENDING: the body cannot write the file the lock protects — which is why running it unserialized is safe', () => {
  withProject('pending', (project) => {
    // The claim the refusal rests on, asserted rather than assumed: `.one.json`
    // is written through fsjson's guarded writer (state/normalize.ts writeState),
    // and the fence refuses it for the same project the lock refused.
    withProjectStateLock(project, () => {
      writeState(project, { stack: 'default', mode: 'new-project' });
    });
    assert.equal(fs.existsSync(path.join(project, STATE_FILE)), false, 'no state file was written, so there was nothing to serialize');
    assert.equal(fs.existsSync(stateDir(project)), false);
  });
});

test('project-state lock, CONSENTED: the lock is genuinely held during the body and released after', () => {
  withProject('consented', (project) => {
    let heldDuringBody: boolean | null = null;
    let nestedRan = false;
    withProjectStateLock(project, () => {
      heldDuringBody = fs.existsSync(projectStateLockPath(project));
      // Re-entrancy still works, and must not double-release.
      withProjectStateLock(project, () => { nestedRan = true; });
    });

    assert.equal(heldDuringBody, true, 'a consented project really does take the lock');
    assert.equal(nestedRan, true, 'nested calls stay re-entrant');
    assert.equal(fs.existsSync(projectStateLockPath(project)), false, 'and it is released afterwards');
    assert.deepEqual(lockResidue(project), [], 'with no staging residue left behind');
  });
});

// ── site 2: state/run-agent/locks.ts ─────────────────────────────────────────

const WAIT = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 2_000;

test('owned-dir lock, PENDING: reports FALSE, never runs the mutation, and fails fast instead of spinning to the timeout', () => {
  withProject('pending', (project) => {
    const lockDir = path.join(runDir(project, '1785878638843'), '.run-ledger.lock');
    let mutated = false;
    const started = Date.now();
    const acquired = withOwnedDirLock(lockDir, LOCK_TIMEOUT_MS, 15_000, 10, WAIT, () => { mutated = true; });
    const elapsed = Date.now() - started;

    assert.equal(acquired, false, 'a lock that was not taken must say so');
    assert.equal(mutated, false, 'and the mutation it guards must not run');
    assert.equal(fs.existsSync(stateDir(project)), false, 'no `.traffic-one/`, `runs/` or `runs/<id>/` residue');
    // The refusal returns before the retry loop on purpose: inside it, a
    // NON-recursive mkdir of a lock whose parent does not exist can only fail,
    // so every call would burn the caller's full timeout on a project that
    // simply has not opted in. 2s per hook event is not a rounding error.
    assert.ok(elapsed < LOCK_TIMEOUT_MS / 2, `must not spin to the timeout (took ${elapsed}ms)`);
  });
});

test('owned-dir lock, CONSENTED: reports TRUE, runs the mutation under the lock, and cleans up', () => {
  withProject('consented', (project) => {
    const lockDir = path.join(runDir(project, '1785878638843'), '.run-ledger.lock');
    let heldDuringMutate: boolean | null = null;
    const acquired = withOwnedDirLock(lockDir, LOCK_TIMEOUT_MS, 15_000, 10, WAIT, () => {
      heldDuringMutate = fs.existsSync(lockDir);
    });

    assert.equal(acquired, true);
    assert.equal(heldDuringMutate, true, 'the lock dir exists while the mutation runs');
    assert.equal(fs.existsSync(lockDir), false, 'and is removed on release');
  });
});

// ── site 3: state/run-agent/ledger.ts ────────────────────────────────────────

test('run ledger, PENDING: the transition reports NULL rather than a record no reader could load', () => {
  withProject('pending', (project) => {
    const runId = '1785878638843';

    assert.equal(ensureRunLedger(project, runId, {}), null, 'ensureRunLedger must not claim success');
    assert.equal(
      transitionRunStatus(project, runId, { status: 'active' }),
      null,
      'transitionRunStatus must not claim success',
    );

    // The null was truthful: nothing is on disk, so a caller that trusted a
    // non-null return would have announced a run whose ledger does not exist.
    assert.equal(fs.existsSync(runLedgerFile(project, runId)), false, 'no ledger file');
    assert.equal(fs.existsSync(runDir(project, runId)), false, 'not even the run directory');
    assert.equal(fs.existsSync(stateDir(project)), false);
    assert.equal(readJson(runLedgerFile(project, runId), null), null, 'and nothing reads back');
  });
});

test('run ledger, CONSENTED: the same transitions land and read back', () => {
  withProject('consented', (project) => {
    const runId = '1785878638843';

    const planned = ensureRunLedger(project, runId, {});
    assert.ok(planned, 'a consented project records the ledger');
    assert.equal(planned?.status, 'planned');
    assert.equal(fs.existsSync(runLedgerFile(project, runId)), true);

    const active = transitionRunStatus(project, runId, { status: 'active' });
    assert.ok(active, 'and advances it');
    assert.equal(active?.status, 'active');
    const onDisk = readJson<{ status?: string }>(runLedgerFile(project, runId), {});
    assert.equal(onDisk.status, 'active', 'the returned record matches what a reader loads');
  });
});
