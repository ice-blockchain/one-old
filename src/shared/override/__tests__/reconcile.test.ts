// The named repair for an override record that cannot account for itself, and
// the reason it is not a delete.
//
// THE DEFECT it answers: the completeness checks are fail-closed and have no
// exit. `echo '{}' > ~/.traffic-one/overrides/<projectKey>/snapshots/x.json`,
// with no mint, no key and no counter, refuses certification for every run in
// that project forever; so does junk in the ledger; so do 300 files in the
// snapshot directory. Nothing in retention, cleanup or reset touches that
// bucket. One file, written by anything running as the developer, is a
// permanent wedge.
//
// THE CONSTRAINT on the answer: the obvious repair — delete the orphan,
// truncate the ledger — is the exact capability the record exists to deny, and
// shipping it under a supported name would hand every erasure in
// integrity.test.ts a green path. So the repair appends. It records a signed
// statement that an operator looked at THIS state, fingerprints what they saw,
// and quarantines every run that already existed, which is what stops it from
// being a laundering step for the run someone wanted hidden.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runOverrideReconcile } from '../../../runners/doctor/unblock';
import { probeOverrides } from '../../../runners/doctor/override-probe';
import { oneSettingsPath } from '../../one-settings';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';
import { overrideProjectDir, overrideSnapshotDir } from '../paths';
import {
  OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK,
  OVERRIDE_LEDGER_ILLEGIBLE_CHECK,
  OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK,
  OVERRIDE_MINT_COUNT_MISMATCH_CHECK,
  OVERRIDE_SNAPSHOT_ORPHANED_CHECK,
  OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK,
  mintOverride,
  overrideEvidenceReport,
  overrideLedgerPath,
  readOverrideMintCounter,
  readOverrideReconciliations,
  runQuarantinedByOverrideReconciliation,
} from '../index';
import { recordOverrideReconciliation } from '../reconcile';
import {
  OVERRIDE_MINT_COUNTER_MAC_DOMAIN,
  OVERRIDE_RECONCILIATION_MAC_DOMAIN,
  OVERRIDE_TOKEN_MAC_DOMAIN,
  overrideMac,
  readOverrideKey,
} from '../keys';

// ── fixture ──────────────────────────────────────────────────────────────────

const TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

/** Answers the confirmation the way an operator at a terminal would. */
const AT_TERMINAL = async (): Promise<'confirmed'> => 'confirmed';

function withProject(runs: string[], body: (projectRoot: string) => Promise<void>): Promise<void> {
  const saved = process.env.XDG_STATE_HOME;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-override-reconcile-')));
  TEMP_DIRS.push(base);
  const projectRoot = path.join(base, 'project');
  for (const run of runs) fs.mkdirSync(path.join(projectRoot, '.traffic-one', 'runs', run), { recursive: true });
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  resetPluginUseCache();
  recordPluginUseChoice(projectRoot, true, 'test');
  return body(projectRoot).finally(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    resetPluginUseCache();
  });
}

/** The wedge in its cheapest form: one file, no mint, no key, no counter. */
function plantOrphan(projectRoot: string, id = 'deadbeefdeadbeef', body = '{"runId":"unknown"}'): string {
  const dir = overrideSnapshotDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function mint(projectRoot: string, runId: string): void {
  const result = mintOverride({
    projectRoot, runId, scope: 'gate', target: 'plan-guard', snapshot: { runId },
  });
  assert.equal(result.ok, true, `mint failed: ${result.ok ? '' : result.reason}`);
}

// ── the wedge, and the way out ───────────────────────────────────────────────

test('one planted file wedges the project, and the repair unwedges it without deleting it', async () => {
  await withProject(['run-1'], async (projectRoot) => {
    const planted = plantOrphan(projectRoot);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK],
      'no mint was ever made here and yet nothing in this project can be certified');

    const outcome = await runOverrideReconcile({ projectRoot }, AT_TERMINAL);
    assert.equal(outcome.ok, true, outcome.message);
    assert.deepEqual(outcome.reconciled, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK]);

    assert.ok(fs.existsSync(planted), 'THE POINT: the evidence is still on disk, byte for byte');
    const after = overrideEvidenceReport(projectRoot);
    assert.deepEqual(after.checks, [], 'and the project can certify again');
    assert.deepEqual(after.excused, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK],
      'the finding is excused, not erased — it is still reported, with a reason');
    assert.equal(after.reconciliations, 1);
  });
});

test('a reconciliation quarantines the runs that already existed, and only those', async () => {
  // What stops the repair from being the laundering step: the erased ledger line
  // took its run id with it, so there is no way to tell WHICH run was covered
  // up. Everything already on disk pays; work started afterwards does not.
  await withProject(['run-hidden'], async (projectRoot) => {
    mint(projectRoot, 'run-hidden');
    fs.rmSync(overrideLedgerPath(projectRoot));
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks,
      [OVERRIDE_SNAPSHOT_ORPHANED_CHECK, OVERRIDE_MINT_COUNT_MISMATCH_CHECK]);

    const outcome = await runOverrideReconcile({ projectRoot }, AT_TERMINAL);
    assert.equal(outcome.ok, true, outcome.message);
    assert.equal(outcome.quarantinedRuns, 1);

    assert.equal(runQuarantinedByOverrideReconciliation(projectRoot, 'run-hidden'), true,
      'the run they wanted certified is exactly the one that cannot be');
    assert.equal(runQuarantinedByOverrideReconciliation(projectRoot, 'run-later'), false,
      'but the project is not dead: later work certifies normally');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
  });
});

test('the acknowledgement covers the state it saw and lapses the moment that state moves', async () => {
  await withProject(['run-1'], async (projectRoot) => {
    plantOrphan(projectRoot, 'aaaaaaaaaaaaaaaa');
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);

    // Same filename, different bytes: the fingerprint is over the CONTENT, so a
    // signed acknowledgement cannot be made to cover a snapshot swapped in
    // under a name it already forgave.
    plantOrphan(projectRoot, 'aaaaaaaaaaaaaaaa', '{"runId":"swapped"}');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK],
      'the project refuses again until an operator looks again');

    // And one MORE orphan is a state nobody acknowledged either.
    plantOrphan(projectRoot, 'aaaaaaaaaaaaaaaa');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [], 'restored to the acknowledged bytes');
    plantOrphan(projectRoot, 'bbbbbbbbbbbbbbbb');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK]);
  });
});

test('a second erasure after a reconciliation is caught, because the deficit is carried not cleared', async () => {
  // The attack the excuse has to survive: reconcile once, legitimately, then
  // treat the acknowledgement as a licence to delete the next line too. The
  // counter's deficit is forgiven only up to the size that was acknowledged.
  await withProject(['run-1', 'run-2'], async (projectRoot) => {
    mint(projectRoot, 'run-1');
    fs.rmSync(overrideLedgerPath(projectRoot));
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);

    mint(projectRoot, 'run-2');
    fs.rmSync(overrideLedgerPath(projectRoot));
    assert.ok(overrideEvidenceReport(projectRoot).checks.includes(OVERRIDE_MINT_COUNT_MISMATCH_CHECK),
      'the second deleted line is a bigger deficit than anyone acknowledged');
  });
});

// ── the blindfold: an acknowledged illegible ledger ──────────────────────────

test('an acknowledged illegible ledger is not a licence to mint and erase forever', async () => {
  // THE BLOCKER, measured end to end before the fix: plant junk at the ledger
  // path with no mint, no key and no counter; run the supported repair once;
  // then mint an override, use it, and copy the acknowledged bytes back over the
  // line it wrote. Two runs settled `verified`, the counter stood at 2 against
  // zero visible mints, and no finding fired. One signature over one blob
  // forgave every future erasure, because the arm compared the ledger's bytes
  // and nothing else — while the state it forgave ALSO switched off the snapshot
  // scan and the mint-count comparison. The repair had converted a
  // denial-of-service into a durable capability.
  //
  // What holds it now is the counter: it is established at reconcile time even
  // when the project has none, pinned into the acknowledgement, monotone, and
  // signed. A mint moves it, so the acknowledgement stops matching, and nothing
  // the attacker can do inside the project moves it back.
  await withProject(['run-1'], async (projectRoot) => {
    fs.mkdirSync(path.dirname(overrideLedgerPath(projectRoot)), { recursive: true });
    fs.writeFileSync(overrideLedgerPath(projectRoot), 'garbage\n', 'utf8');
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [], 'the wedge is lifted');
    const forgiven = fs.readFileSync(overrideLedgerPath(projectRoot));

    mint(projectRoot, 'run-2');
    // The attacker's whole move: restore the acknowledged bytes over the line the
    // mint appended, and take the snapshot it wrote with them.
    fs.writeFileSync(overrideLedgerPath(projectRoot), forgiven);
    fs.rmSync(overrideSnapshotDir(projectRoot), { recursive: true, force: true });

    const report = overrideEvidenceReport(projectRoot);
    assert.deepEqual(report.checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK],
      'the ledger reads exactly as acknowledged and the project refuses anyway');
    assert.deepEqual(report.excused, []);
    assert.equal(report.mintCounter.count, 1, 'because the counter says a mint happened');
    assert.equal(report.vouchableMints, 0, 'and the file that should list it cannot be read');
  });
});

test('the repair creates the counter a wedged project has none of, so `absent` cannot be replayed', async () => {
  // The half of the blindfold that survives pinning the counter alone. The
  // cheapest wedge is a junk ledger on a machine that never minted anything, so
  // the acknowledgement would pin the counter as `absent` — and `absent` is a
  // state the attacker can reproduce at will by deleting this project's one key
  // from one.json. Mint under the blindfold, delete the key, restore the bytes,
  // and the acknowledged state is back exactly as signed.
  //
  // So the repair establishes a counter at the count the ledger currently shows.
  // Additive and monotone: an existing counter is left alone, verifying or not.
  await withProject(['run-1'], async (projectRoot) => {
    fs.mkdirSync(path.dirname(overrideLedgerPath(projectRoot)), { recursive: true });
    fs.writeFileSync(overrideLedgerPath(projectRoot), 'garbage\n', 'utf8');
    assert.equal(readOverrideMintCounter(projectRoot).state, 'absent', 'no mint was ever made here');
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    const established = readOverrideMintCounter(projectRoot);
    assert.deepEqual([established.state, established.count], ['verified', 0],
      'the acknowledgement pins a number, not the absence of one');
    const forgiven = fs.readFileSync(overrideLedgerPath(projectRoot));

    mint(projectRoot, 'run-2');
    const settings = JSON.parse(fs.readFileSync(oneSettingsPath(), 'utf8')) as Record<string, unknown>;
    delete settings.overrideMints;
    fs.writeFileSync(oneSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
    fs.writeFileSync(overrideLedgerPath(projectRoot), forgiven);
    fs.rmSync(overrideSnapshotDir(projectRoot), { recursive: true, force: true });

    assert.equal(readOverrideMintCounter(projectRoot).state, 'absent', 'the counter key is gone again');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks,
      [OVERRIDE_LEDGER_ILLEGIBLE_CHECK, OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK],
      'and the acknowledgement no longer matches, because it was signed against a number — TWO witnesses '
      + 'now, and they are independent: the first is the blindfold lapsing (the pinned counter state moved), '
      + 'the second is the acknowledgement being read as evidence that a counter entry existed at all. The '
      + 'second one holds in the arms where there is no blindfold to lapse');
  });
});

test('a signed acknowledgement floors the counter a deleted key would otherwise reset', async () => {
  // MAJOR-4's true premise, and the only bound available against it. The recorded
  // ruling said a pinned count can only be recreated by restoring signed bytes.
  // It cannot: `recordOverrideMint` takes `max(current + 1, visibleDistinctMints)`
  // and an attacker with no key writes BOTH — deleting this project's entry from
  // `overrideMints` zeroes the first, and the ledger is a file in the bucket.
  // Measured across four shapes; the sharpest is that they can land the counter
  // on any number they choose.
  //
  // The ledger cannot bound a counter against someone who writes the ledger. The
  // ACKNOWLEDGEMENT can, because removing it costs them the forgiveness they
  // broke in for: without it the state it excuses refuses certification again.
  await withProject(['run-1'], async (projectRoot) => {
    const ledger = overrideLedgerPath(projectRoot);
    mint(projectRoot, 'run-1');
    mint(projectRoot, 'run-2');
    mint(projectRoot, 'run-3');
    const genuine = fs.readFileSync(ledger, 'utf8').split('\n').filter((line) => line.trim());
    assert.equal(readOverrideMintCounter(projectRoot).count, 3);

    // An illegible ledger, acknowledged: the state whose replay this is about.
    fs.writeFileSync(ledger, 'junk\n', 'utf8');
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.equal(readOverrideMintCounter(projectRoot).count, 3, 'the acknowledgement pinned three');

    // The attacker: delete the key, cut the ledger back to one genuine line, and
    // wait for the operator's next honest mint to re-sign the counter.
    const settings = JSON.parse(fs.readFileSync(oneSettingsPath(), 'utf8')) as Record<string, unknown>;
    delete settings.overrideMints;
    fs.writeFileSync(oneSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
    fs.writeFileSync(ledger, `${genuine[0]}\n`, 'utf8');
    assert.equal(readOverrideMintCounter(projectRoot).state, 'absent', 'no signature was forged to get here');

    mint(projectRoot, 'run-4');
    const after = readOverrideMintCounter(projectRoot);
    assert.equal(after.state, 'verified');
    assert.equal(after.count, 3,
      'the count came back at the acknowledged number, not at the two the cut ledger would have bought');
  });
});

test('an acknowledgement whose counter pin did not land is refused, not signed against `absent`', async () => {
  // THE WRITER'S OWN OBSERVATION, which the round that added it recorded as
  // hardened and had not pinned: removing the `counter.state === 'absent'` check
  // left the whole suite green. It is the same guarantee the mint's bump has —
  // a write that did not throw is not a write that landed — and it matters more
  // here than the throw does, because what gets signed when it is missing is an
  // acknowledgement pinning `absent`, and `absent` is the one counter state an
  // attacker reproduces for free by deleting a key. That entry would forgive
  // its state forever.
  //
  // The state that separates a failed write from a throwing one, taken from the
  // mint's own test: the envelope is swapped underneath the pin the moment it
  // lands. Nothing throws, `establishOverrideMintCounter` truthfully reports a
  // write, and the reader that follows sees a project with no counter.
  await withProject(['run-1'], async (projectRoot) => {
    plantOrphan(projectRoot);
    const live = process.env.XDG_STATE_HOME as string;
    const stale = `${live}-stale`;
    fs.mkdirSync(stale, { recursive: true });
    const pinLanded = (): boolean => {
      try {
        return fs.readFileSync(path.join(live, 'traffic-one', 'one.json'), 'utf8').includes('"overrideMints"');
      } catch {
        return false;
      }
    };
    const env: NodeJS.ProcessEnv = { ...process.env };
    Object.defineProperty(env, 'XDG_STATE_HOME', {
      enumerable: true,
      get: () => (pinLanded() ? stale : live),
    });

    const outcome = recordOverrideReconciliation({
      projectRoot,
      env,
      quarantinedRuns: ['run-1'],
      fingerprint: {
        ledgerKind: 'absent',
        ledgerDigest: 'deadbeef',
        suppressedSnapshotDigest: '',
        orphanDigest: 'cafebabe',
        orphanCount: 1,
        snapshotCount: 1,
        snapshotScanComplete: true,
        counterState: 'absent',
        counterCount: -1,
        vouchableMints: 0,
      },
    });

    assert.equal(outcome.ok, false, 'an acknowledgement that cannot pin the counter is not an acknowledgement');
    assert.equal(outcome.ok === false && outcome.reason, 'write-failed');
    assert.equal(readOverrideReconciliations(projectRoot).entries.length, 0, 'and nothing was appended');
    assert.equal(runQuarantinedByOverrideReconciliation(projectRoot, 'run-1'), false,
      'so no run was charged for a forgiveness that was not delivered');
  });
});

test('every envelope that refuses the counter pin refuses the acknowledgement too', async () => {
  // THE OTHER REPORTED SURVIVOR, and it is honest rather than fixable: deleting
  // the early return on `establishOverrideMintCounter`'s failure leaves the
  // suite green, and it leaves this test green too. That is not a hole in the
  // pinning, it is the shape of the code — `establishOverrideMintCounter`
  // returns false for exactly two states, `unreadable` and not-`writable`, and
  // BOTH of them also make the append below throw. The early return saves the
  // MAC and the read of the existing entries; it decides nothing.
  //
  // So this pins the OUTCOME rather than the guard, and says so. Measured with
  // the return removed: all three rows below return `write-failed` unchanged.
  // The guard that does decide something is the `absent` observation, and it has
  // its own test above, which the same mutation experiment turns red.
  const wrecks: ReadonlyArray<readonly [string, (file: string) => void]> = [
    ['an unknown schemaVersion', (file) => {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      settings.schemaVersion = 99;
      fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    }],
    ['a directory at its path', (file) => {
      fs.rmSync(file, { force: true });
      fs.mkdirSync(file, { recursive: true });
    }],
    ['malformed bytes', (file) => {
      fs.writeFileSync(file, '{not json', 'utf8');
    }],
  ];

  for (const [label, wreck] of wrecks) {
    await withProject(['run-1'], async (projectRoot) => {
      plantOrphan(projectRoot);
      mint(projectRoot, 'run-1'); // so one.json exists to be wrecked
      wreck(oneSettingsPath());

      const outcome = await runOverrideReconcile({ projectRoot }, AT_TERMINAL);
      assert.equal(outcome.ok, false, `${label}: no acknowledgement is signed against an envelope that cannot hold it`);
      assert.equal(runQuarantinedByOverrideReconciliation(projectRoot, 'run-1'), false,
        `${label}: and no run is charged for it`);
      fs.rmSync(oneSettingsPath(), { force: true, recursive: true });
    });
  }
});

test('an acknowledged illegible ledger pins its bytes, its kind and the snapshot files it hid', async () => {
  // Three comparisons, one test each, because each is a different attacker move
  // and deleting any one of them passed the whole suite before this existed. The
  // ledger-bytes comparison is the single guard bounding the most dangerous
  // forgiveness this feature grants.
  await withProject(['run-1'], async (projectRoot) => {
    const ledger = overrideLedgerPath(projectRoot);
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, 'garbage\n', 'utf8');
    plantOrphan(projectRoot, 'cccccccccccccccc');
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);

    fs.writeFileSync(ledger, 'garbage\ngarbage\n', 'utf8');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK],
      'one more junk byte is a state nobody acknowledged');

    fs.writeFileSync(ledger, 'garbage\n', 'utf8');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [], 'back to the acknowledged bytes');
    fs.writeFileSync(path.join(overrideSnapshotDir(projectRoot), 'dddddddddddddddd.json'), '{}', 'utf8');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK],
      'the orphan scan is OFF in this state, so the snapshot files it cannot see are pinned instead');
  });
});

// ── what it refuses ──────────────────────────────────────────────────────────

test('the repair refuses when it would charge every run for an acknowledgement that cannot match', async () => {
  // THE DEFECT: on an `unreadable` ledger, and on an orphan whose file cannot be
  // read, the fingerprint is '' by construction — so the acknowledgement can
  // never match again — and the repair nevertheless returned ok, printed a ref,
  // and permanently quarantined every run on disk. It could be re-run
  // indefinitely, burning the next batch each time: round 1's
  // permanent-unrepairable-denial defect, reintroduced through the repair, with
  // the victim's runs spent as well. SUPPORT.md promised this refusal already.
  await withProject(['run-1', 'run-2'], async (projectRoot) => {
    const ledger = overrideLedgerPath(projectRoot);
    fs.mkdirSync(ledger, { recursive: true }); // a directory at the ledger path: EISDIR
    const outcome = await runOverrideReconcile({ projectRoot }, AT_TERMINAL);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusal, 'unfingerprintable');
    assert.match(outcome.message, /override-ledger-illegible/);
    assert.equal(readOverrideReconciliations(projectRoot).entries.length, 0);
    assert.equal(runQuarantinedByOverrideReconciliation(projectRoot, 'run-1'), false,
      'THE POINT: nothing was charged for goods that could not be delivered');
    fs.rmSync(ledger, { recursive: true, force: true });
  });
});

test('a healthy project cannot be reconciled speculatively', async () => {
  // Otherwise the cost inverts: an agent that could mint a pre-emptive
  // acknowledgement would have a standing excuse waiting for the erasure it
  // has not committed yet.
  await withProject(['run-1'], async (projectRoot) => {
    const outcome = await runOverrideReconcile({ projectRoot }, AT_TERMINAL);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusal, 'nothing-to-reconcile');
    assert.equal(readOverrideReconciliations(projectRoot).entries.length, 0);
  });
});

test('the repair refuses without a terminal, exactly like the mint', async () => {
  await withProject(['run-1'], async (projectRoot) => {
    plantOrphan(projectRoot);
    const scripted = await runOverrideReconcile({ projectRoot }, async () => 'not-interactive');
    assert.equal(scripted.ok, false);
    assert.equal(scripted.refusal, 'not-interactive');

    const declined = await runOverrideReconcile({ projectRoot }, async () => 'declined');
    assert.equal(declined.ok, false);
    assert.equal(declined.refusal, 'declined');

    assert.equal(readOverrideReconciliations(projectRoot).entries.length, 0, 'and neither wrote anything');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK]);
  });
});

test('an unsigned or edited acknowledgement excuses nothing', async () => {
  // The acknowledgement is MAC'd with the same per-install key as a token, so
  // hand-writing one into one.json — or widening one that was honestly
  // issued — buys nothing.
  await withProject(['run-1'], async (projectRoot) => {
    plantOrphan(projectRoot);
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);

    const file = oneSettingsPath();
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const section = settings.overrideReconciliations as Record<string, Record<string, unknown>[]>;
    const key = Object.keys(section)[0] as string;
    const entry = section[key]?.[0] as Record<string, unknown>;

    // Widened to forgive any orphan set at all.
    entry.orphanDigest = '';
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    const report = overrideEvidenceReport(projectRoot);
    assert.deepEqual(report.checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK], 'the MAC does not follow the edit');
    assert.equal(report.unverifiableReconciliations, 1);
    assert.equal(report.reconciliations, 0, 'and an unverifiable acknowledgement is not counted as one');

    // Reported rather than dropped: an unsigned entry in that section means
    // either a rotated key or something writing one.json directly.
    assert.equal(probeOverrides(projectRoot, 'run-1').discrepancies.includes(OVERRIDE_SNAPSHOT_ORPHANED_CHECK), true);
  });
});

test('a reconciliation is bound to its project and cannot be lifted into another', async () => {
  await withProject(['run-1'], async (projectRoot) => {
    plantOrphan(projectRoot);
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);

    const file = oneSettingsPath();
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const section = settings.overrideReconciliations as Record<string, unknown>;
    const key = Object.keys(section)[0] as string;

    // A sibling project, wedged the same way, handed the same signed entry.
    const sibling = path.join(path.dirname(projectRoot), 'sibling');
    fs.mkdirSync(path.join(sibling, '.traffic-one', 'runs', 'run-1'), { recursive: true });
    recordPluginUseChoice(sibling, true, 'test');
    plantOrphan(sibling);
    const siblingKey = Object.keys(
      (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>).overrideMints ?? {},
    ).find((candidate) => candidate !== key);
    section[siblingKey ?? 'sibling'] = section[key];
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');

    assert.deepEqual(overrideEvidenceReport(sibling).checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK],
      'the project key is inside the MAC, so a copied acknowledgement is unverifiable in its new home. '
      + 'NOTE the explicit projectKey comparison in parseReconciliation is belt-and-braces, not the '
      + 'control: deleting it leaves this passing, because the MAC covers that field. Kept because a '
      + 'cheap equality read next to the signature check is how a reader learns the entry is scoped.');
  });
});

// ── properties that were asserted in prose and nowhere else ──────────────────
//
// Each of the four below survived a mutation campaign: the code could be made to
// do the opposite and the suite stayed green, because the invariant lived in a
// comment. A comment is not a control.

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(oneSettingsPath(), 'utf8')) as Record<string, unknown>;
}

function writeSettings(value: unknown): void {
  fs.writeFileSync(oneSettingsPath(), JSON.stringify(value, null, 2), 'utf8');
}

function counterEntry(settings: Record<string, unknown>): Record<string, unknown> {
  const section = settings.overrideMints as Record<string, Record<string, unknown>>;
  return section[Object.keys(section)[0] as string] as Record<string, unknown>;
}

function reconciliationEntry(settings: Record<string, unknown>): Record<string, unknown> {
  const section = settings.overrideReconciliations as Record<string, Record<string, unknown>[]>;
  return (section[Object.keys(section)[0] as string] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

test('the repair leaves an existing counter EXACTLY as it found it, even one that does not verify', async () => {
  // ADDITIVE, NEVER CORRECTIVE. `establishOverrideMintCounter` writes a counter
  // only for a project that has none; an entry that exists and does not verify
  // is EVIDENCE that something wrote it, and re-signing it would be the one
  // place in this feature that erases something — the repair's own second
  // property ("it deletes nothing, anywhere") would be false, and the operator
  // would be handed a freshly valid counter in place of the tampering they were
  // reconciling.
  await withProject(['run-1'], async (projectRoot) => {
    mint(projectRoot, 'run-1');
    const settings = readSettings();
    counterEntry(settings).count = 9; // the MAC does not follow: unverifiable at 9
    writeSettings(settings);
    const tampered = JSON.parse(JSON.stringify(counterEntry(readSettings()))) as Record<string, unknown>;
    assert.deepEqual(
      [readOverrideMintCounter(projectRoot).state, readOverrideMintCounter(projectRoot).count],
      ['unverifiable', 9],
    );
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK]);

    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);

    assert.deepEqual(counterEntry(readSettings()), tampered,
      'THE POINT: the edited entry is still there, byte for byte, with the MAC that does not check out');
    const after = readOverrideMintCounter(projectRoot);
    assert.deepEqual([after.state, after.count], ['unverifiable', 9],
      'the repair pinned that state rather than replacing it with a valid one');
    assert.deepEqual(overrideEvidenceReport(projectRoot).excused, [OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK],
      'and forgiveness comes from the acknowledgement, which is revocable evidence, not from a rewrite');
  });
});

test('an acknowledgement signed in another domain is not an acknowledgement', async () => {
  // DOMAIN SEPARATION, which keys.ts calls load-bearing and which nothing
  // checked. One install key signs three flat records — a ledger token, a mint
  // counter, a reconciliation — so without a distinct prefix per record the
  // question "did the doctor issue this?" stops distinguishing WHICH thing it
  // issued, and a signature over one shape is redeemable in the slot of
  // another. It matters most here, because this is the slot that FORGIVES.
  await withProject(['run-1'], async (projectRoot) => {
    plantOrphan(projectRoot);
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
    const key = readOverrideKey();
    assert.ok(key, 'the repair minted the install key');

    for (const [label, domain] of [
      ['the token domain', OVERRIDE_TOKEN_MAC_DOMAIN],
      ['the mint counter domain', OVERRIDE_MINT_COUNTER_MAC_DOMAIN],
    ] as const) {
      const settings = readSettings();
      const entry = reconciliationEntry(settings);
      // Every byte of the record kept, only the domain changed: the same
      // operator decision, re-signed as if it were the other kind of record.
      entry.mac = overrideMac(entry, key as string, domain);
      writeSettings(settings);
      const report = overrideEvidenceReport(projectRoot);
      assert.deepEqual(report.checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK], `${label} forgives nothing`);
      assert.equal(report.unverifiableReconciliations, 1, label);
    }

    // The control, and it is what makes the two above evidence rather than a
    // tautology: the identical procedure under the RECONCILIATION domain
    // restores the forgiveness, so the only thing being tested is the prefix.
    const settings = readSettings();
    const entry = reconciliationEntry(settings);
    entry.mac = overrideMac(entry, key as string, OVERRIDE_RECONCILIATION_MAC_DOMAIN);
    writeSettings(settings);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
  });
});

test('an acknowledged over-full snapshot directory is forgiven at the size it was, and not as it grows', async () => {
  // The bound the acknowledgement carries for a scan that could not finish.
  // Past 256 files the scan stops looking, so the orphan question is not being
  // asked about the rest — and an acknowledgement of THAT state which did not
  // bound the count would forgive a directory an attacker keeps filling, with
  // every file past the cap unexamined forever. Adjacent to a recorded
  // residual (the cap is what an attacker fills toward), which is exactly why
  // the one comparison holding it has to be pinned.
  await withProject(['run-1'], async (projectRoot) => {
    const dir = overrideSnapshotDir(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 257; i += 1) {
      fs.writeFileSync(path.join(dir, `a${String(i).padStart(4, '0')}.json`), '{"runId":"unknown"}', 'utf8');
    }
    const wedged = overrideEvidenceReport(projectRoot);
    assert.equal(wedged.snapshotScanComplete, false, '257 files is one past the scan bound');
    assert.equal(wedged.snapshotCount, 257);
    assert.ok(wedged.checks.includes(OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK));

    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [], 'the operator looked at 257 files');

    // One more file, named so it sorts PAST the scan window: the 256 files the
    // scan does read are the same ones, so the orphan set is untouched and the
    // only thing that moved is the size of the unexamined tail.
    fs.writeFileSync(path.join(dir, 'ffffffffffffffff.json'), '{"runId":"unknown"}', 'utf8');
    const grown = overrideEvidenceReport(projectRoot);
    assert.deepEqual(grown.checks, [OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK],
      'the directory got bigger behind the blindfold, so the acknowledgement lapses');
    assert.deepEqual(grown.excused, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK],
      'and the orphan set, which did not move, is still accounted for');
  });
});

test('a counter that goes unverifiable at the SAME number lapses an acknowledged illegible ledger', async () => {
  // The state comparison in the illegible arm, which survived deletion because
  // every transition reachable through the product ALSO moves the count — a
  // mint bumps it, deleting the key drops it to `absent` with no number. The
  // equivalence does not hold against an editor: one byte inside the entry
  // leaves the count exactly where the acknowledgement pinned it and takes the
  // signature with it, which is a counter that no longer says anything. Under
  // a blindfold whose whole justification is "the counter is holding this
  // state still", accepting an unverifiable counter as the pinned verified one
  // forgives precisely the state the pin exists to detect.
  await withProject(['run-1'], async (projectRoot) => {
    fs.mkdirSync(path.dirname(overrideLedgerPath(projectRoot)), { recursive: true });
    fs.writeFileSync(overrideLedgerPath(projectRoot), 'garbage\n', 'utf8');
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
    assert.deepEqual(
      [readOverrideMintCounter(projectRoot).state, readOverrideMintCounter(projectRoot).count],
      ['verified', 0],
      'pinned as verified at zero',
    );

    const settings = readSettings();
    counterEntry(settings).v = 2; // still count 0, no longer signed for anything
    writeSettings(settings);
    const moved = readOverrideMintCounter(projectRoot);
    assert.deepEqual([moved.state, moved.count], ['unverifiable', 0],
      'the NUMBER did not move — only the state did, which is the case the comparison exists for');

    const report = overrideEvidenceReport(projectRoot);
    assert.ok(report.checks.includes(OVERRIDE_LEDGER_ILLEGIBLE_CHECK),
      'so the blindfold is no longer acknowledged');
    assert.deepEqual(report.excused, [], 'nothing here is forgiven any more');
  });
});

// ── the lapse question, ruled by measurement ─────────────────────────────────

test('replaying an acknowledgement costs an envelope rollback, which buys the same thing with no acknowledgement at all', () => {
  // WHY THIS TEST DECIDES A DESIGN QUESTION. An acknowledgement pins the
  // counter's state and value and nothing binds it to a moment, so it is
  // replayable by construction — which is an argument for expiring it. What
  // makes the argument fail is that the ONLY way to walk the count back to a
  // pinned value is to restore the previously signed entry BYTES (an edited
  // count is unverifiable, and the test above pins that an unverifiable counter
  // at the pinned number lapses the acknowledgement). Restoring the envelope is
  // the rollback mint-counter.ts records as out of scope — and the two arms here
  // measure that it grants the attacker exactly as much in a project that has
  // never been reconciled. An expiry would therefore price the honest operator
  // — an illegible ledger can never be cleaned, so the repair would be due again
  // on every window, and each repeat permanently quarantines every run made
  // since the last one — for no reduction in what an attacker can reach.
  //
  // The ruling holds only while both arms read alike. If an anchor outside
  // `one.json` ever exists (a high-water mark in the bucket, a monotone clock
  // this layer can trust), the rollback stops being free, and the replay becomes
  // a capability the acknowledgement adds on its own — at which point the lapse
  // is the fix and this test is where the change of premise shows up.
  return withProject(['run-1', 'run-2'], async (projectRoot) => {
    const ledger = overrideLedgerPath(projectRoot);
    const snapshots = overrideSnapshotDir(projectRoot);

    // ARM A — no reconciliation anywhere. The control.
    mint(projectRoot, 'run-1');
    const envelopeBefore = fs.readFileSync(oneSettingsPath());
    const ledgerBefore = fs.readFileSync(ledger);
    const snapshotsBefore = new Set(fs.readdirSync(snapshots));
    mint(projectRoot, 'run-2');
    assert.equal(readOverrideMintCounter(projectRoot).count, 2);

    fs.writeFileSync(ledger, ledgerBefore);
    for (const name of fs.readdirSync(snapshots)) {
      if (!snapshotsBefore.has(name)) fs.rmSync(path.join(snapshots, name));
    }
    fs.writeFileSync(oneSettingsPath(), envelopeBefore);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [],
      'the second mint is gone without a trace, and no acknowledgement was involved');
    assert.equal(readOverrideMintCounter(projectRoot).count, 1, 'the counter was walked back with the envelope');

    // ARM B — the same rollback with an acknowledged blindfold in force.
    fs.writeFileSync(ledger, 'garbage\n', 'utf8');
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
    const acknowledged = fs.readFileSync(ledger);
    const envelopeAcknowledged = fs.readFileSync(oneSettingsPath());
    const acknowledgedSnapshots = new Set(fs.readdirSync(snapshots));

    mint(projectRoot, 'run-2');
    fs.writeFileSync(ledger, acknowledged);
    for (const name of fs.readdirSync(snapshots)) {
      if (!acknowledgedSnapshots.has(name)) fs.rmSync(path.join(snapshots, name));
    }
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK],
      'restoring the bucket alone is not enough: the counter moved, and the pin catches it');

    fs.writeFileSync(oneSettingsPath(), envelopeAcknowledged);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [],
      'THE MEASUREMENT: the acknowledgement replays, and it took exactly the move that '
      + 'already worked in arm A — the envelope rollback, not the acknowledgement');
  });
});

// ── the acknowledgement read as EVIDENCE ─────────────────────────────────────

/** The cheapest documented residual: delete this project's one counter key. */
function dropCounterKey(): void {
  const settings = readSettings();
  const section = settings.overrideMints as Record<string, unknown>;
  delete section[Object.keys(section)[0] as string];
  writeSettings(settings);
}

/** …and the one that reaches a genuine clean install: drop the operator's
 *  acknowledgement too. One more key, in the file they are already editing. */
function dropAcknowledgements(): void {
  const settings = readSettings();
  const section = settings.overrideReconciliations as Record<string, unknown>;
  delete section[Object.keys(section)[0] as string];
  writeSettings(settings);
}

test('a wipe that leaves the acknowledgement behind is contradicted by it; a wipe that takes it is a clean install', async () => {
  // THE MEASUREMENT THAT MOVED THIS FILE'S RULING (reproduced here as the two
  // arms below). A project reconciled after three mints carries a signed
  // statement that its counter stood at `verified/3`.
  // `rm -rf` the bucket and delete this project's one key from `overrideMints`,
  // and every witness reads the clean install — while the statement
  // contradicting that reading is sitting in the same file. Certification came
  // back CLEAR, because nothing compared the two, and findings.ts had been
  // promising operators in so many words that "a counter that disappears"
  // refuses again.
  //
  // ARM B is why this does NOT make the total wipe detectable, and therefore
  // why the expiry ruling above is unchanged: one more key deletion, in the
  // file the attacker is already editing, reaches a project with no counter, no
  // acknowledgement and no bucket — which is an install that never minted, and
  // has to stay eligible. The acknowledgement is evidence when it is left
  // behind; it is not an anchor, because it lives inside the blast radius.
  await withProject(['run-1', 'run-2', 'run-3'], async (projectRoot) => {
    mint(projectRoot, 'run-1');
    mint(projectRoot, 'run-2');
    mint(projectRoot, 'run-3');
    fs.rmSync(overrideLedgerPath(projectRoot));
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
    const pinned = readOverrideReconciliations(projectRoot).entries[0];
    assert.deepEqual([pinned?.counterState, pinned?.counterCount], ['verified', 3]);

    // ARM A — the wipe the peer measured. The acknowledgement stays.
    fs.rmSync(overrideProjectDir(projectRoot), { recursive: true, force: true });
    dropCounterKey();
    const wiped = overrideEvidenceReport(projectRoot);
    assert.equal(wiped.mintCounter.state, 'absent', 'every witness reads the clean install…');
    assert.equal(wiped.vouchableMints, 0);
    assert.equal(wiped.reconciliations, 1, '…beside a signed statement that says otherwise');
    assert.deepEqual(wiped.checks, [OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK],
      'THE POINT: the comparison had both values in hand and was not being made');
    assert.deepEqual(wiped.excused, [],
      'and no acknowledgement forgives it, because the only one on record is the one being contradicted');

    // ARM B — one more deletion, and the same project is a clean install.
    dropAcknowledgements();
    const clean = overrideEvidenceReport(projectRoot);
    assert.equal(clean.reconciliations, 0);
    assert.deepEqual(clean.checks, [],
      'MEASURED, not conceded: this is what a machine that never minted an override looks like, and '
      + 'refusing here would refuse every one of them. The expiry ruling rests on this arm.');
  });
});

test('the contradiction has a way out, and the way out survives the next honest mint', async () => {
  // A control with no exit is a wedge, which is the defect this whole file
  // exists to answer — so the check added above must be reconcilable, and
  // reconciling it must not leave the project one mint away from refusing
  // again. Both halves are load-bearing: the repair establishes a counter at
  // the count the ledger now shows and pins THAT, so the excuse is "some
  // acknowledgement the live counter still honours" rather than "some
  // acknowledgement that matches it exactly". An exact-match excuse passes the
  // first assertion below and fails the mint after it.
  await withProject(['run-1', 'run-2'], async (projectRoot) => {
    mint(projectRoot, 'run-1');
    mint(projectRoot, 'run-2');
    fs.rmSync(overrideLedgerPath(projectRoot));
    assert.equal((await runOverrideReconcile({ projectRoot }, AT_TERMINAL)).ok, true);

    fs.rmSync(overrideProjectDir(projectRoot), { recursive: true, force: true });
    dropCounterKey();
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks,
      [OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK]);

    const repair = await runOverrideReconcile({ projectRoot }, AT_TERMINAL);
    assert.equal(repair.ok, true, repair.message);
    assert.deepEqual(repair.reconciled, [OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK]);
    assert.equal(repair.quarantinedRuns, 2, 'and it is not free: every run on disk pays, as always');
    const repaired = overrideEvidenceReport(projectRoot);
    assert.deepEqual(repaired.checks, []);
    assert.deepEqual(repaired.excused, [OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK]);

    fs.mkdirSync(path.join(projectRoot, '.traffic-one', 'runs', 'run-3'), { recursive: true });
    mint(projectRoot, 'run-3');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [],
      'THE HALF THAT IS EASY TO GET WRONG: the counter moved off the number the operator signed for, '
      + 'upwards, which is what every mint does');

    // And the exit is not a licence: deleting the key a second time contradicts
    // the new pin exactly as it did the old one.
    dropCounterKey();
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks,
      [OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK]);
  });
});
