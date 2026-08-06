import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MANUAL_CERTIFICATION_HOSTS,
  hostRequiresManualCertification,
  loadManualHostCertifications,
  manualHostDeclaredCertified,
  selectedManualCertificationHosts,
  validateManualHostCertification,
  writeManualHostCertification,
  type ManualHostCertificationV1,
  type ManualCertificationHost,
} from './manual-host-certification';
import { defaultConfig } from './config/test-config';
import { releaseResultFailed } from './core/result-policy';
import { writeReport } from './reporting/aggregate-report';
import {
  ensureRunHostCapability,
  runHostCapabilityPath,
} from '../shared/host/capabilities';
import { hostCapabilityReportForRun } from './host-capability-report';
import type { CaseRunResult } from './core/types';

function record(
  host: ManualCertificationHost,
  result: ManualHostCertificationV1['result'],
  installedPluginFingerprint = 'sha256:fixture',
): ManualHostCertificationV1 {
  return {
    schemaVersion: 1,
    host,
    hostVersion: '1.2.3',
    installedPluginFingerprint,
    installSteps: ['install current generated plugin', 'restart host'],
    prompt: 'Create a route with the Traffic One team and show the enforced role.',
    artifactPaths: result === 'PASS' ? ['transcript.json', 'project.tar'] : [],
    result,
    executedAt: result === 'NOT_RUN' ? null : '2026-07-26T12:00:00.000Z',
    notes: '',
  };
}

function writePassArtifacts(dir: string): void {
  fs.writeFileSync(path.join(dir, 'transcript.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'project.tar'), 'fixture\n', 'utf8');
}

test('all five non-live-auto hosts have reproducible manual records and NOT_RUN is not certification', () => {
  // Cursor joins the other four here for a different reason: it is a
  // certified host (HOST_CAPABILITIES.cursor.tier), but has no scriptable
  // install for release CI to drive live — see capability-schema.ts.
  assert.deepEqual(MANUAL_CERTIFICATION_HOSTS, ['cursor', 'opencode', 'kilo', 'copilot', 'windsurf']);
  assert.deepEqual(
    selectedManualCertificationHosts(['claude', 'windsurf', 'opencode']),
    ['opencode', 'windsurf'],
  );
  assert.equal(hostRequiresManualCertification('claude'), false);
  assert.equal(hostRequiresManualCertification('cursor'), true);
  assert.equal(hostRequiresManualCertification('kilo'), true);
  for (const host of ['cursor', 'opencode', 'kilo', 'copilot', 'windsurf'] as const) {
    assert.deepEqual(validateManualHostCertification(record(host, 'NOT_RUN')), []);
    assert.equal(manualHostDeclaredCertified(record(host, 'NOT_RUN')), false);
    assert.equal(manualHostDeclaredCertified(record(host, 'FAIL')), false);
    assert.equal(manualHostDeclaredCertified(record(host, 'PASS')), true);
  }
});

test('validation fails closed on malformed JSON shapes instead of throwing', () => {
  assert.deepEqual(validateManualHostCertification(null), ['record must be a JSON object']);
  const malformed = {
    schemaVersion: 1,
    host: 'opencode',
    hostVersion: 42,
    installedPluginFingerprint: null,
    installSteps: 'not-an-array',
    prompt: {},
    artifactPaths: [null],
    result: 'PASS',
    executedAt: [],
    notes: null,
    waiver: { approvedBy: true },
  };
  const errors = validateManualHostCertification(malformed);
  assert.ok(errors.length >= 7);
  assert.equal(manualHostDeclaredCertified(malformed), false);
});

test('an explicit maintainer waiver is certification but an incomplete waiver is rejected', () => {
  const waived = {
    ...record('copilot', 'NOT_RUN'),
    waiver: {
      approvedBy: 'maintainer@example.test',
      reason: 'Host binary unavailable in the release environment',
      approvedAt: '2026-07-26T12:00:00.000Z',
    },
  };
  assert.equal(manualHostDeclaredCertified(waived), true);
  assert.notEqual(validateManualHostCertification({
    ...waived,
    waiver: { ...waived.waiver, reason: '' },
  }).length, 0);
});

test('loader rejects relative directories, malformed JSON, wrong fingerprints, and missing records', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-manual-host-load-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const relative = loadManualHostCertifications(
    'relative/certifications',
    ['opencode'],
    'sha256:release',
    true,
  );
  assert.equal(relative[0]?.loadStatus, 'INVALID');
  assert.match(relative[0]?.errors.join('; ') ?? '', /absolute path/);

  fs.writeFileSync(path.join(dir, 'opencode-manual-e2e.json'), '{bad json', 'utf8');
  const malformed = loadManualHostCertifications(dir, ['opencode'], 'sha256:release', true);
  assert.equal(malformed[0]?.loadStatus, 'INVALID');
  assert.equal(malformed[0]?.certified, false);
  assert.match(malformed[0]?.errors.join('; ') ?? '', /cannot be read/);

  writePassArtifacts(dir);
  writeManualHostCertification(dir, record('opencode', 'PASS', 'sha256:stale'));
  const stale = loadManualHostCertifications(dir, ['opencode'], 'sha256:release', true);
  assert.equal(stale[0]?.result, 'PASS', 'the declared result remains visible');
  assert.equal(stale[0]?.loadStatus, 'INVALID');
  assert.equal(stale[0]?.certified, false);
  assert.match(stale[0]?.errors.join('; ') ?? '', /match current release sha256:release/);

  const noReleaseFingerprint = loadManualHostCertifications(dir, ['opencode'], undefined, true);
  assert.equal(noReleaseFingerprint[0]?.loadStatus, 'INVALID');
  assert.match(noReleaseFingerprint[0]?.errors.join('; ') ?? '', /stable release fingerprint is unavailable/);

  fs.copyFileSync(
    path.join(dir, 'opencode-manual-e2e.json'),
    path.join(dir, 'kilo-manual-e2e.json'),
  );
  const wrongHost = loadManualHostCertifications(dir, ['kilo'], 'sha256:stale', true);
  assert.equal(wrongHost[0]?.loadStatus, 'INVALID');
  assert.match(wrongHost[0]?.errors.join('; ') ?? '', /host must be kilo/);

  const missing = loadManualHostCertifications(dir, ['windsurf'], 'sha256:release', true);
  assert.equal(missing[0]?.loadStatus, 'MISSING');
  assert.equal(missing[0]?.certified, false);
});

test('loader exposes PASS, FAIL, NOT_RUN, and a complete waiver without conflating them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-manual-host-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fingerprint = 'sha256:release';

  writePassArtifacts(dir);
  writeManualHostCertification(dir, record('opencode', 'PASS', fingerprint));
  writeManualHostCertification(dir, record('kilo', 'FAIL', fingerprint));
  writeManualHostCertification(dir, {
    ...record('copilot', 'NOT_RUN', fingerprint),
    waiver: {
      approvedBy: 'maintainer@example.test',
      reason: 'Host binary unavailable in the release environment',
      approvedAt: '2026-07-26T12:00:00.000Z',
    },
  });
  writeManualHostCertification(dir, record('windsurf', 'NOT_RUN', fingerprint));

  const outcomes = loadManualHostCertifications(
    dir,
    ['opencode', 'kilo', 'copilot', 'windsurf'],
    fingerprint,
    true,
  );
  assert.deepEqual(outcomes.map((outcome) => ({
    host: outcome.host,
    loadStatus: outcome.loadStatus,
    result: outcome.result,
    waiver: outcome.waiverStatus,
    certified: outcome.certified,
  })), [
    { host: 'opencode', loadStatus: 'VALID', result: 'PASS', waiver: 'NONE', certified: true },
    { host: 'kilo', loadStatus: 'VALID', result: 'FAIL', waiver: 'NONE', certified: false },
    { host: 'copilot', loadStatus: 'VALID', result: 'NOT_RUN', waiver: 'COMPLETE', certified: true },
    { host: 'windsurf', loadStatus: 'VALID', result: 'NOT_RUN', waiver: 'NONE', certified: false },
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => ({
      host: outcome.host,
      observedPrevention: outcome.hostCapability.observedPrevention,
      preventionCertified: outcome.hostCapability.preventionCertified,
    })),
    [
      { host: 'opencode', observedPrevention: 'unknown', preventionCertified: false },
      { host: 'kilo', observedPrevention: 'unknown', preventionCertified: false },
      { host: 'copilot', observedPrevention: 'unknown', preventionCertified: false },
      { host: 'windsurf', observedPrevention: 'unknown', preventionCertified: false },
    ],
  );
});

test('PASS evidence must be an existing non-symlink file contained by the certification directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-manual-host-artifacts-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'certifications');
  fs.mkdirSync(dir);
  const outside = path.join(parent, 'outside.log');
  fs.writeFileSync(outside, 'outside\n', 'utf8');
  const fingerprint = 'sha256:release';

  writeManualHostCertification(dir, {
    ...record('opencode', 'PASS', fingerprint),
    artifactPaths: ['../outside.log'],
  });
  const escaped = loadManualHostCertifications(dir, ['opencode'], fingerprint, true);
  assert.equal(escaped[0]?.certified, false);
  assert.match(escaped[0]?.errors.join('; ') ?? '', /escapes the certification directory/);

  fs.symlinkSync(outside, path.join(dir, 'evidence.log'));
  writeManualHostCertification(dir, {
    ...record('opencode', 'PASS', fingerprint),
    artifactPaths: ['evidence.log'],
  });
  const symlinked = loadManualHostCertifications(dir, ['opencode'], fingerprint, true);
  assert.equal(symlinked[0]?.certified, false);
  assert.match(symlinked[0]?.errors.join('; ') ?? '', /may not use symlinks/);

  writeManualHostCertification(dir, {
    ...record('opencode', 'PASS', fingerprint),
    artifactPaths: ['missing.log'],
  });
  const missing = loadManualHostCertifications(dir, ['opencode'], fingerprint, true);
  assert.equal(missing[0]?.certified, false);
  assert.match(missing[0]?.errors.join('; ') ?? '', /artifact is missing/);
});

test('strict release policy and report consume manual outcomes while claude/codex stay unaffected', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-manual-host-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runDir = path.join(dir, 'run');
  const fingerprint = 'sha256:release';
  writeManualHostCertification(dir, {
    ...record('copilot', 'NOT_RUN', fingerprint),
    waiver: {
      approvedBy: 'maintainer@example.test',
      reason: 'Desktop-only host was inspected manually',
      approvedAt: '2026-07-26T12:00:00.000Z',
    },
  });
  const outcomes = loadManualHostCertifications(
    dir,
    ['copilot', 'windsurf'],
    fingerprint,
    true,
  );
  const config = defaultConfig();
  config.enabledHosts = ['copilot', 'windsurf'];
  const summary = writeReport([], config, '2026-07-26T12:00:00.000Z', runDir, outcomes, fingerprint);
  assert.equal(summary.manualCertified, 1);
  assert.equal(summary.manualUncertified, 1);
  assert.equal(releaseResultFailed(summary, false), false);
  assert.equal(releaseResultFailed(summary, true), true);

  const markdown = fs.readFileSync(summary.reportPath, 'utf8');
  assert.match(markdown, /copilot \| VALID \| NOT_RUN \| COMPLETE/);
  assert.match(markdown, /windsurf \| MISSING \| — \| NONE \| NO/);
  assert.match(markdown, /NOT_RUN: unknown \| spawn-request-only \| NO/);
  const json = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8')) as {
    releaseFingerprint: string;
    manualCertifications: Array<{ result: string | null; waiverStatus: string }>;
  };
  assert.equal(json.releaseFingerprint, fingerprint);
  assert.deepEqual(
    json.manualCertifications.map(({ result, waiverStatus }) => ({ result, waiverStatus })),
    [{ result: 'NOT_RUN', waiverStatus: 'COMPLETE' }, { result: null, waiverStatus: 'NONE' }],
  );

  // Cursor is in defaultConfig().enabledHosts (['claude', 'codex', 'cursor'])
  // but is manual-e2e (certified, not live-auto) — it produces a MISSING
  // outcome when no --manual-cert-dir is given. claude/codex never appear:
  // hostRequiresManualCertification is false for both.
  const defaultOutcomes = loadManualHostCertifications(undefined, defaultConfig().enabledHosts);
  assert.deepEqual(defaultOutcomes.map((outcome) => outcome.host), ['cursor']);
  assert.equal(defaultOutcomes[0]?.loadStatus, 'MISSING');
  assert.equal(defaultOutcomes[0]?.certified, false);
  assert.equal(releaseResultFailed({ fail: 0, skip: 0, inconclusive: 0 }, true), false);
});

test('aggregate report never turns a completion-only sidecar into certified prevention', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-manual-host-completion-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'manual-project');
  const runDir = path.join(dir, 'run');
  const fingerprint = 'sha256:release';
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.json'), '{}\n', 'utf8');
  const sidecar = ensureRunHostCapability(project, 'R', 'windsurf', {
    event: 'SessionStart',
    source: 'host-session',
    sessionId: 'desktop-session-without-pre-write-hook',
  });
  assert.ok(sidecar);
  assert.equal(sidecar.prevention, 'completion-only');
  const sidecarArtifact = path.relative(dir, runHostCapabilityPath(project, 'R'));
  writeManualHostCertification(dir, {
    ...record('windsurf', 'PASS', fingerprint),
    artifactPaths: ['transcript.json', sidecarArtifact],
  });

  const outcomes = loadManualHostCertifications(
    dir,
    ['windsurf'],
    fingerprint,
    true,
  );
  assert.equal(outcomes[0]?.certified, true, 'manual PASS semantics stay distinct');
  assert.equal(outcomes[0]?.hostCapability.observedPrevention, 'completion-only');
  assert.equal(outcomes[0]?.hostCapability.observedBlockingPoint, null);
  assert.equal(outcomes[0]?.hostCapability.preventionCertified, false);
  assert.equal(outcomes[0]?.hostCapability.capabilityHash, sidecar.capabilityHash);
  assert.equal(outcomes[0]?.hostCapability.evidenceHash, sidecar.evidenceHash);

  const automaticCapability = hostCapabilityReportForRun(project, 'R', 'windsurf');
  const automatic: CaseRunResult = {
    caseId: 'completion-only-host',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    host: 'windsurf',
    runFolder: project,
    hostResult: {
      status: 'COMPLETED',
      exitCode: 0,
      durationMs: 1,
      hostCapability: automaticCapability,
    },
    assertions: [],
    startedAt: '2026-07-26T12:00:00.000Z',
    finishedAt: '2026-07-26T12:00:01.000Z',
  };
  const config = defaultConfig();
  config.enabledHosts = ['windsurf'];
  const summary = writeReport([automatic], config, automatic.startedAt, runDir, outcomes, fingerprint);
  assert.equal(summary.hostPreventionCertified, 0);
  assert.equal(summary.hostUncertified, 1);
  assert.equal(releaseResultFailed(summary, true), true);
  const markdown = fs.readFileSync(summary.reportPath, 'utf8');
  assert.match(markdown, /Automatic host prevention certifications: 0\/1/);
  assert.match(markdown, /completion-only — no primary blocking point; no primary deny \| spawn-request-only \| NO/);
  assert.match(markdown, new RegExp(sidecar.capabilityHash));
  assert.match(markdown, /run-local prevention evidence complete: \*\*NO\*\*/);
  const json = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8')) as {
    manualCertifications: Array<{ hostCapability: { preventionCertified: boolean } }>;
    results: Array<{ hostResult: { hostCapability: { observedPrevention: string; preventionCertified: boolean } } }>;
  };
  assert.equal(json.manualCertifications[0]?.hostCapability.preventionCertified, false);
  assert.deepEqual(json.results[0]?.hostResult.hostCapability, {
    ...automaticCapability,
  });
});

test('automatic prevention certification aggregates once per host across dedicated evidence cases', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-aggregate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const denyProject = path.join(dir, 'deny-project');
  const modelProject = path.join(dir, 'model-project');
  fs.mkdirSync(denyProject, { recursive: true });
  fs.mkdirSync(modelProject, { recursive: true });

  ensureRunHostCapability(denyProject, 'deny-run', 'codex', {
    point: 'PreToolUse',
    event: 'PreToolUse',
    source: 'dedicated-deny-case',
    outcome: 'denied',
  });
  ensureRunHostCapability(denyProject, 'deny-run', 'codex', {
    point: 'SubagentStart',
    event: 'SubagentStart',
    source: 'dedicated-deny-case',
  });
  ensureRunHostCapability(modelProject, 'model-run', 'codex', {
    point: 'first-tool-model-check',
    event: 'PreToolUse',
    source: 'dedicated-model-case',
  });

  const caseResult = (
    caseId: string,
    runFolder: string,
    capability: ReturnType<typeof hostCapabilityReportForRun> | undefined,
  ): CaseRunResult => ({
    caseId,
    category: 'project-lifecycle',
    layer: 'host-e2e',
    host: 'codex',
    runFolder,
    hostResult: {
      status: 'COMPLETED',
      exitCode: 0,
      durationMs: 1,
      ...(capability ? { hostCapability: capability } : {}),
    },
    assertions: [],
    startedAt: '2026-07-26T12:00:00.000Z',
    finishedAt: '2026-07-26T12:00:01.000Z',
  });
  const results = [
    caseResult(
      'host-deny-contract',
      denyProject,
      hostCapabilityReportForRun(denyProject, 'deny-run', 'codex'),
    ),
    caseResult(
      'host-model-contract',
      modelProject,
      hostCapabilityReportForRun(modelProject, 'model-run', 'codex'),
    ),
    caseResult('ordinary-business-case', path.join(dir, 'ordinary'), undefined),
  ];
  assert.ok(results.every((result) => (
    result.hostResult.hostCapability?.preventionCertified !== true
  )), 'no individual case has complete certification evidence');

  const config = defaultConfig();
  config.enabledHosts = ['codex'];
  const summary = writeReport(
    results,
    config,
    results[0]!.startedAt,
    path.join(dir, 'report'),
  );
  assert.equal(summary.hostTotal, 1, 'host count is distinct, not one row per business case');
  assert.equal(summary.hostPreventionCertified, 1);
  assert.equal(summary.hostUncertified, 0);
  assert.equal(summary.automaticHostCertifications.length, 1);
  assert.deepEqual(summary.automaticHostCertifications[0]?.observedEnforcementPoints, [
    'PreToolUse',
    'SubagentStart',
    'first-tool-model-check',
  ]);
  assert.deepEqual(summary.automaticHostCertifications[0]?.observedDeniedEnforcementPoints, [
    'PreToolUse',
  ]);
  assert.equal(
    summary.automaticHostCertifications[0]?.modelObservation,
    'first-tool-authoritative',
  );
  assert.equal(summary.automaticHostCertifications[0]?.authoritativeModelObserved, true);
  assert.equal(summary.automaticHostCertifications[0]?.preventionCertified, true);
  assert.equal(releaseResultFailed(summary, true), false);

  const markdown = fs.readFileSync(summary.reportPath, 'utf8');
  assert.match(markdown, /Automatic host prevention certifications: 1\/1/);
  assert.match(markdown, /Certification is aggregated once per host/);
  assert.match(markdown, /codex \| 3 \(host-deny-contract, host-model-contract, ordinary-business-case\)/);
});

test('manual record writer persists the required evidence atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-manual-host-'));
  try {
    const file = writeManualHostCertification(dir, record('windsurf', 'PASS'));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ManualHostCertificationV1;
    assert.equal(parsed.result, 'PASS');
    assert.deepEqual(parsed.artifactPaths, ['transcript.json', 'project.tar']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
