// src/runners/doctor/__tests__/run-diagnostic.test.ts
// `doctor --run <id>`: the probe, the operator report it renders, and the
// machine-readable findings it feeds. Driven against a REAL wedged run on disk
// (see wedged-run-fixture.ts) rather than crafted probe objects, because the
// bug this diagnostic exists to explain is a disagreement between four state
// files — a hand-built probe object cannot reproduce that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PENDING_AGENT_CLAIM_STALE_MS, SUBAGENT_STALE_MS } from '../../../config/state';
import { buildFindings } from '../findings';
import { resolveDoctorRunId } from '../index';
import type { DoctorArgs } from '../lib';
import { probeRunDiagnostic, type RunDiagnosticProbe } from '../run-diagnostic';
import { formatRunDiagnosticReport } from '../run-diagnostic-report';
import { pendingDir, runLedgerFile } from '../../../shared/state/run-agent/run-paths';
import { isTrafficOneDoctorCommand } from '../../../shared/tool-classify';
import type { GitnexusProbe, NodeProbe, NvmProbe, ProjectProbe } from '../probes';
import { buildWedgedRunFixture, FIXTURE_SECOND_DENY_ID, FIXTURE_TOP_DENY_ID } from './wedged-run-fixture';

function withFixture<T>(fn: (cwd: string, runId: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-doctor-wedged-'));
  const savedPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  try {
    const fixture = buildWedgedRunFixture(dir);
    return fn(fixture.cwd, fixture.runId);
  } finally {
    if (savedPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('probeRunDiagnostic reads the whole wedge: live vs stale agents, held claims, ledger, denies', () => {
  withFixture((cwd, runId) => {
    const probe = probeRunDiagnostic(cwd, runId);
    assert.equal(probe.runId, runId);
    assert.equal(probe.runDirExists, true);

    const byRole = new Map(probe.liveAgents.map((agent) => [agent.role, agent]));
    assert.deepEqual([...byRole.keys()].sort(), ['senior-architect', 'senior-frontend']);
    const frontend = byRole.get('senior-frontend');
    assert.equal(frontend?.stale, false);
    assert.equal(frontend?.windowMs, SUBAGENT_STALE_MS);
    assert.equal(frontend?.parentSessionId, 'parent-session-01');
    const architect = byRole.get('senior-architect');
    assert.equal(architect?.stale, true, 'a row 40 minutes into a 30-minute window is stale');
    assert.ok((architect?.ageMs ?? 0) > SUBAGENT_STALE_MS);

    const claims = new Map(probe.claims.map((claim) => [claim.role, claim]));
    assert.equal(claims.get('senior-backend')?.state, 'pending');
    assert.equal(claims.get('senior-backend')?.stale, true, 'a pending claim past 5 minutes is expired');
    assert.equal(claims.get('senior-backend')?.windowMs, PENDING_AGENT_CLAIM_STALE_MS);
    assert.equal(claims.get('senior-frontend')?.state, 'claimed');
    assert.equal(claims.get('senior-frontend')?.stale, false);

    assert.equal(probe.ledger.exists, true);
    assert.equal(probe.ledger.effectiveStatus, 'active');
    assert.equal(probe.ledger.rollbackBarrierNote, null, 'no V2 barrier in this fixture');

    assert.equal(probe.decisionCount, 7);
    assert.equal(probe.denyCount, 6);
    assert.deepEqual(probe.topDenies.map((deny) => [deny.denyId, deny.count, deny.recognized]), [
      [FIXTURE_TOP_DENY_ID, 4, true],
      [FIXTURE_SECOND_DENY_ID, 2, true],
    ]);
    assert.deepEqual(probe.topDenies[0]?.gateIds, ['plan-guard']);
    assert.equal(probe.topDenies[0]?.lastSeenAt, '2026-08-04T09:03:00.000Z', 'newest occurrence, not the first');
    assert.equal(probe.decisionLogPath, path.join(cwd, '.traffic-one', 'runs', runId, 'debug', 'decisions.jsonl'));
  });
});

test('probeRunDiagnostic never prunes the expired pending claim it reports', () => {
  withFixture((cwd, runId) => {
    const before = fs.readdirSync(pendingDir(cwd, runId));
    const ledgerBefore = fs.readFileSync(runLedgerFile(cwd, runId), 'utf8');
    probeRunDiagnostic(cwd, runId);
    probeRunDiagnostic(cwd, runId);
    // listPendingClaims() deletes expired claims as a side effect of listing
    // them; a read-only diagnostic must not, or diagnosing a wedge destroys the
    // evidence of it.
    assert.deepEqual(fs.readdirSync(pendingDir(cwd, runId)), before);
    assert.equal(fs.readFileSync(runLedgerFile(cwd, runId), 'utf8'), ledgerBefore);
  });
});

test('probeRunDiagnostic reports an unminted run id without inventing state', () => {
  withFixture((cwd) => {
    const probe = probeRunDiagnostic(cwd, '9999999999999');
    assert.equal(probe.runDirExists, false);
    assert.deepEqual(probe.liveAgents, []);
    assert.deepEqual(probe.claims, []);
    assert.equal(probe.ledger.exists, false);
    assert.equal(probe.decisionCount, 0);
    assert.match(formatRunDiagnosticReport(probe), /was never minted/);
  });
});

// ── the operator report ──────────────────────────────────────────────────────

test('the operator report shows each row against its own window and ends with a next step', () => {
  withFixture((cwd, runId) => {
    const report = formatRunDiagnosticReport(probeRunDiagnostic(cwd, runId));
    assert.match(report, /^=== Traffic One doctor: run 1785169657252 ===$/m);
    // "Live agents" was a lie for exactly the rows an operator opens this report
    // to find: the list is the whole registry.
    assert.match(report, /^Registered agents \(2; 1 live, 1 stale\):$/m);
    assert.match(report, /- senior-architect: agent-architect-01 — \d+m(\d+s)? into a 30m window — STALE$/m);
    assert.match(report, /- senior-frontend: .* into a 30m window — live$/m);
    assert.match(report, /^Held claims \(2; 1 stale\):$/m);
    assert.match(report, /- \[pending\] senior-backend .* into a 5m window — STALE$/m);
    assert.match(report, /- \[claimed\] senior-frontend .* into a 30m window — live$/m);
    assert.match(report, /^ {2}effective: status=active/m);
    assert.match(report, /^Decision log: 7 decisions, 6 denies/m);
    assert.match(report, new RegExp(`1\\. ${FIXTURE_TOP_DENY_ID} ×4 via plan-guard \\(last 2026-08-04T09:03:00.000Z\\)$`, 'm'));
    assert.match(report, new RegExp(`2\\. ${FIXTURE_SECOND_DENY_ID} ×2 via plan-guard`));
    assert.equal(report.includes('UNRECOGNIZED'), false, 'the fixture uses real deny ids');
    // The item this closes: naming a cause and stopping there is half a
    // diagnosis, so the report must end with what to DO.
    assert.match(report, /^Next step:$/m);
    assert.match(report, /2 agent\(s\)\/claim\(s\) are past their liveness window/);
    assert.match(report, /Re-prompt the parent agent/);
    assert.match(report, /Do NOT hand-edit run\.json/);
    // The bug-report command must be RUNNABLE, and must satisfy the same
    // grammar the gates enforce — asserted as a PROPERTY, not pinned as a
    // literal, because a literal is exactly how `doctor --run <id> --bundle`
    // survived here: no interpreter, no path, and a bare `doctor` that nothing
    // in this product ever puts on PATH, printed at the moment a run is wedged.
    assert.match(report, new RegExp(`--run ${runId} --bundle`));
    assert.equal(
      isTrafficOneDoctorCommand('Bash', { command: printedBundleCommand(report) }),
      true,
      `the printed bug-report command must satisfy the doctor gate grammar: ${printedBundleCommand(report)}`,
    );
  });
});

const BUG_REPORT_PREFIX = 'Attach machine-readable state to a bug report: ';

function printedBundleCommand(report: string): string {
  const line = report.split('\n').find((entry) => entry.includes(BUG_REPORT_PREFIX));
  assert.ok(line, `the report must print a bug-report command:\n${report}`);
  return line.slice(line.indexOf(BUG_REPORT_PREFIX) + BUG_REPORT_PREFIX.length).trim();
}

test('the bug-report command degrades to plain --bundle for a run id the grammar would reject', () => {
  // `--bundle` alone resolves currentRunId, so the operator still gets a
  // run-scoped bundle — rather than a `--run <id>` the gate then denies.
  const command = printedBundleCommand(formatRunDiagnosticReport(probe({ runId: 'not a safe id' })));
  assert.equal(command.includes('--run'), false, command);
  assert.equal(isTrafficOneDoctorCommand('Bash', { command }), true, command);
});

function probe(over: Partial<RunDiagnosticProbe> = {}): RunDiagnosticProbe {
  return {
    runId: 'run-1',
    runDirExists: true,
    liveAgents: [],
    claims: [],
    ledger: {
      exists: true,
      rawStatus: 'active',
      rawOutcome: null,
      effectiveStatus: 'active',
      effectiveOutcome: null,
      canonicalStatus: null,
      canonicalReason: null,
      qaContractVersion: null,
      statusUpdatedAt: null,
      rollbackBarrierNote: null,
    },
    decisionCount: 0,
    denyCount: 0,
    topDenies: [],
    decisionLogPath: '/repo/.traffic-one/runs/run-1/debug/decisions.jsonl',
    ...over,
  };
}

const agent = (over: Partial<RunDiagnosticProbe['liveAgents'][number]> = {}): RunDiagnosticProbe['liveAgents'][number] => ({
  role: 'senior-frontend',
  agentId: 'agent-1',
  recordedAt: '2026-08-04T09:00:00.000Z',
  ageMs: 1_000,
  windowMs: SUBAGENT_STALE_MS,
  stale: false,
  replaced: false,
  parentSessionId: 'parent-1',
  ...over,
});

test('the next step matches the shape observed, including "wait" and "terminal"', () => {
  const stalled = formatRunDiagnosticReport(probe());
  assert.match(stalled, /not terminal and nothing is alive to advance it/);

  const inFlight = formatRunDiagnosticReport(probe({ liveAgents: [agent(), agent({ role: 'senior-backend' })] }));
  assert.match(inFlight, /2 agent\(s\) are inside their liveness window — work is in flight\. Wait for it/);

  const terminal = formatRunDiagnosticReport(probe({
    ledger: { ...probe().ledger, canonicalStatus: 'verified', effectiveStatus: 'completed' },
  }));
  assert.match(terminal, /reached a terminal state \(verified\); nothing here needs recovery/);
  assert.match(terminal, /Start a new run rather than reopening this one/);

  const skewed = formatRunDiagnosticReport(probe({
    topDenies: [{ denyId: 'not-a-real-deny-id', count: 2, recognized: false, lastSeenAt: '2026-08-04T09:00:00.000Z', gateIds: ['x'] }],
  }));
  assert.match(skewed, /UNRECOGNIZED denyId/);
  assert.match(skewed, /driven by a different plugin\n {2}version/);
});

test('the report surfaces the V2 rollback barrier instead of letting run.json lie', () => {
  const note = 'V2 rollback barrier active: run.json\'s status/outcome read "failed"/"agent-failed" for '
    + 'compatibility with older runtimes, but the canonical settlement (settlement-v2.json) says "active". '
    + 'Trust canonicalStatus, not rawStatus, for this run.';
  const report = formatRunDiagnosticReport(probe({
    ledger: {
      ...probe().ledger,
      rawStatus: 'failed',
      rawOutcome: 'agent-failed',
      effectiveStatus: 'failed',
      effectiveOutcome: 'agent-failed',
      canonicalStatus: 'active',
      rollbackBarrierNote: note,
    },
    liveAgents: [agent()],
  }));
  assert.match(report, /⚠ V2 rollback barrier active/);
  assert.match(report, /Trust canonicalStatus, not rawStatus/);
  // canonicalStatus 'active' is NOT terminal, so the next step must not say
  // "nothing needs recovery" just because run.json physically says failed.
  assert.match(report, /work is in flight/);
});

// ── findings: the machine-readable half ──────────────────────────────────────

const node = (): NodeProbe => ({ runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node', requiredMajor: 22 });
const nvm = (): NvmProbe => ({ installed: false });
const gitnexus = (): GitnexusProbe => ({ onPath: null, absoluteV22: null, crashRiskInOldNvm: false });
function baseProject(): ProjectProbe {
  return {
    cwd: '/repo', hasState: false, state: null, localPreferences: {}, localPreferencesPath: null,
    hasLocalPreferences: false, normalizedState: null, nvmrc: null, hasGit: true,
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
  };
}
const findingsFor = (runDiagnostic: RunDiagnosticProbe | null): ReturnType<typeof buildFindings> => buildFindings({
  node: node(), nvm: nvm(), gitnexus: gitnexus(), project: baseProject(), runDiagnostic,
});

test('a wedged run produces fix-needed findings, so machine-readable output cannot read HEALTHY', () => {
  withFixture((cwd, runId) => {
    const findings = findingsFor(probeRunDiagnostic(cwd, runId));
    const codes = findings.filter((finding) => finding.severity === 'fix-needed').map((finding) => finding.code);
    assert.ok(codes.includes('RUN_AGENT_STALE'), `expected RUN_AGENT_STALE in ${codes.join(', ')}`);
    assert.ok(codes.includes('RUN_CLAIM_EXPIRED'), `expected RUN_CLAIM_EXPIRED in ${codes.join(', ')}`);
    // One live agent remains, so the run is not "nothing alive to advance it".
    assert.equal(codes.includes('RUN_STALLED_NO_LIVE_AGENT'), false);
    const stale = findings.find((finding) => finding.code === 'RUN_AGENT_STALE');
    assert.match(stale?.message || '', /senior-architect \d+s into a 1800s window/);
    assert.match(stale?.message || '', /read-only/i);
  });
});

test('findings stay silent about the run when no run probe ran', () => {
  const codes = findingsFor(null).map((finding) => finding.code);
  for (const code of ['RUN_DIR_MISSING', 'RUN_AGENT_STALE', 'RUN_CLAIM_EXPIRED', 'RUN_STALLED_NO_LIVE_AGENT']) {
    assert.equal(codes.includes(code), false, `${code} must need the run probe`);
  }
});

test('findings separate "never minted", "stalled", and "terminal" runs', () => {
  const missing = findingsFor(probe({ runDirExists: false })).filter((finding) => finding.code.startsWith('RUN_'));
  assert.deepEqual(missing.map((finding) => [finding.code, finding.severity]), [['RUN_DIR_MISSING', 'fix-needed']]);

  const stalled = findingsFor(probe({ denyCount: 3, decisionCount: 9, topDenies: [
    { denyId: 'agent-model-spawn-model-required', count: 3, recognized: true, lastSeenAt: '2026-08-04T09:00:00.000Z', gateIds: ['agent-model'] },
  ] })).find((finding) => finding.code === 'RUN_STALLED_NO_LIVE_AGENT');
  assert.equal(stalled?.severity, 'fix-needed');
  assert.match(stalled?.message || '', /3 of 9 recorded decisions were denies \(most repeated: agent-model-spawn-model-required×3\)/);

  for (const [canonical, legacy] of [['verified', 'completed'], ['failed', 'failed'], ['blocked', 'blocked']] as const) {
    const terminal = findingsFor(probe({ ledger: { ...probe().ledger, canonicalStatus: canonical, effectiveStatus: legacy } }));
    assert.equal(terminal.some((finding) => finding.code === 'RUN_STALLED_NO_LIVE_AGENT'), false, `${canonical} is terminal`);
  }
  // Legacy/V1 run with no settlement file: terminality comes from the effective
  // legacy status instead.
  const legacyTerminal = findingsFor(probe({ ledger: { ...probe().ledger, effectiveStatus: 'completed' } }));
  assert.equal(legacyTerminal.some((finding) => finding.code === 'RUN_STALLED_NO_LIVE_AGENT'), false);

  const barrier = findingsFor(probe({ liveAgents: [agent()], ledger: { ...probe().ledger, rollbackBarrierNote: 'note' } }));
  assert.equal(barrier.find((finding) => finding.code === 'RUN_LEDGER_ROLLBACK_BARRIER')?.severity, 'info');
});

// ── plain `doctor`: the invocation everyone runs first ───────────────────────

function doctorArgs(over: Partial<DoctorArgs> = {}): DoctorArgs {
  return { session: null, run: null, bundle: false, unblock: null, ttl: null, ...over };
}

test('a run id is resolved from project state for EVERY invocation, not just --bundle', () => {
  const runState = { ...baseProject().runState, currentRunId: 'run-42' };
  assert.equal(resolveDoctorRunId(doctorArgs(), runState), 'run-42', 'plain doctor');
  assert.equal(resolveDoctorRunId(doctorArgs({ bundle: true }), runState), 'run-42', '--bundle');
  assert.equal(resolveDoctorRunId(doctorArgs({ run: 'run-7' }), runState), 'run-7', '--run wins');
  assert.equal(resolveDoctorRunId(doctorArgs(), baseProject().runState), null, 'no current run');
  // `--unblock` scopes to the same run the rest of doctor is reporting on, so
  // an operator who omits `--run` cannot mint against a different one than the
  // report in front of them named.
  assert.equal(resolveDoctorRunId(doctorArgs({ unblock: 'plan-guard' }), runState), 'run-42', '--unblock');
});

test('GHOST_CURRENT_RUN_ID cannot fire against a run the probe found agents and claims for', () => {
  withFixture((cwd, runId) => {
    const project: ProjectProbe = {
      ...baseProject(),
      cwd,
      runState: {
        ...baseProject().runState,
        currentRunId: runId,
        runDirExists: true,
        runJsonExists: true,
        runJsonStatus: 'active',
        // The exact shape that used to read as a ghost: a live run whose work
        // has not yet produced an assignment or a digest FILE.
        hasOrchestratedArtifacts: false,
      },
    };
    const codesFor = (runDiagnostic: RunDiagnosticProbe | null): string[] => buildFindings({
      node: node(), nvm: nvm(), gitnexus: gitnexus(), project, runDiagnostic,
    }).map((finding) => finding.code);

    // Before the run-id fallback, plain `doctor` reached buildFindings with no
    // run probe — and told the user to clear the id of a live run.
    assert.ok(codesFor(null).includes('GHOST_CURRENT_RUN_ID'), 'the harmful advice needs a blind doctor to appear');

    const diagnostic = probeRunDiagnostic(cwd, runId);
    assert.ok(diagnostic.liveAgents.length > 0 && diagnostic.claims.length > 0, 'fixture sanity: the run has registered work');
    const codes = codesFor(diagnostic);
    assert.equal(codes.includes('GHOST_CURRENT_RUN_ID'), false, `still advising a clear/rotate: ${codes.join(', ')}`);
    assert.ok(codes.includes('RUN_ORCHESTRATION_IN_PROGRESS'), `expected the in-progress finding in ${codes.join(', ')}`);
  });
});

test('a genuinely empty currentRunId still reports GHOST_CURRENT_RUN_ID', () => {
  // The fallback must not have turned the ghost check off: an id whose run
  // directory holds no agents and no claims is still a ghost.
  const project: ProjectProbe = {
    ...baseProject(),
    runState: { ...baseProject().runState, currentRunId: 'run-1', runDirExists: true, runJsonExists: true, runJsonStatus: 'active' },
  };
  const codes = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gitnexus(), project, runDiagnostic: probe({ runId: 'run-1' }),
  }).map((finding) => finding.code);
  assert.ok(codes.includes('GHOST_CURRENT_RUN_ID'), codes.join(', '));
});

test('tallyDenies is a valid comparator: ties are stable and order-independent', () => {
  // Equal counts AND equal timestamps used to return -1 for both (a, b) and
  // (b, a), which is not antisymmetric — the engine may then emit any order.
  withFixture((cwd, runId) => {
    const log = path.join(cwd, '.traffic-one', 'runs', runId, 'debug', 'decisions.jsonl');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    const tied = ['zzz-deny', 'aaa-deny', 'mmm-deny'].map((denyId) => JSON.stringify({
      ...JSON.parse(lines[0] as string),
      denyId,
      gateId: 'tie-gate',
      ts: '2026-08-04T09:09:00.000Z',
    }));
    fs.writeFileSync(log, `${[...lines, ...tied].join('\n')}\n`);
    const first = probeRunDiagnostic(cwd, runId).topDenies.map((deny) => deny.denyId);
    // Same input in the opposite file order must produce the same report.
    fs.writeFileSync(log, `${[...lines, ...tied.slice().reverse()].join('\n')}\n`);
    const second = probeRunDiagnostic(cwd, runId).topDenies.map((deny) => deny.denyId);
    assert.deepEqual(first, second);
    assert.deepEqual(first.slice(-3), ['aaa-deny', 'mmm-deny', 'zzz-deny'], 'ties broken on denyId');
  });
});
