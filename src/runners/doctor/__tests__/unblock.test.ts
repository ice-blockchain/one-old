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
import { probeOverrides } from '../override-probe';
import { buildFindings } from '../findings';
import { buildOverrideSnapshot, runUnblock, type UnblockOutcome } from '../unblock';
import { isFailClosedRecoveryExemption } from '../../../hooks/fail-closed';
import { appendDecision } from '../../../shared/state/decision-log';
import { doctorScriptPath } from '../../../shared/doctor-command';
import { isTrafficOneDoctorCommand } from '../../../shared/tool-classify';
import { overrideLedgerPath, runUsedOperatorOverride } from '../../../shared/override';
import { recordPluginUseChoice, resetPluginUseCache } from '../../../shared/state/plugin-use';
import { writeRunSettlement } from '../../../shared/run-settlement';
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

const accept = async (): Promise<boolean> => true;
const decline = async (): Promise<boolean> => false;

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

test('the confirmation states the run, the gate, the window and the permanent cost', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    let shown = '';
    let nonce = '';
    await runUnblock(request(projectRoot, { ttl: '45m' }), async (summary, code) => {
      shown = summary;
      nonce = code;
      return false;
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

test('doctor reports a live override, and an unverifiable ledger line, instead of ignoring it silently', async () => {
  await withProject(async ({ projectRoot }) => {
    recordDeny(projectRoot, 'run-1', 'plan-guard', 'scaffold-plan-gate');
    await runUnblock(request(projectRoot), accept);
    fs.appendFileSync(overrideLedgerPath(projectRoot), 'garbage\n', 'utf8');

    const probe = probeOverrides(projectRoot, 'run-1');
    assert.equal(probe.active.length, 1);
    assert.equal(probe.unvouchable, 1);
    assert.equal(probe.runMinted, 1);

    const codes = buildFindings({
      node: nodeProbe(), nvm: nvmProbe(), gitnexus: gitnexusProbe(), project: projectProbe(projectRoot),
      overrides: probe,
    }).map((finding) => finding.code);
    assert.ok(codes.includes('OPERATOR_OVERRIDE_ACTIVE'), codes.join(', '));
    assert.ok(codes.includes('OVERRIDE_LEDGER_UNVERIFIED'), codes.join(', '));
  });
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
  return { runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node', requiredMajor: 22 };
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
