// `doctor --unblock`: the only write doctor can perform, and the three
// independent defenses that stand between an agent and a self-issued override.
//
// The confirmation itself is deliberately NOT reachable from here: runUnblock
// takes the confirm callback as a parameter and the shipped one
// (confirmAtTerminal) refuses a non-TTY, so there is no env var or flag a test
// could set that a prompt-injected agent could not set too. What these tests
// pin is everything AROUND it — the refusals that must happen before a prompt
// is even printed, and that a decline writes nothing.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs } from '../lib';
import { OVERRIDE_RECONCILE_FLAG, probeOverrides } from '../override-probe';
import { buildFindings } from '../findings';
import {
  buildOverrideSnapshot,
  confirmAtTerminal,
  runOverrideReconcile,
  runUnblock,
  wantsOverrideReconcile,
  type OverrideConfirmation,
  type UnblockOutcome,
} from '../unblock';
import { isFailClosedRecoveryExemption } from '../../../hooks/fail-closed';
import { appendDecision } from '../../../shared/state/decision-log';
import { doctorScriptPath } from '../../../shared/doctor-command';
import { isTrafficOneDoctorCommand } from '../../../shared/tool-classify';
import { overrideLedgerPath, runUsedOperatorOverride } from '../../../shared/override';
import { recordPluginUseChoice, resetPluginUseCache } from '../../../shared/state/plugin-use';
import {
  RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
  RUN_SETTLEMENT_SCHEMA_VERSION,
  readRunSettlement,
  runSettlementPath,
  writeRunSettlement,
  type CanonicalRunStatus,
} from '../../../shared/run-settlement';
// The barrel does not re-export the hash, and the plant below needs the real
// one: `readRunSettlement` rejects a record whose hash does not match, so a
// hand-written settlement that skipped this would read as ABSENT and every
// assertion about it would pass for the wrong reason.
import { settlementHash } from '../../../shared/run-settlement/types';
import type { NodeProbe, NvmProbe, GitnexusProbe, ProjectProbe } from '../probes';

const TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TEMP_DIRS.push(dir);
  return dir;
}

interface Fixture {
  readonly projectRoot: string;
}

async function withProject(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const saved = process.env.XDG_STATE_HOME;
  const base = tempDir('t1-unblock-');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(path.join(projectRoot, '.traffic-one', 'runs', 'run-1'), { recursive: true });
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  resetPluginUseCache();
  recordPluginUseChoice(projectRoot, true, 'test');
  try {
    await body({ projectRoot });
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    resetPluginUseCache();
  }
}

/** A recorded refusal by `gateId`, so the mint's typo check has evidence to find. */
function recordDeny(projectRoot: string, runId: string, gateId: string, denyId: string): void {
  appendDecision(projectRoot, {
    ts: new Date().toISOString(),
    correlationId: `${runId}:1:1`,
    runId,
    hookSeq: 1,
    pid: 1,
    event: 'PreToolUse',
    host: 'claude',
    decision: 'deny',
    gateId,
    denyId,
    inputs: {},
    stateWrites: [],
  });
}

const accept = async (): Promise<OverrideConfirmation> => 'confirmed';
const decline = async (): Promise<OverrideConfirmation> => 'declined';
const noTerminal = async (): Promise<OverrideConfirmation> => 'not-interactive';

function request(projectRoot: string, over: Record<string, unknown> = {}) {
  return { projectRoot, gateId: 'plan-guard', runId: 'run-1', ttl: null, ...over } as Parameters<typeof runUnblock>[0];
}

// ── the refusals that happen before anything is written ──────────────────────

test('every pre-mint refusal leaves the ledger untouched', async () => {
  const cases: { label: string; over: Record<string, unknown>; refusal: UnblockOutcome['refusal'] }[] = [
    { label: 'a gate id the argv grammar could not carry', over: { gateId: 'plan guard' }, refusal: 'gate-id-shape' },
    { label: 'an empty gate id', over: { gateId: '' }, refusal: 'gate-id-shape' },
    { label: 'no run to scope the abuse guard to', over: { runId: null }, refusal: 'no-run' },
    { label: 'an unbounded ttl', over: { ttl: '30' }, refusal: 'bad-ttl' },
    { label: 'a ttl past the ceiling', over: { ttl: '48h' }, refusal: 'bad-ttl' },
  ];
  for (const { label, over, refusal } of cases) {
    await withProject(async ({ projectRoot }) => {
      recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
      const outcome = await runUnblock(request(projectRoot, over), accept);
      assert.equal(outcome.ok, false, label);
      assert.equal(outcome.refusal, refusal, label);
      assert.equal(fs.existsSync(overrideLedgerPath(projectRoot)), false, `${label}: nothing was written`);
    });
  }
});

test('a gate that never refused anything in this run is a typo, not an override', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    const outcome = await runUnblock(request(projectRoot, { gateId: 'plan-gaurd' }), accept);
    assert.equal(outcome.refusal, 'gate-never-denied');
    // …and it says which gates DID, because the operator is here precisely
    // because something refused them.
    assert.match(outcome.message, /plan-guard/);
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false);
  });
});

test('a gate whose only refusals are never-overridable is refused at mint, not handed a dud token', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'authoring-guard', 'authoring-guard');
    const outcome = await runUnblock(request(projectRoot, { gateId: 'authoring-guard' }), accept);
    assert.equal(outcome.refusal, 'gate-not-overridable');
    assert.match(outcome.message, /never-overridable/);
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false);
  });
});

test('declining the confirmation mints nothing at all', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    const outcome = await runUnblock(request(projectRoot), decline);
    assert.equal(outcome.refusal, 'declined');
    assert.equal(fs.existsSync(overrideLedgerPath(projectRoot)), false);
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false);
  });
});

// Two outcomes that used to be one string. `confirmAtTerminal` answered `false`
// for a non-TTY and `false` for a cancelled prompt, so both emitted
// `{"refusal":"declined"}` and the `'not-interactive'` code was returned by
// nothing. An operator reading a transcript needs to tell "a human said no"
// from "there was no human", because only the second says something ran this
// that should not have.
test('a scripted invocation and a human cancel are different refusals', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');

    const scripted = await runUnblock(request(projectRoot), noTerminal);
    assert.equal(scripted.ok, false);
    assert.equal(scripted.refusal, 'not-interactive');

    const cancelled = await runUnblock(request(projectRoot), decline);
    assert.equal(cancelled.refusal, 'declined');
    assert.notEqual(scripted.refusal, cancelled.refusal, 'and the JSON an operator parses says which');
    assert.equal(fs.existsSync(overrideLedgerPath(projectRoot)), false, 'neither wrote anything');
  });
});

// The shipped confirmation is what has to PRODUCE that distinction; a
// `runUnblock` that can carry it while `confirmAtTerminal` still collapses both
// into "declined" would be a distinction on paper only. The test process's
// stdio is not a TTY, which is exactly the condition being characterized.
test('the shipped confirmation reports a non-terminal as such, not as a cancel', async () => {
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(await confirmAtTerminal('summary', 'abc123'), 'not-interactive');
  } finally {
    process.stderr.write = write;
  }
  const printed = stderr.join('');
  assert.match(printed, /interactive terminal/);
  // …and it no longer claims the TTY check is what stops an agent minting its
  // own override, which a pty makes false. What it may claim is the part that
  // survives a pty: the mint is on the record and the record is checked.
  assert.equal(/what stops an agent/.test(printed), false);
  assert.match(printed, /never settle verified or shipped/);
});

test('the confirmation states the run, the gate, the window and the permanent cost', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    let shown = '';
    let nonce = '';
    await runUnblock(request(projectRoot, { ttl: '45m' }), async (summary, code) => {
      shown = summary;
      nonce = code;
      return 'declined';
    });
    assert.match(shown, /gate\s+plan-guard/);
    assert.match(shown, /run\s+run-1/);
    assert.match(shown, /45 minute\(s\)/);
    assert.match(shown, /never settle as verified or shipped/);
    // A nonce typed back, not a `y` any wrapper can pipe blind.
    assert.match(nonce, /^[0-9a-f]{6}$/);
  });
});

// ── the mint ─────────────────────────────────────────────────────────────────

test('an accepted mint writes one audit line and a snapshot of what it will let past', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    const outcome = await runUnblock(request(projectRoot), accept);
    assert.equal(outcome.ok, true, outcome.message);
    assert.ok(outcome.tokenId);
    assert.ok(outcome.snapshotPath);
    assert.equal(fs.readFileSync(overrideLedgerPath(projectRoot), 'utf8').trim().split('\n').length, 1);
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), true);

    // The snapshot is the "before" picture, and it has to name the refusals the
    // token is about to let through — otherwise "what did this let past?" is
    // unanswerable the moment the decision log rolls over.
    const snapshot = JSON.parse(fs.readFileSync(outcome.snapshotPath as string, 'utf8')) as Record<string, unknown>;
    assert.equal(snapshot.runId, 'run-1');
    assert.equal(snapshot.gateId, 'plan-guard');
    const recent = snapshot.recentDenies as { gateId: string; denyId: string }[];
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.denyId, 'scaffold-plan-gate');
    assert.ok(snapshot.git, 'the working tree is captured too — it outlives the project state dir');
    assert.ok(Object.prototype.hasOwnProperty.call(snapshot, 'settlement'));
  });
});

test('the snapshot records the run status the override is about to devalue', async () => {
  await withProject(async ({ projectRoot }) => {
    writeRunSettlement(projectRoot, 'run-1', { status: 'validating', reason: 'awaiting-evidence' });
    const snapshot = buildOverrideSnapshot(projectRoot, 'run-1', 'plan-guard') as Record<string, unknown>;
    const settlement = snapshot.settlement as Record<string, unknown> | null;
    assert.equal(settlement?.status, 'validating');
    assert.equal(settlement?.reason, 'awaiting-evidence');
  });
});

// ── the run the mint refuses ─────────────────────────────────────────────────

/**
 * A settlement in exactly one status, planted rather than earned.
 *
 * `verified` cannot be reached through `writeRunSettlement` from a fixture — it
 * requires a full VerificationContractV2 plus a matching QaReportV2 and green
 * digests — and none of that is what this pin is about: `runUnblock` reads the
 * settlement and nothing else, so the condition under test is a settlement that
 * READS `verified`. The hash is the real one, so `readRunSettlement` parses
 * these records exactly as it parses a settlement the runtime wrote.
 */
function plantSettlement(projectRoot: string, runId: string, status: CanonicalRunStatus): void {
  const withoutHash = {
    schemaVersion: RUN_SETTLEMENT_SCHEMA_VERSION,
    runId,
    runtimeVersion: RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
    minimumRuntimeVersion: RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
    status,
    activeClaims: 0,
    incompleteChecks: [] as string[],
    revision: 1,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    runSettlementPath(projectRoot, runId),
    JSON.stringify({ ...withoutHash, settlementHash: settlementHash(withoutHash) }),
    'utf8',
  );
  assert.equal(readRunSettlement(projectRoot, runId)?.status, status,
    'fixture guard: the planted settlement parses, or the case below proves nothing');
}

/**
 * The decision per canonical status, as a total map — `Record<CanonicalRunStatus,
 * …>` so a new status cannot be added to the type without a verdict being written
 * here. The refusal must stay narrow: it exists because nothing in the product
 * replaces a certificate once written, so the abuse guard has nothing left to
 * demote and the run keeps one earned before the gate was relaxed. Nothing else
 * certifies anything — `failed` and `blocked` are terminal too, and are the
 * ordinary wedge an operator needs this command for.
 *
 * Narrow matters more than usual here because the record is FORGEABLE. The
 * fixture below plants a settlement with a recomputed hash and this reader
 * accepts it, which is the whole point: `settlementHash` is unkeyed, so every
 * `refused` row in this map is a state an attacker can put a run into. One
 * status is the price of closing the laundering shape; a second would be a
 * second free lockout.
 */
const MINT_ON_SETTLEMENT: Record<CanonicalRunStatus, 'mints' | 'refused'> = {
  planned: 'mints',
  active: 'mints',
  'code-delivered': 'mints',
  // Where the abuse guard itself parks an overridden run: refusing here would
  // refuse a second override on a run the first one already devalued.
  validating: 'mints',
  failed: 'mints',
  blocked: 'mints',
  verified: 'refused',
};

test('the mint decision is enumerated over every canonical settlement status', async () => {
  for (const [status, expected] of Object.entries(MINT_ON_SETTLEMENT) as [CanonicalRunStatus, string][]) {
    await withProject(async ({ projectRoot }) => {
      recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
      plantSettlement(projectRoot, 'run-1', status);
      const outcome = await runUnblock(request(projectRoot), accept);
      if (expected === 'mints') {
        assert.equal(outcome.ok, true, `${status}: ${outcome.message}`);
        assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), true, status);
        return;
      }
      assert.equal(outcome.ok, false, status);
      assert.equal(outcome.refusal, 'run-already-verified', status);
      assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false, status);
    });
  }
  // The overwhelmingly common case, which no status covers: a run with no
  // settlement on disk at all.
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    assert.equal(readRunSettlement(projectRoot, 'run-1'), null);
    assert.equal((await runUnblock(request(projectRoot), accept)).ok, true);
  });
});

test('the certified-run refusal is named, is reached before the prompt, and says what to do instead', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    plantSettlement(projectRoot, 'run-1', 'verified');
    let asked = false;
    const outcome = await runUnblock(request(projectRoot), async (): Promise<OverrideConfirmation> => {
      asked = true;
      return 'confirmed';
    });
    assert.equal(outcome.refusal, 'run-already-verified');
    assert.equal(asked, false, 'an operator is not asked to confirm something that will be refused anyway');
    // The prose has to carry three halves, and the middle one is the correction
    // of a claim that was false: WHY (nothing replaces a certificate), that the
    // certificate itself is UNSIGNED and may have been planted — with how to
    // check — and WHAT INSTEAD (a run that has not certified). The refusal is
    // reachable by anyone who can write the project tree, so a message that
    // dead-ends at "do the work elsewhere" hides a lockout behind an
    // immutability the product does not have.
    assert.match(outcome.message, /already settled `verified`/);
    assert.doesNotMatch(outcome.message, /immutable/,
      'the settlement hash is an unkeyed digest; claiming immutability here was measured false');
    assert.match(outcome.message, /may have been PLANTED/);
    assert.match(outcome.message, /settlement-v2\.json/, 'and it names the file to look at');
    assert.match(outcome.message, /revision/, 'with something checkable in it');
    assert.match(outcome.message, /What to do instead/);
    assert.match(outcome.message, /--run <that id>/);
    assert.match(outcome.message, /`failed` or `blocked`/, 'and it says which states DO still mint');
    assert.equal(fs.existsSync(overrideLedgerPath(projectRoot)), false, 'nothing was written');
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false);
    // The verdict it refused to relax is untouched.
    assert.equal(readRunSettlement(projectRoot, 'run-1')?.status, 'verified');
  });
});

// ── doctor's own surfaces ────────────────────────────────────────────────────

test('doctor parses the flags it now ships, and ignores --ttl without --unblock', () => {
  assert.deepEqual(parseArgs(['--unblock', 'plan-guard', '--run', 'run-7', '--ttl', '2h']), {
    session: null, run: 'run-7', bundle: false, unblock: 'plan-guard', ttl: '2h',
  });
  assert.deepEqual(parseArgs([]), { session: null, run: null, bundle: false, unblock: null, ttl: null });
  // A flag with no value is not a flag: `--unblock` alone must not become a
  // mint with an empty gate id.
  assert.equal(parseArgs(['--unblock']).unblock, null);
});

test('doctor reports a live override, and a junk ledger line, instead of ignoring it silently', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    await runUnblock(request(projectRoot), accept);
    fs.appendFileSync(overrideLedgerPath(projectRoot), 'garbage\n', 'utf8');

    const probe = probeOverrides(projectRoot, 'run-1');
    assert.equal(probe.active.length, 1);
    assert.equal(probe.unvouchable, 1);
    assert.equal(probe.runMinted, 1);
    // The two spellings kept apart, because they accuse different things: a line
    // that does not parse means somebody wrote into the file, a line that parses
    // and fails its MAC means the key does not match. Reporting the first as the
    // second told operators their per-install key had been rotated.
    assert.deepEqual([probe.malformedLines, probe.forgedLines], [1, 0]);

    const findings = buildFindings({
      node: nodeProbe(), nvm: nvmProbe(), gitnexus: gitnexusProbe(), project: projectProbe(projectRoot),
      overrides: probe,
    });
    const codes = findings.map((finding) => finding.code);
    assert.ok(codes.includes('OPERATOR_OVERRIDE_ACTIVE'), codes.join(', '));
    const illegible = findings.find((finding) => finding.code === 'OVERRIDE_LEDGER_ILLEGIBLE');
    assert.ok(illegible, codes.join(', '));
    assert.equal(illegible.severity, 'fix-needed');
    assert.ok(!codes.includes('OVERRIDE_LEDGER_UNVERIFIED'),
      'a junk line is not a key mismatch and must not be reported as one');
  });
});

test('every illegible spelling is named by the doctor, including the two that were silent', async () => {
  // THE DEFECT: `oversized` parsed no lines at all, so every count the report
  // consumed was the clean install and the only trace was an info line about the
  // acknowledgement — the most complete blindfold this feature can be handed was
  // its quietest state. `corrupt` did warn, but as "cannot be verified against
  // this install's key", and neither printed the counter deficit because that
  // description only ran inside the discrepancies branch, which an excused
  // project does not enter.
  await withProject(async ({ projectRoot }) => {
    fs.mkdirSync(path.dirname(overrideLedgerPath(projectRoot)), { recursive: true });
    for (const kind of ['corrupt', 'oversized', 'unreadable'] as const) {
      fs.rmSync(overrideLedgerPath(projectRoot), { force: true, recursive: true });
      if (kind === 'corrupt') fs.writeFileSync(overrideLedgerPath(projectRoot), 'junk\n', 'utf8');
      if (kind === 'oversized') {
        // token.ts MAX_LEDGER_BYTES, +1. Deliberately not exported: the reader's
        // bound is not a contract, and this test only needs to be over it.
        fs.writeFileSync(overrideLedgerPath(projectRoot), 'x'.repeat(512 * 1024 + 1), 'utf8');
      }
      if (kind === 'unreadable') fs.mkdirSync(overrideLedgerPath(projectRoot), { recursive: true });

      const probe = probeOverrides(projectRoot, 'run-1');
      assert.equal(probe.ledger, kind);
      assert.equal(probe.snapshotScanAsked, false,
        'the orphan witness is off in this state — which is exactly why it has to be said out loud');
      const finding = buildFindings({
        node: nodeProbe(), nvm: nvmProbe(), gitnexus: gitnexusProbe(), project: projectProbe(projectRoot),
        overrides: probe,
      }).find((entry) => entry.code === 'OVERRIDE_LEDGER_ILLEGIBLE');
      assert.ok(finding, `${kind} produced no finding at all`);
      assert.equal(finding.severity, 'fix-needed', `${kind} was reported as an aside`);
      assert.match(finding.message, new RegExp(`\`${kind}\``));
      assert.match(finding.message, /NOT SCANNED/, `${kind} did not say the orphan witness is off`);
    }
    fs.rmSync(overrideLedgerPath(projectRoot), { force: true, recursive: true });
  });
});

test('after the evidence is erased the doctor says so, in the report and in the JSON', async () => {
  // THE DEFECT, and it is the plan item itself: settlement refused the project
  // while the doctor printed the clean install. Every completeness field the
  // probe collected was dropped on the floor — `buildFindings` read three
  // fields, all of them zero after a delete, and the stdout JSON had no
  // `overrides` key at all — so the operator's report said HEALTHY at exactly
  // the moment nothing in the project could be certified. A refusal nobody can
  // see is not a control.
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    await runUnblock(request(projectRoot), accept);
    fs.rmSync(overrideLedgerPath(projectRoot));

    const probe = probeOverrides(projectRoot, 'run-1');
    assert.deepEqual([probe.active.length, probe.unvouchable, probe.runMinted], [0, 0, 0],
      'the three fields the report used to consume are exactly the clean install');
    assert.deepEqual(probe.discrepancies, ['override-snapshot-orphaned', 'override-mint-count-mismatch'],
      'and the fields it did not consume are where the erasure actually shows');

    const findings = buildFindings({
      node: nodeProbe(), nvm: nvmProbe(), gitnexus: gitnexusProbe(), project: projectProbe(projectRoot),
      overrides: probe,
    });
    const incomplete = findings.find((finding) => finding.code === 'OVERRIDE_EVIDENCE_INCOMPLETE');
    assert.ok(incomplete, findings.map((finding) => finding.code).join(', '));
    assert.equal(incomplete.severity, 'fix-needed', 'and it counts against the summary, not as an aside');
    for (const fragment of ['override-snapshot-orphaned', 'override-mint-count-mismatch', 'orphaned snapshots 1']) {
      assert.match(incomplete.message, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(incomplete.recommendedCommand ?? '', /--reconcile-overrides$/,
      'a refusal with no route out is a wedge: the report names the repair');
  });
});

test('the repair is refused a scripted caller and is not in the exemption grammar', async () => {
  // Same posture as the mint, for the same reason: it writes. An agent that
  // could reach it would have the acknowledgement half of the erasure it is
  // being stopped from performing.
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    await runUnblock(request(projectRoot), accept);
    fs.rmSync(overrideLedgerPath(projectRoot));

    assert.equal((await runOverrideReconcile({ projectRoot }, noTerminal)).refusal, 'not-interactive');
    assert.equal((await runOverrideReconcile({ projectRoot }, decline)).refusal, 'declined');
    assert.equal(probeOverrides(projectRoot, 'run-1').reconciliations, 0);
  });

  const script = doctorScriptPath();
  for (const command of [
    `node ${script} ${OVERRIDE_RECONCILE_FLAG}`,
    `node ${script} --run run-1 ${OVERRIDE_RECONCILE_FLAG}`,
  ]) {
    assert.equal(isTrafficOneDoctorCommand('Bash', { command }), false, command);
    assert.equal(isFailClosedRecoveryExemption(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      'check-plan-write',
      'nested',
    ), false, command);
  }
  assert.equal(wantsOverrideReconcile([OVERRIDE_RECONCILE_FLAG]), true);
  assert.equal(wantsOverrideReconcile(['--run', 'run-1']), false);
  assert.equal(parseArgs([OVERRIDE_RECONCILE_FLAG]).unblock, null, 'and it is not confusable with a mint');
});

// ── the argv grammar and the recovery allowlist ──────────────────────────────

test('the gate-exemption grammar still rejects every --unblock spelling', () => {
  const script = doctorScriptPath();
  for (const command of [
    `node ${script} --unblock plan-guard`,
    `node ${script} --unblock plan-guard --run run-1`,
    `node ${script} --unblock plan-guard --ttl 30m`,
    `node ${script} --run run-1 --unblock plan-guard`,
    `node ${script} --bundle --unblock plan-guard`,
  ]) {
    assert.equal(isTrafficOneDoctorCommand('Bash', { command }), false, command);
    // …and therefore no host surface's fail-closed boundary lets it through
    // either: the boundary defers to that one grammar.
    assert.equal(isFailClosedRecoveryExemption(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      'check-plan-write',
      'nested',
    ), false, command);
  }
  // The read-only forms are unaffected — this must not have been achieved by
  // breaking the exemption.
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${script}` }), true);
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${script} --run run-1 --bundle` }), true);
});

// The plan's anti-requirement, stated as the assertion it actually implies: the
// recovery allowlist must NOT grow a mutating runner. `run-status --status
// failed` is the specific one people reach for, and it is the fastest way to
// wedge a project — an agent that can declare its own run failed does not need
// any other bypass.
test('a mutating runner is not on the recovery allowlist, however it is spelled', () => {
  const root = path.dirname(path.dirname(doctorScriptPath()));
  for (const command of [
    `node ${path.join(root, 'scripts', 'run-status.cjs')} --status failed`,
    `node ${path.join(root, 'scripts', 'run-status.cjs')}`,
    `node ${path.join(root, 'scripts', 'materialize.cjs')}`,
    `node ${doctorScriptPath()} && rm -rf /`,
  ]) {
    assert.equal(isFailClosedRecoveryExemption(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      'check-plan-write',
      'nested',
    ), false, command);
  }
});

// ── probe fixtures ───────────────────────────────────────────────────────────

function nodeProbe(): NodeProbe {
  return { runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node', requiredMajor: 22, pluginRequiredMajor: 22 };
}

function nvmProbe(): NvmProbe {
  return { installed: false };
}

function gitnexusProbe(): GitnexusProbe {
  return { onPath: null, absoluteV22: null, crashRiskInOldNvm: false };
}

function projectProbe(cwd: string): ProjectProbe {
  return {
    cwd,
    hasState: false,
    state: null,
    localPreferences: {},
    localPreferencesPath: null,
    hasLocalPreferences: false,
    normalizedState: null,
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
    runState: {
      currentRunId: null, runDirExists: false, runJsonExists: false, runJsonStatus: null,
      hasOrchestratedArtifacts: false, maintenanceJsonExists: false, maintenanceOutcome: null,
      maintenanceOverallOutcome: null, maintenanceOpencodeOutcome: null, maintenanceFallbackAllowed: false,
      maintenanceTerminalOrFallbackPending: false,
    },
    nestedTrafficOneRoots: [],
    openCodeCli: 'managed',
    legacyCapabilityMigration: { status: 'not-applicable', message: null },
  } as unknown as ProjectProbe;
}
