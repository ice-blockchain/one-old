// src/shared/override/__tests__/innocent-states-table.test.ts
// Can the contradiction check wedge an INNOCENT operator? One table, driven.
//
// `override-acknowledged-counter-contradicted` accuses: it says one file
// disagrees with itself, and it refuses `verified` for every run in the project
// until an operator reconciles again. The argument that no honest operation
// produces the pair it needs — a VERIFIED acknowledgement pinning counter N
// beside an absent or lower counter — is spread across two docblocks
// (integrity.ts's check constant and `counterContradicts`), and an argument
// spread across two docblocks gets re-litigated every round. The rows below end
// it by DRIVING each innocent state through the real reader instead of reasoning
// about it: what the operator did, what the witnesses then read, and which
// checks fire.
//
// The last row is the GUILTY control, and it is what stops the table from being
// satisfiable by a check that never fires at all: the one state the argument
// says is not innocent — this project's counter key deleted from `one.json`
// while its acknowledgement stays — must accuse.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK,
  overrideEvidenceReport,
  overrideReconciliationDraft,
} from '../integrity';
import { overrideKeyPath, overrideLedgerPath, overrideSnapshotDir } from '../paths';
import { recordOverrideReconciliation } from '../reconcile';
import { oneSettingsPath } from '../../one-settings';
import { projectRootHash } from '../../state/local-prefs/prefs-store';

const scratch: string[] = [];
test.after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

interface Fixture { readonly env: NodeJS.ProcessEnv; readonly projectRoot: string; readonly settings: string }

/** A project with a finding, RECONCILED — so a verified acknowledgement pinning
 *  a verified counter is on record. Everything below damages this state in one
 *  of the ways an honest accident does. */
function reconciledProject(name: string): Fixture {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `t1-innocent-${name}-`));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `t1-innocent-p-${name}-`));
  scratch.push(stateRoot, projectRoot);
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: stateRoot };
  delete env.TRAFFIC_ONE_STATE_PATH;

  fs.mkdirSync(overrideSnapshotDir(projectRoot, env), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(overrideSnapshotDir(projectRoot, env), 'planted-id.json'), '{"any":"thing"}');
  const draft = overrideReconciliationDraft(projectRoot, env);
  const recorded = recordOverrideReconciliation({
    projectRoot, fingerprint: draft.fingerprint, quarantinedRuns: [], env,
  });
  assert.equal(recorded.ok, true, `[${name}] the fixture must actually reach a reconciled state`);
  const before = overrideEvidenceReport(projectRoot, env);
  assert.equal(before.reconciliations, 1, `[${name}] with one verified acknowledgement on record`);
  assert.equal(before.mintCounter.state, 'verified', `[${name}] pinning a VERIFIED counter`);
  return { env, projectRoot, settings: oneSettingsPath(env) };
}

function writeLedger(fx: Fixture, bytes: string): void {
  const ledger = overrideLedgerPath(fx.projectRoot, fx.env);
  fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledger, bytes);
}

const rows: string[] = [];

function drive(label: string, damage: (fx: Fixture) => void): void {
  const fx = reconciledProject(label.replace(/\W+/g, '-').slice(0, 24));
  damage(fx);
  const report = overrideEvidenceReport(fx.projectRoot, fx.env);
  rows.push(`${label} → ledger=${report.ledger} counter=${report.mintCounter.state}`
    + ` acks=${report.reconciliations}/${report.unverifiableReconciliations}`
    + ` checks=[${report.checks.join(' ')}]`);
  assert.equal(report.checks.includes(OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK), false,
    `${label}: an honest accident was accused of contradicting its own acknowledgement. The check needs a `
    + 'VERIFIED acknowledgement pinning counter N beside an absent or LOWER counter, and this state does not '
    + `produce that pair: ${JSON.stringify(report.checks)}`);
}

test('a PARTIAL APPEND at the ledger leaves the counter untouched and accuses nobody', () => {
  drive('half a line appended', (fx) => writeLedger(fx, '{"v":1,"id":"abc","project'));
});

test('a TRUNCATED ledger accuses nobody', () => {
  drive('truncated to nothing', (fx) => writeLedger(fx, ''));
});

test('a ledger left holding a MERGE CONFLICT accuses nobody', () => {
  drive('merge conflict markers', (fx) => writeLedger(fx,
    '<<<<<<< HEAD\n{"v":1,"id":"a"}\n=======\n{"v":1,"id":"b"}\n>>>>>>> other\n'));
});

test('a ledger of VALID JSON IN THE WRONG SHAPE accuses nobody', () => {
  drive('valid JSON, wrong shape', (fx) => writeLedger(fx, '[1,2,3]\n'));
});

test('an UNPARSEABLE one.json reads as no acknowledgements at all, so there is nothing to contradict', () => {
  drive('one byte appended to one.json', (fx) => {
    fs.appendFileSync(fx.settings, '}');
  });
});

test('a ROTATED install key makes the acknowledgement unverifiable — forgiving nothing, accusing nobody', () => {
  drive('install key rotated', (fx) => {
    fs.writeFileSync(overrideKeyPath(fx.env), 'f'.repeat(64), { mode: 0o600 });
  });
});

test('an ABSENT install key lands in the same place', () => {
  drive('install key deleted', (fx) => {
    fs.rmSync(overrideKeyPath(fx.env), { force: true });
  });
});

test('THE GUILTY CONTROL: the counter key deleted beside a surviving acknowledgement DOES accuse', (t) => {
  // Without this row every assertion above is satisfiable by a check that never
  // fires. This is the state the check was measured into existence for: `rm -rf`
  // the bucket plus one key deleted from `one.json`, which used to certify CLEAN.
  const fx = reconciledProject('guilty');
  const raw = JSON.parse(fs.readFileSync(fx.settings, 'utf8')) as Record<string, unknown>;
  const mints = raw.overrideMints as Record<string, unknown>;
  const key = projectRootHash(fx.projectRoot);
  assert.ok(Object.prototype.hasOwnProperty.call(mints, key), 'fixture guard: the counter entry must be there to delete');
  delete mints[key];
  fs.writeFileSync(fx.settings, `${JSON.stringify(raw, null, 2)}\n`);

  const report = overrideEvidenceReport(fx.projectRoot, fx.env);
  rows.push(`GUILTY: counter key deleted → counter=${report.mintCounter.state}`
    + ` acks=${report.reconciliations}/${report.unverifiableReconciliations} checks=[${report.checks.join(' ')}]`);
  assert.equal(report.checks.includes(OVERRIDE_ACKNOWLEDGED_COUNTER_CONTRADICTED_CHECK), true,
    `the one state the argument calls guilty must accuse: ${JSON.stringify(report.checks)}`);
  for (const row of rows) t.diagnostic(row);
});
