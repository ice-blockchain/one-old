// src/shared/override/__tests__/state-path-agreement.test.ts
// The acknowledgement and the evidence it accounts for must resolve to the same
// machine root.
//
// The override record is SPLIT ACROSS TWO PLACES on purpose: the mint counter
// and the operator acknowledgement live in `one.json` (they have to survive
// `rm -rf` of the bucket — that erasure is one of the states they exist to
// detect), while the ledger, the snapshots and the install key live in the
// bucket. That is only sound while the two are resolved from ONE root, and they
// were not: `oneSettingsPath` honours TRAFFIC_ONE_STATE_PATH and
// `globalTrafficOneDir` — which `overrideRoot` used directly — reads
// XDG_STATE_HOME › HOME only.
//
// DRIVEN (load 11.31): an orphan snapshot, reconciled, verdict CLEAR. Set
// TRAFFIC_ONE_STATE_PATH — nothing moved, no byte changed, a variable README
// documents and six test files use — and `override-snapshot-orphaned` came back
// with `reconciliations: 0` and the counter reading `absent`. A project that WAS
// reconciled read as never reconciled, and `verified` was refused for every run
// in it.
//
// The first cell is the one that reds on a regression; the second states the
// invariant a future second resolver would break; the third pins that the
// shipped layouts are unaffected, which is what makes the repair safe to take.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { overrideEvidenceChecks, overrideEvidenceReport, overrideReconciliationDraft } from '../integrity';
import { overrideLedgerPath, overrideRoot, overrideSnapshotDir } from '../paths';
import { recordOverrideReconciliation } from '../reconcile';
import { oneSettingsPath } from '../../one-settings';
import { globalTrafficOneDir } from '../../state/traffic-one-paths';

const scratch: string[] = [];
test.after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

test('relocating the settings file does not turn a reconciled project into an accused one', () => {
  const stateRoot = tempDir('t1-override-statepath-');
  const projectRoot = tempDir('t1-override-project-');
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: stateRoot };
  delete env.TRAFFIC_ONE_STATE_PATH;

  // An orphan snapshot — a snapshot file with no ledger line behind it, the
  // residue an erasure leaves, and reachable with no mint at all.
  fs.mkdirSync(overrideSnapshotDir(projectRoot, env), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(overrideSnapshotDir(projectRoot, env), 'planted-id.json'), '{"any":"thing"}');
  assert.deepEqual(overrideEvidenceChecks(projectRoot, env), ['override-snapshot-orphaned'],
    'fixture guard: the planted state must actually be a finding, or the reconciliation below proves nothing');

  const draft = overrideReconciliationDraft(projectRoot, env);
  const recorded = recordOverrideReconciliation({
    projectRoot, fingerprint: draft.fingerprint, quarantinedRuns: [], env,
  });
  assert.equal(recorded.ok, true, 'the fixture must actually get an acknowledgement on record');
  assert.deepEqual(overrideEvidenceChecks(projectRoot, env), [], 'and it must actually clear the finding');

  // The relocation. Nothing on disk moves; only the settings file's path is
  // steered, exactly as an operator or a test may steer it.
  const relocated: NodeJS.ProcessEnv = { ...env, TRAFFIC_ONE_STATE_PATH: path.join(stateRoot, 'elsewhere', 'one.json') };
  const report = overrideEvidenceReport(projectRoot, relocated);
  assert.deepEqual(report.checks, [],
    'the witnesses and the acknowledgement that accounts for them resolved to different roots: the bucket was '
    + 'still read from the old machine dir while one.json — which HOLDS the acknowledgement and the counter — '
    + 'was read from the new one, so a reconciled project reads as never reconciled and every run in it is '
    + 'refused `verified`');
  assert.equal(report.reconciliations, 0,
    'a relocated settings file means a DIFFERENT machine record, so the acknowledgement is legitimately not '
    + 'there — the defect is finding the evidence without it, not failing to find it');
});

test('every path this module hands out is resolved from the settings file\'s own directory', () => {
  // The invariant, over the three shapes the resolver has. A second resolver
  // added anywhere below fails here rather than in a certification report six
  // months later.
  const home = tempDir('t1-override-home-');
  const xdg = tempDir('t1-override-xdg-');
  const moved = tempDir('t1-override-moved-');
  const projectRoot = tempDir('t1-override-inv-project-');

  for (const [label, env] of [
    ['HOME only', { HOME: home, XDG_STATE_HOME: undefined, TRAFFIC_ONE_STATE_PATH: undefined }],
    ['XDG_STATE_HOME', { HOME: home, XDG_STATE_HOME: xdg, TRAFFIC_ONE_STATE_PATH: undefined }],
    ['TRAFFIC_ONE_STATE_PATH', { HOME: home, XDG_STATE_HOME: xdg, TRAFFIC_ONE_STATE_PATH: path.join(moved, 'one.json') }],
  ] as const) {
    const scoped: NodeJS.ProcessEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
    for (const key of ['XDG_STATE_HOME', 'TRAFFIC_ONE_STATE_PATH'] as const) {
      if (env[key] === undefined) delete scoped[key];
    }
    const settingsDir = path.dirname(oneSettingsPath(scoped));
    assert.equal(path.dirname(overrideRoot(scoped)), settingsDir,
      `[${label}] the override bucket must sit beside the settings file that holds its counter and its `
      + 'acknowledgement — the two are one record, and a layout that separates them separates the evidence '
      + 'from the statement about it');
    assert.equal(overrideLedgerPath(projectRoot, scoped).startsWith(`${overrideRoot(scoped)}${path.sep}`), true,
      `[${label}] and the ledger must be inside that bucket`);
  }
});

test('the two shipped layouts are byte-identical to what they always were', () => {
  // What makes the repair safe to take: it changes nothing unless
  // TRAFFIC_ONE_STATE_PATH is set, which is the one input the two resolvers ever
  // disagreed on. `overrides` is exempt from the consent fence by NAME under the
  // machine dir (state/plugin-use.ts's MACHINE_OWNED_ENTRIES), so a layout change
  // on these two paths would silently fence a home-rooted mint.
  const home = tempDir('t1-override-home2-');
  const xdg = tempDir('t1-override-xdg2-');
  for (const [label, env] of [
    ['HOME only', { HOME: home }],
    ['XDG_STATE_HOME', { HOME: home, XDG_STATE_HOME: xdg }],
  ] as const) {
    const scoped: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete scoped.TRAFFIC_ONE_STATE_PATH;
    if (!('XDG_STATE_HOME' in env)) delete scoped.XDG_STATE_HOME;
    assert.equal(overrideRoot(scoped), path.join(globalTrafficOneDir(scoped), 'overrides'),
      `[${label}] the shipped layout must be exactly where it has always been`);
  }
});
