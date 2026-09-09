import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { stableContractJson } from '../architecture-contract';
import { readJsonResult } from '../fsjson';
import { isMaintenanceTerminal } from '../maintenance/terminal';
import { oneSettingsPath } from '../one-settings';
import {
  mintOverride,
  overrideEvidenceReport,
  overrideLedgerPath,
  overrideReconciliationDraft,
  recordOverrideReconciliation,
  signVerifiedSettlement,
  verifiedSettlementAuthentic,
} from '../override';
import {
  RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
  RUN_SETTLEMENT_SCHEMA_VERSION,
  settlementHash,
} from '../run-settlement/types';
import { qaReportV2Path, recordStackResolution } from '../qa-report-v2';
import {
  SETTLEMENT_RECORD_ILLEGIBLE_CHECK,
  activateRunV2RollbackBarrier,
  activeRunClaimScan,
  effectiveLegacyRunStatus,
  projectRunLedgerForV2Rollback,
  readRunSettlement,
  readRunSettlementResult,
  reconcileRunSettlement,
  writeRunSettlement,
  type CanonicalRunStatus,
} from '../run-settlement';
import { sha256 } from '../text';
import { DEFAULT_LIGHTHOUSE_THRESHOLDS, currentVerificationSourceHash, verificationContractPath, type VerificationContractV2 } from '../verification-contract';
import { runtime1019AcceptsTransition } from './fixtures/runtime-1.0.19-run-ledger';
import { SKIP_10K_TREE_ON_WIN32 } from '../../test-support/__tests__/git-fixture';

function withProject(run: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-settlement-'));
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'R'), { recursive: true });
    run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function writeStrictVerificationEvidence(cwd: string, runId = 'R'): VerificationContractV2 {
  const now = new Date().toISOString();
  const withoutHash = {
    schemaVersion: 2 as const,
    runId,
    architectureHash: sha256('architecture'),
    baseline: {
      kind: 'file-manifest' as const,
      identity: 'manifest:strict-settlement',
      capturedAt: now,
      filesHash: sha256('files'),
      fileCount: 0,
      files: [],
    },
    uiImpact: 'none' as const,
    uiImpactSource: 'runtime' as const,
    changedPaths: [],
    changedRoutes: [],
    scanComplete: true,
    requiredChecks: ['stack-build', 'stack-test', 'stack-lint'],
    browserRequired: false,
    nativeAdapter: null,
    requiredScreenshotWidths: [],
    tabletRisk: false,
    buildIdentityRequired: false,
    performance: {
      required: false,
      advisory: false,
      reason: 'not-required' as const,
      thresholds: { ...DEFAULT_LIGHTHOUSE_THRESHOLDS },
      advisoryTolerancePercent: 3 as const,
    },
    generatedAt: now,
  };
  const contract: VerificationContractV2 = {
    ...withoutHash,
    contractHash: sha256(stableContractJson(withoutHash)),
  };
  fs.writeFileSync(verificationContractPath(cwd, runId), JSON.stringify(contract));
  const source = currentVerificationSourceHash(cwd, contract);
  const reportPath = qaReportV2Path(cwd, runId);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 2,
    runId,
    verificationContractHash: contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'senior-tester',
    status: 'passed',
    sourceHash: source.hash,
    checks: contract.requiredChecks.map((id) => ({ id, status: 'passed' })),
    routes: [],
  }));
  const digests = path.join(cwd, '.traffic-one', 'digests', runId);
  fs.mkdirSync(digests, { recursive: true });
  fs.writeFileSync(path.join(digests, 'reviewer.md'), '# Reviewer\nverdict: APPROVED\n');
  fs.writeFileSync(path.join(digests, 'tester.md'), '# Tester\nverdict: TESTS_GREEN\n');
  const resolved: Record<string, { declared: 'declared'; executed: 'passed' }> = {};
  for (const id of contract.requiredChecks) resolved[id] = { declared: 'declared', executed: 'passed' };
  if (!recordStackResolution(cwd, runId, resolved)) {
    throw new Error('fixture guard: runtime passed record must persist');
  }
  return contract;
}

test('maintenance terminality is shared and fallback-pending is always nonterminal', () => {
  assert.equal(isMaintenanceTerminal({ overallOutcome: 'fallback-pending', fallbackAllowed: true }), false);
  assert.equal(isMaintenanceTerminal({ overallOutcome: 'success' }), true);
  assert.equal(isMaintenanceTerminal({ outcome: 'fallback-paid' }), false);
  assert.equal(isMaintenanceTerminal({ outcome: 'unknown' }), false);
});

test('verified settlement fails closed while a claim or check remains active', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'worker.json'), JSON.stringify({
      role: 'senior-frontend',
      status: 'claimed',
    }));
    const settlement = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      incompleteChecks: ['qa-incomplete'],
    });
    assert.equal(settlement?.status, 'validating');
    assert.ok(settlement?.incompleteChecks.includes('active-claims'));
    assert.ok(settlement?.incompleteChecks.includes('qa-incomplete'));
    assert.ok(settlement?.incompleteChecks.includes('reviewer-approval-missing'));
    const ledger = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.canonicalStatus, 'validating');
    assert.equal(effectiveLegacyRunStatus(ledger), 'active');
  });
});

test('a settlement that exists and does not parse is preserved, rebuilt, and never certifies again', () => {
  // IMMUTABILITY THAT ONE EDIT REMOVES, which is the defect, and the SECOND
  // shape of its fix. The terminal guard reads the previous record through a
  // parser that answers `null` for any hash or shape damage, so an intact
  // terminal settlement resisted being reopened while the SAME record with one
  // byte changed was overwritten at revision 1 — by anything that can write the
  // project tree, which is where this file lives.
  //
  // The first fix REFUSED the write, and this test pinned that. It bought the
  // property at the price of a wedge: no writer, not even `failed`, could settle
  // the run again, and 32 of a measured 63 damaged-record × ledger-state cells
  // lost their canonical terminal status. What is pinned now keeps the property
  // and drops the wedge — the damage buys the attacker nothing it did not
  // already have, because the run comes back PERMANENTLY UNCERTIFIABLE.
  withProject((cwd) => {
    writeStrictVerificationEvidence(cwd);
    assert.equal(writeRunSettlement(cwd, 'R', { status: 'blocked' })?.status, 'blocked');
    const file = path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json');
    // The control: intact, the terminal guard holds and the record is returned
    // unchanged, so what happens below is not just "terminal states are refused".
    const held = writeRunSettlement(cwd, 'R', { status: 'failed' });
    assert.equal(held?.status, 'blocked');
    assert.equal(held?.revision, 1);

    const damaged = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    damaged.updatedAt = new Date(Date.now() + 1000).toISOString();
    const damagedBytes = JSON.stringify(damaged, null, 2);
    fs.writeFileSync(file, damagedBytes, 'utf8');
    assert.equal(readRunSettlement(cwd, 'R'), null, 'one edit and the record no longer parses');
    assert.equal(readRunSettlementResult(cwd, 'R').kind, 'malformed',
      'and the read says WHICH kind of unreadable, rather than answering like an absent one');

    // THE WEDGE IS GONE: the run settles.
    const rebuilt = writeRunSettlement(cwd, 'R', { status: 'failed' });
    assert.equal(rebuilt?.status, 'failed', 'a damaged record is no longer a wedge — the run still settles');
    assert.equal(readRunSettlement(cwd, 'R')?.status, 'failed', 'durably');

    // THE BYTES SURVIVE, which is what makes rebuilding defensible at all.
    assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), damagedBytes,
      'the damaged record is preserved beside itself, byte for byte');

    // AND THE DAMAGE BOUGHT NOTHING. The marker is inside the hashed record, so
    // removing it makes the record illegible again and puts it straight back.
    assert.ok(rebuilt?.incompleteChecks.includes(SETTLEMENT_RECORD_ILLEGIBLE_CHECK),
      'the run carries the damage permanently');
  });

  // The point of the marker, on a run that is otherwise GENUINELY certifiable:
  // damaging the record used to be a way to blank a run's history and start it
  // clean. Now it is a way to make it uncertifiable forever.
  withProject((cwd) => {
    writeStrictVerificationEvidence(cwd);
    // Control: this exact fixture certifies when nothing was ever damaged.
    assert.equal(writeRunSettlement(cwd, 'R', { status: 'verified' })?.status, 'verified');
  });
  withProject((cwd) => {
    writeStrictVerificationEvidence(cwd);
    const file = path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json');
    assert.equal(writeRunSettlement(cwd, 'R', { status: 'active' })?.status, 'active');
    fs.writeFileSync(file, '{"schemaVersion":2,"runId":"R","status":"act', 'utf8');

    const first = writeRunSettlement(cwd, 'R', { status: 'verified' });
    assert.equal(first?.status, 'validating', 'the pass that FINDS the damage refuses to certify');
    assert.equal(first?.reason, SETTLEMENT_RECORD_ILLEGIBLE_CHECK,
      'under its own name, which is the one an operator cannot repair by fixing something else');

    // …and once, forever: the second pass reads a record it wrote itself, so the
    // marker has to be carried forward or the very next write certifies.
    const second = writeRunSettlement(cwd, 'R', { status: 'verified' });
    assert.equal(second?.status, 'validating', 'and so does every pass after it');
    assert.ok(second?.incompleteChecks.includes(SETTLEMENT_RECORD_ILLEGIBLE_CHECK));
    const ledger = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), 'utf8'));
    assert.notEqual(ledger.outcome, 'shipped', 'so `shipped` is unreachable too');

    // A DIFFERENT run in the same project is untouched: this is a run-scoped
    // consequence of that run's own record, not a project kill switch.
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'S'), { recursive: true });
    writeStrictVerificationEvidence(cwd, 'S');
    assert.equal(writeRunSettlement(cwd, 'S', { status: 'verified' })?.status, 'verified');
  });

  // ABSENT is still absent, and still the ordinary case: a run with no record
  // certifies normally. Without this the marker could be reached by "no
  // settlement" and every first write in the product would be uncertifiable.
  withProject((cwd) => {
    writeStrictVerificationEvidence(cwd);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json')), false);
    assert.equal(writeRunSettlement(cwd, 'R', { status: 'verified' })?.status, 'verified');
  });
});

test('a damaged record we cannot preserve is not rebuilt over', () => {
  // The one refusal that remains, and the rule it shares with
  // `writeLegacyProjection`: preservation comes first. Rebuilding over bytes we
  // could not copy aside destroys the only account of what the record claimed,
  // which is the thing the whole marker exists to make impossible to erase.
  //
  // A DANGLING LINK at the quarantine path, following publisher-write-refusal
  // .test.ts: `settlement-v2.json.corrupt` is only ever WRITTEN, so there is no
  // read to keep alive, and the consent fence refuses a link at either end of a
  // move.
  withProject((cwd) => {
    const file = path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json');
    // Writable baseline: the same damage with the quarantine path unfenced both
    // preserves and rebuilds. Without it a fence closed for an unrelated reason
    // would pass identically.
    fs.writeFileSync(file, 'not json', 'utf8');
    assert.equal(writeRunSettlement(cwd, 'R', { status: 'failed' })?.status, 'failed',
      'writable baseline: the rebuild lands');
    assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf8'), 'not json',
      'writable baseline: after the preservation');
  });
  withProject((cwd) => {
    const file = path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json');
    fs.writeFileSync(file, 'not json either', 'utf8');
    fs.symlinkSync(path.join(path.dirname(file), 'no-such-target'), `${file}.corrupt`);
    assert.equal(fs.existsSync(`${file}.corrupt`), false, 'fixture guard: the link is dangling');

    assert.equal(writeRunSettlement(cwd, 'R', { status: 'failed' }), null,
      'a record we could not preserve is not replaced — the refusal of the copy refuses the write');
    assert.equal(fs.readFileSync(file, 'utf8'), 'not json either', 'and the bytes are exactly as they were');
  });
});

test('a symlink at the settlement path is refused rather than moved aside', () => {
  // The quarantine must not become a way to clear the consent fence. A planted
  // link at `settlement-v2.json` is refused by fsjson on every write; if the
  // rebuild could rename it out of the way first, the SECOND write would land
  // through a path the fence had already refused once.
  withProject((cwd) => {
    const file = path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json');
    const elsewhere = path.join(cwd, 'elsewhere.json');
    fs.writeFileSync(elsewhere, '{"planted":true}', 'utf8');
    fs.symlinkSync(elsewhere, file);

    assert.equal(writeRunSettlement(cwd, 'R', { status: 'failed' }), null, 'the write is refused');
    assert.ok(fs.lstatSync(file).isSymbolicLink(), 'and the link is left exactly where it was');
    assert.equal(fs.existsSync(`${file}.corrupt`), false, 'nothing was moved aside');
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), '{"planted":true}', 'and its target is untouched');
  });
});

test('two spellings of one run id are one settlement record', () => {
  // The path helper sanitises and the parser compares EXACTLY, so writing a
  // settlement for an id with a trailing space landed it in the sanitised
  // directory carrying the unsanitised id — after which reading the canonical
  // id answered `null`, blanking another run's canonical record for free.
  // Composes with the refusal above, which reads "exists and does not parse" as
  // a reason to refuse every later write, so the blanking would have become a
  // wedge anyone could plant with one argument.
  withProject((cwd) => {
    assert.equal(writeRunSettlement(cwd, 'R', { status: 'active' })?.status, 'active');
    const spelled = writeRunSettlement(cwd, 'R ', { status: 'blocked' });
    assert.equal(spelled?.status, 'blocked');
    assert.equal(spelled?.runId, 'R', 'the record carries the canonical id, not the caller\'s spelling');
    assert.equal(readRunSettlement(cwd, 'R')?.status, 'blocked', 'and the canonical read still finds it');
    assert.equal(readRunSettlement(cwd, 'R ')?.status, 'blocked', 'from either spelling');
    assert.equal(fs.readdirSync(path.join(cwd, '.traffic-one', 'runs')).sort().join(','), 'R',
      'one directory, one record');
  });
});

// The operator-override abuse guard. Driven through a run that is otherwise
// GENUINELY verifiable — full strict evidence, no active claims — so the
// downgrade can only be coming from the override, and so removing the guard
// turns this test red rather than leaving it green for another reason.
test('a run somebody minted an operator override for can never settle verified or shipped', () => {
  const savedXdg = process.env.XDG_STATE_HOME;
  const machineBase = fs.mkdtempSync(path.join(os.tmpdir(), 't1-settlement-override-'));
  process.env.XDG_STATE_HOME = machineBase;
  try {
    withProject((cwd) => {
      writeStrictVerificationEvidence(cwd);
      // The control: without an override this exact fixture settles verified.
      // Without it, "validating" below proves nothing.
      assert.equal(writeRunSettlement(cwd, 'R', { status: 'verified' })?.status, 'verified');
    });

    withProject((cwd) => {
      writeStrictVerificationEvidence(cwd);
      const minted = mintOverride({
        projectRoot: cwd, runId: 'R', scope: 'gate', target: 'plan-guard', snapshot: {},
        // Already expired: the guard is TTL-blind on purpose, or waiting out
        // 30 minutes would launder the run.
        ttlMs: 1_000, nowMs: Date.now() - 60_000,
      });
      assert.equal(minted.ok, true);

      const settlement = writeRunSettlement(cwd, 'R', { status: 'verified' });
      assert.equal(settlement?.status, 'validating');
      assert.equal(settlement?.reason, 'operator-override-used');
      assert.ok(settlement?.incompleteChecks.includes('operator-override-used'));
      // `shipped` is only ever projected onto a verified settlement, so one
      // refusal covers both halves of the plan's requirement.
      const ledger = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), 'utf8'));
      assert.notEqual(ledger.outcome, 'shipped');
      assert.equal(ledger.canonicalStatus, 'validating');

      // And it is permanent: re-asking does not eventually get a yes.
      assert.equal(writeRunSettlement(cwd, 'R', { status: 'verified' })?.status, 'validating');
      // A DIFFERENT run in the same project is untouched — the guard is
      // run-scoped, not a project-wide kill switch.
      fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'S'), { recursive: true });
      writeStrictVerificationEvidence(cwd, 'S');
      assert.equal(writeRunSettlement(cwd, 'S', { status: 'verified' })?.status, 'verified');
    });
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedXdg;
    fs.rmSync(machineBase, { recursive: true, force: true });
  }
});

test('a verified settlement this install writes carries a settlementMac the hash ignores', () => {
  const savedXdg = process.env.XDG_STATE_HOME;
  const machineBase = fs.mkdtempSync(path.join(os.tmpdir(), 't1-settlement-mac-'));
  process.env.XDG_STATE_HOME = machineBase;
  try {
    withProject((cwd) => {
      // Planted rather than earned: this pin is the MAC, not the QA fixture.
      // `writeRunSettlement(..., verified)` also consults QaReportV2, and a
      // hand-authored report can fail that validator for reasons this test
      // must not inherit.
      const withoutHash = {
        schemaVersion: RUN_SETTLEMENT_SCHEMA_VERSION,
        runId: 'R',
        runtimeVersion: RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
        minimumRuntimeVersion: RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
        status: 'verified' as const,
        activeClaims: 0,
        incompleteChecks: [] as string[],
        revision: 1,
        updatedAt: new Date().toISOString(),
      };
      const hashed = { ...withoutHash, settlementHash: settlementHash(withoutHash) };
      const mac = signVerifiedSettlement(cwd, hashed);
      assert.ok(mac, 'this install could sign');
      fs.writeFileSync(
        path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json'),
        JSON.stringify({ ...hashed, settlementMac: mac }),
      );
      const settlement = readRunSettlement(cwd, 'R');
      assert.equal(settlement?.status, 'verified');
      assert.equal(settlement?.settlementMac, mac);
      assert.equal(verifiedSettlementAuthentic(cwd, settlement!), true);

      const raw = JSON.parse(fs.readFileSync(
        path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json'),
        'utf8',
      )) as Record<string, unknown>;
      const { settlementHash: observed, settlementMac, ...canonical } = raw;
      assert.equal(settlementMac, mac);
      assert.equal(settlementHash(canonical), observed, 'the MAC is outside the unkeyed digest');

      delete raw.settlementMac;
      fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'settlement-v2.json'), JSON.stringify(raw));
      const unsigned = readRunSettlement(cwd, 'R');
      assert.equal(unsigned?.status, 'verified');
      assert.equal(verifiedSettlementAuthentic(cwd, unsigned!), false,
        'the same bytes without a MAC are not a certificate this install signed');
    });
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedXdg;
    fs.rmSync(machineBase, { recursive: true, force: true });
  }
});

// The step AFTER the guard above, which is where the green run actually came
// from. The abuse guard reads the ledger, so deleting the ledger answered it
// with "no override was ever minted" and the run settled `verified` with
// `reason=none` — measured, and reproduced by the first case below before the
// completeness checks existed. Every case here drives a run that is otherwise
// GENUINELY verifiable, so a refusal can only be coming from the override
// record; the eligible cases are the ones that prove the checks have not simply
// been wired to refuse everything.
function withMachineDir(body: (machineDir: string) => void): void {
  const saved = process.env.XDG_STATE_HOME;
  const machineBase = fs.mkdtempSync(path.join(os.tmpdir(), 't1-settlement-override-'));
  process.env.XDG_STATE_HOME = machineBase;
  try {
    body(machineBase);
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    // The unreadable-ledger case clamps a file to 0o000, which defeats the rm
    // on some platforms.
    try { fs.chmodSync(path.join(machineBase, 'traffic-one'), 0o700); } catch { /* not that case */ }
    fs.rmSync(machineBase, { recursive: true, force: true });
  }
}

test('erasing the override ledger does not buy back a verified run', () => {
  withMachineDir(() => {
    withProject((cwd) => {
      writeStrictVerificationEvidence(cwd);
      const minted = mintOverride({
        projectRoot: cwd, runId: 'R', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'R' },
      });
      assert.equal(minted.ok, true);
      assert.equal(writeRunSettlement(cwd, 'R', { status: 'verified' })?.status, 'validating');

      // The forgery, verbatim: one `rm` of a file outside the project tree that
      // no gate has an opinion about.
      fs.rmSync(overrideLedgerPath(cwd));

      const settlement = writeRunSettlement(cwd, 'R', { status: 'verified' });
      assert.equal(settlement?.status, 'validating');
      assert.equal(settlement?.reason, 'override-snapshot-orphaned');
      assert.ok(settlement?.incompleteChecks.includes('override-snapshot-orphaned'));
      assert.ok(settlement?.incompleteChecks.includes('override-mint-count-mismatch'));
      const ledger = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), 'utf8'));
      assert.notEqual(ledger.outcome, 'shipped');
      assert.equal(ledger.canonicalStatus, 'validating');

      // Project-scoped, unlike the abuse guard: a deleted line took its runId
      // with it, so no other run in this project can be certified either.
      fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'S'), { recursive: true });
      writeStrictVerificationEvidence(cwd, 'S');
      assert.equal(writeRunSettlement(cwd, 'S', { status: 'verified' })?.status, 'validating');
    });
  });
});

test('an illegible override ledger refuses certification while an absent one stays eligible', () => {
  // ENOENT is the case that must NOT regress: no override was ever minted here,
  // which is what almost every install looks like forever.
  withMachineDir(() => {
    withProject((cwd) => {
      writeStrictVerificationEvidence(cwd);
      assert.equal(fs.existsSync(overrideLedgerPath(cwd)), false);
      assert.equal(writeRunSettlement(cwd, 'R', { status: 'verified' })?.status, 'verified');
    });
  });

  for (const [label, corrupt] of [
    ['corrupt', (file: string) => fs.writeFileSync(file, 'not json at all\n', 'utf8')],
    ['oversized', (file: string) => fs.writeFileSync(file, `${'x'.repeat(600 * 1024)}\n`, 'utf8')],
    ['unreadable', (file: string) => {
      fs.writeFileSync(file, '{}\n', 'utf8');
      fs.chmodSync(file, 0o000);
      assert.equal(readJsonResult(file).kind, 'unreadable',
        'fixture guard: a root uid reads straight through the mode bits and would measure nothing');
    }],
  ] as const) {
    withMachineDir(() => {
      withProject((cwd) => {
        writeStrictVerificationEvidence(cwd);
        const file = overrideLedgerPath(cwd);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        corrupt(file);
        const settlement = writeRunSettlement(cwd, 'R', { status: 'verified' });
        assert.equal(settlement?.status, 'validating', label);
        assert.equal(settlement?.reason, 'override-ledger-illegible', label);
        assert.ok(settlement?.incompleteChecks.includes('override-ledger-illegible'), label);
      });
    });
  }
});

test('a mint counter ahead of the ledger, or unsigned, refuses certification', () => {
  withMachineDir(() => {
    withProject((cwd) => {
      writeStrictVerificationEvidence(cwd);
      assert.equal(mintOverride({
        projectRoot: cwd, runId: 'R', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'R' },
      }).ok, true);

      // The whole bucket removed — snapshots included — so the counter in the
      // machine-owned one.json is the only witness left.
      fs.rmSync(path.dirname(overrideLedgerPath(cwd)), { recursive: true });
      const erased = writeRunSettlement(cwd, 'R', { status: 'verified' });
      assert.equal(erased?.status, 'validating');
      assert.equal(erased?.reason, 'override-mint-count-mismatch');
    });
  });

  // A machine dir of its own: one.json holds every project's counter, and the
  // edit below has to land on the entry belonging to THIS fixture.
  withMachineDir(() => {
    withProject((cwd) => {
      writeStrictVerificationEvidence(cwd);
      assert.equal(mintOverride({
        projectRoot: cwd, runId: 'R', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'R' },
      }).ok, true);
      fs.rmSync(path.dirname(overrideLedgerPath(cwd)), { recursive: true });
      // …and stripping the signature off the counter is not a way out either.
      const settingsPath = oneSettingsPath();
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      const section = settings.overrideMints as Record<string, Record<string, unknown>>;
      delete (section[Object.keys(section)[0] as string] as Record<string, unknown>).mac;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

      const settlement = writeRunSettlement(cwd, 'R', { status: 'verified' });
      assert.equal(settlement?.status, 'validating');
      assert.equal(settlement?.reason, 'override-mint-counter-unverifiable');
    });
  });
});

test('a reconciled project certifies again, except for the runs the operator quarantined', () => {
  // The other end of every refusal above: they are permanent and project-wide,
  // and a control with no route out is a wedge. The route is an operator
  // acknowledgement that deletes nothing (shared/override/reconcile.ts), and
  // the price it charges is asserted HERE, at settlement, because that is where
  // it has to be true: the run that existed when the erasure was noticed stays
  // refused, and only a run started afterwards is eligible.
  withMachineDir(() => {
    withProject((cwd) => {
      writeStrictVerificationEvidence(cwd);
      assert.equal(mintOverride({
        projectRoot: cwd, runId: 'R', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'R' },
      }).ok, true);
      fs.rmSync(overrideLedgerPath(cwd));
      assert.equal(writeRunSettlement(cwd, 'R', { status: 'verified' })?.status, 'validating');

      const reconciled = recordOverrideReconciliation({
        projectRoot: cwd,
        fingerprint: overrideReconciliationDraft(cwd).fingerprint,
        quarantinedRuns: ['R'],
      });
      assert.equal(reconciled.ok, true);

      const held = writeRunSettlement(cwd, 'R', { status: 'verified' });
      assert.equal(held?.status, 'validating', 'the quarantined run is still refused, and permanently');
      assert.equal(held?.reason, 'override-reconciliation-quarantined');
      assert.ok(held?.incompleteChecks.includes('override-reconciliation-quarantined'));

      // THE QUARANTINE IS A LIST OF DIRECTORY NAMES, and a copy of the run under
      // a new name is not on it. Measured here rather than argued, because the
      // reading matters: `cp -r runs/R runs/R2` — every artifact, byte for byte,
      // with the run ids inside them re-pointed — does NOT certify. The
      // verification contract's hash covers its own runId and the QA report binds
      // to that hash, so the copy arrives with evidence that does not describe it.
      // What certifies a fresh id is fresh evidence, which is this feature's
      // deliberate boundary (the override taints the run, not the tree) and is
      // available with or without a reconciliation on record.
      const runs = path.join(cwd, '.traffic-one', 'runs');
      fs.cpSync(path.join(runs, 'R'), path.join(runs, 'R2'), { recursive: true });
      for (const file of [verificationContractPath(cwd, 'R2'), qaReportV2Path(cwd, 'R2'),
        path.join(runs, 'R2', 'settlement.json'), path.join(runs, 'R2', 'run.json')]) {
        if (!fs.existsSync(file)) continue;
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('"R"').join('"R2"'), 'utf8');
      }
      // The copy is refused TWICE OVER, and the extra refusal is worth naming:
      // `cp -r` brings the source run's `settlement-v2.json` with it, whose
      // `runId` names the run it came from, so the copy's canonical record
      // exists and is not a record OF THIS RUN. The writer treats that as
      // damage — it preserves the foreign bytes, rebuilds the record, and marks
      // the copy permanently uncertifiable.
      const carried = writeRunSettlement(cwd, 'R2', { status: 'verified' });
      assert.equal(carried?.status, 'validating',
        'a copied run carries a settlement that does not describe it, and cannot certify over it');
      assert.ok(carried?.incompleteChecks.includes(SETTLEMENT_RECORD_ILLEGIBLE_CHECK),
        carried?.incompleteChecks.join(', '));
      assert.equal(fs.existsSync(path.join(runs, 'R2', 'settlement-v2.json.corrupt')), true,
        "and the source run's record is preserved rather than silently replaced");

      // …and the copy is judged on its evidence too, which is the measurement
      // this test exists for: every artifact byte for byte with the run ids
      // re-pointed still does NOT certify, because the verification contract's
      // hash covers its own runId and the QA report binds to that hash. What
      // certifies a fresh id is fresh evidence — this feature's deliberate
      // boundary, available with or without a reconciliation. Measured on a
      // THIRD copy, so the marker above is not the only thing refusing.
      fs.cpSync(path.join(runs, 'R'), path.join(runs, 'R3'), { recursive: true });
      for (const file of [verificationContractPath(cwd, 'R3'), qaReportV2Path(cwd, 'R3'),
        path.join(runs, 'R3', 'settlement.json'), path.join(runs, 'R3', 'run.json')]) {
        if (!fs.existsSync(file)) continue;
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('"R"').join('"R3"'), 'utf8');
      }
      fs.rmSync(path.join(runs, 'R3', 'settlement-v2.json'), { force: true });
      const copied = writeRunSettlement(cwd, 'R3', { status: 'verified' });
      assert.equal(copied?.status, 'validating', 'a renamed copy is not a certified run');
      assert.equal(copied?.incompleteChecks.includes(SETTLEMENT_RECORD_ILLEGIBLE_CHECK), false,
        'and this one is refused on its EVIDENCE, with no damage marker involved');
      assert.ok(copied?.incompleteChecks.some((check) => check.startsWith('verification-contract')
        || check.startsWith('qa-')), copied?.incompleteChecks.join(', '));

      fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'S'), { recursive: true });
      writeStrictVerificationEvidence(cwd, 'S');
      assert.equal(writeRunSettlement(cwd, 'S', { status: 'verified' })?.status, 'verified',
        'work started after the operator looked is certifiable — the project is not dead');
    });
  });
});

test('claim scan truncation is explicit and cannot hide a late active claim', {
  skip: SKIP_10K_TREE_ON_WIN32,
}, () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeStrictVerificationEvidence(cwd);
    for (let index = 0; index < 2_048; index += 1) {
      fs.writeFileSync(path.join(runDir, `${String(index).padStart(4, '0')}-done.json`), JSON.stringify({
        role: 'senior-backend',
        status: 'released',
      }));
    }
    fs.writeFileSync(path.join(runDir, 'zzzz-active.json'), JSON.stringify({
      role: 'senior-backend',
      status: 'active',
    }));

    const scan = activeRunClaimScan(cwd, 'R');
    assert.equal(scan.complete, false);
    assert.equal(scan.scanned, 2_048);
    const settlement = writeRunSettlement(cwd, 'R', { status: 'verified' });
    assert.equal(settlement?.status, 'validating');
    assert.ok(settlement?.incompleteChecks.includes('active-claim-scan-incomplete'));
    assert.ok(settlement?.incompleteChecks.includes('active-claims'));
  });
});

test('V2 rollback guard lets the current runtime continue but irreversibly fails runtime 1.0.19', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), JSON.stringify({
      version: 2,
      runId: 'R',
      status: 'active',
      qaContractVersion: 2,
    }));
    const settlement = writeRunSettlement(cwd, 'R', {
      status: 'active',
      incompleteChecks: ['verification-not-started'],
    });
    assert.ok(settlement);
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'failed');
    assert.equal(ledger.outcome, 'agent-failed');
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.20'), 'active');
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.19'), 'failed');
    // A legacy runtime can ignore the V2 sidecar as ordinary unknown JSON
    // without crashing, while run.json remains a fail-closed projection.
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(runDir, 'settlement-v2.json'), 'utf8')));
  });
});

test('V2 activation barrier is fail-closed before any V2-only sidecar exists', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'R',
      status: 'active',
      kind: 'orchestration',
      createdAt: '2026-07-27T00:00:00.000Z',
    }));

    const barrier = activateRunV2RollbackBarrier(cwd, 'R');
    assert.ok(barrier);
    assert.equal(fs.existsSync(path.join(runDir, 'verification-v2.json')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'settlement-v2.json')), false);

    // This is the exact state left by a crash after activation and before the
    // first V2 sidecar publication.
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'failed');
    assert.equal(ledger.outcome, 'agent-failed');
    assert.equal(ledger.qaContractVersion, 2);
    assert.deepEqual(ledger.runtimeV2RollbackGuard, {
      minimumRuntimeVersion: '1.0.20',
      canonicalStatus: 'active',
    });
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.19'), 'failed');
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.20'), 'active');

    // Exercise the frozen transition semantics copied from the actual 1.0.19
    // release. Its special blocked-resume reason cannot reopen `failed`.
    fs.writeFileSync(path.join(runDir, 'verification-v2.json'), '{"schemaVersion":2}');
    fs.writeFileSync(path.join(runDir, 'settlement-v2.json'), '{"schemaVersion":2}');
    const runtime1019Ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(runtime1019AcceptsTransition({
      ...runtime1019Ledger,
      status: 'blocked',
      outcome: 'environment-blocked',
    }, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
    }), true, 'the old blocked projection was resumable in actual 1.0.19 semantics');
    assert.equal(runtime1019AcceptsTransition(runtime1019Ledger, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
    }), false);
    assert.doesNotThrow(() => runtime1019AcceptsTransition(runtime1019Ledger, {
      status: 'failed',
      outcome: 'agent-failed',
    }), '1.0.19 ignores the sibling V2 sidecars and reads only run.json');
  });
});

test('V2 activation barrier never reopens a terminal legacy run', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'R',
      status: 'failed',
      outcome: 'agent-failed',
    }));
    assert.equal(activateRunV2RollbackBarrier(cwd, 'R'), null);
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'failed');
    assert.equal(ledger.qaContractVersion, undefined);
  });
});

test('reconciliation is idempotent and never manufactures success from fallback-pending', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'failed',
      overallOutcome: 'fallback-pending',
      fallbackAllowed: true,
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-pending');
    assert.equal(second?.revision, first?.revision);
    assert.equal(readRunSettlement(cwd, 'R')?.fallback?.state, 'pending');
  });
});

test('a bare fallback-paid marker cannot manufacture runtime fallback completion', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'fallback-paid',
      overallOutcome: 'success',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
    }));
    const missingQa = reconcileRunSettlement(cwd, 'R');
    assert.equal(missingQa?.status, 'active');
    assert.equal(missingQa?.reason, 'fallback-marker-missing');
    assert.equal(missingQa?.fallback?.state, 'pending');
    assert.deepEqual(missingQa?.incompleteChecks, ['fallback-marker-missing']);

    writeStrictVerificationEvidence(cwd);
    const reconciled = reconcileRunSettlement(cwd, 'R');
    assert.equal(reconciled?.status, 'active');
    assert.equal(reconciled?.fallback?.state, 'pending');
  });
});

test('matching fallback hashes without a fallback-paid marker stay nonterminal and reconciliation is idempotent', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'success',
      overallOutcome: 'success',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-marker-missing');
    assert.equal(first?.fallback?.state, 'pending');
    assert.deepEqual(first?.incompleteChecks, ['fallback-marker-missing']);
    assert.equal(second?.revision, first?.revision);
  });
});

test('maintenance success, completed, and skipped never promote verified without strict evidence', () => {
  for (const outcome of ['success', 'completed', 'skipped']) {
    withProject((cwd) => {
      const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
      fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
        version: 1,
        role: 'quick-fix',
        outcome,
        overallOutcome: outcome,
      }));
      const missing = reconcileRunSettlement(cwd, 'R');
      assert.equal(missing?.status, 'validating', outcome);
      assert.equal(missing?.reason, 'verification-evidence-incomplete', outcome);
      writeStrictVerificationEvidence(cwd);
      assert.equal(reconcileRunSettlement(cwd, 'R')?.status, 'verified', outcome);
    });
  }
});

test('maintenance failed and blocked outcomes remain terminal without success evidence', () => {
  for (const outcome of ['failed', 'blocked']) {
    withProject((cwd) => {
      const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
      fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
        version: 1,
        role: 'quick-fix',
        outcome,
        overallOutcome: outcome,
      }));
      assert.equal(reconcileRunSettlement(cwd, 'R')?.status, outcome);
    });
  }
});

test('terminal settlements are monotonic against stale direct writes and reconciliation projections', () => {
  for (const terminal of ['verified', 'failed', 'blocked'] as const) {
    withProject((cwd) => {
      if (terminal === 'verified') writeStrictVerificationEvidence(cwd);
      const initial = writeRunSettlement(cwd, 'R', { status: terminal });
      assert.equal(initial?.status, terminal);
      assert.ok(initial);
      const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        version: 2,
        runId: 'R',
        status: 'active',
      }));
      fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
        version: 1,
        role: 'quick-fix',
        outcome: 'failed',
        overallOutcome: 'fallback-pending',
        fallbackAllowed: true,
        workUnitContractHash: 'stale-contract',
        allowlistHash: 'stale-allowlist',
      }));

      const directReplay = writeRunSettlement(cwd, 'R', {
        status: 'active',
        reason: 'stale-projection',
        incompleteChecks: ['fallback-pending'],
      });
      const reconciled = reconcileRunSettlement(cwd, 'R');
      assert.equal(directReplay?.status, terminal);
      assert.equal(reconciled?.status, terminal);
      assert.equal(reconciled?.revision, initial?.revision);
      assert.equal(reconciled?.settlementHash, initial?.settlementHash);
    });
  }
});

test('a paid fallback with a mismatched work-unit contract hash stays nonterminal and reconciliation is idempotent', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'fallback-paid',
      overallOutcome: 'success',
      workUnitContractHash: 'different-contract',
      allowlistHash: 'allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-contract-mismatch');
    assert.equal(first?.fallback?.state, 'pending');
    assert.deepEqual(first?.incompleteChecks, ['fallback-hash-mismatch']);
    assert.equal(second?.revision, first?.revision);
    const attemptedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    const replayedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    assert.equal(attemptedBypass?.status, 'validating');
    assert.equal(attemptedBypass?.fallback?.state, 'pending');
    assert.ok(attemptedBypass?.incompleteChecks.includes('fallback-hash-mismatch'));
    assert.equal(replayedBypass?.revision, attemptedBypass?.revision);
  });
});

test('a paid fallback with a mismatched allowlist hash stays nonterminal and reconciliation is idempotent', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'fallback-paid',
      overallOutcome: 'success',
      workUnitContractHash: 'contract',
      allowlistHash: 'different-allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-contract-mismatch');
    assert.equal(first?.fallback?.state, 'pending');
    assert.deepEqual(first?.incompleteChecks, ['fallback-hash-mismatch']);
    assert.equal(second?.revision, first?.revision);
    const attemptedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    const replayedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    assert.equal(attemptedBypass?.status, 'validating');
    assert.equal(attemptedBypass?.fallback?.state, 'pending');
    assert.ok(attemptedBypass?.incompleteChecks.includes('fallback-hash-mismatch'));
    assert.equal(replayedBypass?.revision, attemptedBypass?.revision);
  });
});

test('a terminal legacy ledger cannot bypass strict reviewer, tester, QA, and VerificationContract evidence', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'R',
      status: 'completed',
      outcome: 'verified',
    }));
    const digests = path.join(cwd, '.traffic-one', 'digests', 'R');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# Reviewer\nverdict: APPROVED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# Tester\nverdict: TESTS_GREEN\n');
    const missing = reconcileRunSettlement(cwd, 'R');
    assert.equal(missing?.status, 'validating');
    assert.ok(missing?.incompleteChecks.includes('verification-contract-missing-or-invalid'));
    assert.ok(missing?.incompleteChecks.includes('qa-verification-incomplete'));
    writeStrictVerificationEvidence(cwd);
    assert.equal(reconcileRunSettlement(cwd, 'R')?.status, 'verified');
  });
});

// `writeLegacyProjection` is the one writer of run.json that bypasses the
// run-ledger state machine, and reconciliation can derive a TERMINAL canonical
// status the ledger never transitioned to. Observed 12co: run.json carried a
// terminal projection while `transitionHistory` still ended at `planned ->
// active` and `statusUpdatedAt` was frozen at that moment — only `updatedAt`
// moved on, an hour later. The lifecycle record must be single-sourced.
test('a projected terminal settlement records its transition and advances statusUpdatedAt', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    const planned = '2026-07-30T00:00:00.000Z';
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 2,
      runId: 'R',
      status: 'active',
      kind: 'orchestration',
      qaContractVersion: 2,
      createdAt: planned,
      statusUpdatedAt: planned,
      transitionHistory: [{ from: 'planned', to: 'active', at: planned }],
    }));
    assert.ok(writeRunSettlement(cwd, 'R', {
      status: 'active',
      incompleteChecks: ['verification-not-started'],
    }));
    const seeded = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(seeded.statusUpdatedAt, planned, 'a non-terminal projection is not a transition');
    assert.equal((seeded.transitionHistory as unknown[]).length, 1);

    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      overallOutcome: 'failed',
    }));
    const settlement = reconcileRunSettlement(cwd, 'R');
    assert.equal(settlement?.status, 'failed');

    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.canonicalStatus, 'failed');
    assert.equal(ledger.statusUpdatedAt, settlement!.updatedAt);
    assert.equal(ledger.finishedAt, settlement!.updatedAt);
    const history = ledger.transitionHistory as Array<Record<string, unknown>>;
    assert.equal(history.length, 2);
    assert.deepEqual(history[1], {
      from: 'active',
      to: 'failed',
      at: settlement!.updatedAt,
      outcome: 'agent-failed',
      reason: 'settlement-projection',
    });

    // Idempotent: a replayed projection of the same terminal settlement must not
    // append a second entry or re-stamp the transition timestamp.
    assert.ok(reconcileRunSettlement(cwd, 'R'));
    const replayed = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal((replayed.transitionHistory as unknown[]).length, 2);
    assert.equal(replayed.statusUpdatedAt, settlement!.updatedAt);
  });
});

// The legacy `status` and `canonicalStatus` may look different on disk — that is
// the rollback barrier, not a contradiction — but reading the projection back
// through `effectiveLegacyRunStatus` must always return the legacy equivalent of
// the canonical status a current runtime is entitled to see.
test('every legacy projection round-trips to its own canonicalStatus', () => {
  const cases: Array<[CanonicalRunStatus, string]> = [
    ['planned', 'planned'],
    ['active', 'active'],
    ['code-delivered', 'active'],
    ['validating', 'active'],
    ['verified', 'completed'],
    ['failed', 'failed'],
    ['blocked', 'blocked'],
  ];
  for (const [canonical, legacy] of cases) {
    const projected = projectRunLedgerForV2Rollback({ runId: 'R' }, canonical);
    assert.equal(projected.canonicalStatus, canonical);
    assert.equal(effectiveLegacyRunStatus(projected), legacy, canonical);
    // Runtime 1.0.19 never reads the guard: everything unfinished must look
    // irreversibly failed to it, and nothing may look completed unless it is.
    const legacyView = effectiveLegacyRunStatus(projected, '1.0.19');
    assert.equal(legacyView === 'completed', canonical === 'verified', canonical);
  }
});

// A claim vetoes settlement only while it represents a LIVE agent. Nothing aged
// one out, so an abandoned run held `activeClaims > 0` forever — and because a
// later `verified` is downgraded back to `validating` while that is true, the
// held claims actively prevented the run from ever certifying. Observed 15cl:
// `validating` with 4 claims hours after the session had ended.
test('activeRunClaimScan ignores claims older than the subagent staleness window', () => {
  withProject((cwd) => {
    const runId = 'R';
    const dir = path.join(cwd, '.traffic-one', 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    const claim = (name: string, ageMs: number): void => {
      const at = new Date(Date.now() - ageMs).toISOString();
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
        claimId: `senior-backend-1-${name}`,
        runId,
        role: 'senior-backend',
        status: 'claimed',
        createdAt: at,
        claimedAt: at,
      }), 'utf8');
    };

    // Negative row, and the one that matters: a working agent must keep vetoing.
    claim('fresh', 60_000);
    assert.equal(activeRunClaimScan(cwd, runId).count, 1, 'a live claim still blocks settlement');

    // An abandoned one stops.
    claim('abandoned', 45 * 60 * 1000);
    assert.equal(
      activeRunClaimScan(cwd, runId).count,
      1,
      'a claim past the staleness window is residue, not an agent',
    );

    // With nothing live left, the veto is gone entirely — which is what lets an
    // abandoned run reach a terminal state instead of poisoning later runs.
    fs.rmSync(path.join(dir, 'fresh.json'));
    assert.equal(activeRunClaimScan(cwd, runId).count, 0);
  });
});
