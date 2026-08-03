import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ensureRunHostCapability } from '../shared/host/capabilities';
import {
  currentHostCapabilityReport,
  hostCapabilityReportForRun,
} from './host-capability-report';

function withProject(fn: (projectRoot: string) => void): void {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-report-'));
  try {
    fs.mkdirSync(path.join(projectRoot, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      currentRunId: 'R',
    }));
    fn(projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test('reporting distinguishes static pre-tool expectation from observed completion-only enforcement', () => {
  withProject((projectRoot) => {
    const capability = ensureRunHostCapability(projectRoot, 'R', 'windsurf', {
      event: 'SessionStart',
      source: 'host-session',
      sessionId: 'session-without-blocking-hook',
    });
    assert.ok(capability);
    assert.equal(capability.prevention, 'completion-only');

    const report = currentHostCapabilityReport(projectRoot, 'windsurf');
    assert.equal(report.evidenceStatus, 'OBSERVED');
    assert.equal(report.contractExpectedPrevention, 'pre-tool');
    assert.equal(report.contractPrimaryBlockingPoint, 'pre_write_code');
    assert.deepEqual(report.contractRequiredBlockingPoints, [
      'pre_write_code',
      'pre_run_command',
      'pre_mcp_tool_use',
    ]);
    assert.equal(report.modelObservation, 'spawn-request-only');
    assert.equal(report.authoritativeModelObserved, false);
    assert.equal(report.observedPrevention, 'completion-only');
    assert.equal(report.observedBlockingPoint, null);
    assert.deepEqual(report.observedDeniedEnforcementPoints, []);
    assert.equal(report.primaryBlockingPointObserved, false);
    assert.equal(report.primaryBlockingPointDenied, false);
    assert.equal(report.requiredBlockingPointsObserved, false);
    assert.equal(report.preventionCertified, false);
    assert.equal(report.capabilityHash, capability.capabilityHash);
    assert.equal(report.evidenceHash, capability.evidenceHash);
  });
});

test('every required blocking point must be observed to certify preventive enforcement', () => {
  withProject((projectRoot) => {
    const before = ensureRunHostCapability(projectRoot, 'R', 'windsurf', {
      event: 'SessionStart',
      source: 'host-session',
    });
    assert.ok(before);
    const primaryOnly = ensureRunHostCapability(projectRoot, 'R', 'windsurf', {
      point: 'pre_write_code',
      event: 'pre_write_code',
      source: 'host-hook',
    });
    assert.ok(primaryOnly);

    const incomplete = hostCapabilityReportForRun(projectRoot, 'R', 'windsurf');
    assert.equal(incomplete.observedPrevention, 'completion-only');
    assert.equal(incomplete.primaryBlockingPointObserved, true);
    assert.equal(incomplete.primaryBlockingPointDenied, false);
    assert.equal(incomplete.requiredBlockingPointsObserved, false);
    assert.equal(incomplete.preventionCertified, false);

    ensureRunHostCapability(projectRoot, 'R', 'windsurf', {
      point: 'pre_run_command',
      event: 'pre_run_command',
      source: 'host-hook',
    });
    ensureRunHostCapability(projectRoot, 'R', 'windsurf', {
      point: 'pre_mcp_tool_use',
      event: 'pre_mcp_tool_use',
      source: 'host-hook',
    });

    const coverageOnly = hostCapabilityReportForRun(projectRoot, 'R', 'windsurf');
    assert.equal(coverageOnly.requiredBlockingPointsObserved, true);
    assert.equal(coverageOnly.primaryBlockingPointDenied, false);
    assert.equal(coverageOnly.observedPrevention, 'completion-only');
    assert.equal(coverageOnly.preventionCertified, false);
    assert.match(coverageOnly.detail, /coverage is complete.*no deny outcome/i);

    ensureRunHostCapability(projectRoot, 'R', 'windsurf', {
      point: 'pre_write_code',
      event: 'pre_write_code',
      source: 'host-hook-result',
      outcome: 'denied',
    });

    const report = hostCapabilityReportForRun(projectRoot, 'R', 'windsurf');
    assert.equal(report.observedPrevention, 'pre-tool');
    assert.equal(report.observedBlockingPoint, 'pre_write_code');
    assert.equal(report.primaryBlockingPointObserved, true);
    assert.equal(report.primaryBlockingPointDenied, true);
    assert.equal(report.requiredBlockingPointsObserved, true);
    assert.deepEqual(report.observedDeniedEnforcementPoints, ['pre_write_code']);
    assert.equal(report.preventionCertified, true);
    assert.equal(report.capabilityHash, before.capabilityHash);
    assert.notEqual(report.evidenceHash, before.evidenceHash);
  });
});

test('missing per-run evidence remains unknown and never inherits the static prevention claim', () => {
  withProject((projectRoot) => {
    const report = currentHostCapabilityReport(projectRoot, 'windsurf');
    assert.equal(report.evidenceStatus, 'MISSING');
    assert.equal(report.contractExpectedPrevention, 'pre-tool');
    assert.equal(report.modelObservation, 'spawn-request-only');
    assert.equal(report.authoritativeModelObserved, false);
    assert.equal(report.observedPrevention, 'unknown');
    assert.equal(report.observedBlockingPoint, null);
    assert.deepEqual(report.observedDeniedEnforcementPoints, []);
    assert.equal(report.primaryBlockingPointDenied, false);
    assert.equal(report.requiredBlockingPointsObserved, false);
    assert.equal(report.preventionCertified, false);
    assert.equal(report.capabilityHash, null);
  });
});
