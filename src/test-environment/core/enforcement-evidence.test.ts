import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertion } from '../assertions/host-enforcement-evidence.assert';
import { HOST_ENFORCEMENT_CASES } from '../config/cases/host-enforcement.cases';
import { defaultConfig } from '../config/test-config';
import { hostCapabilityReportForRun } from '../host-capability-report';
import { aggregateAutomaticHostCertifications } from '../reporting/aggregate-report';
import type {
  AssertionContext,
  Case,
  CaseRunResult,
  HostId,
} from './types';
import { ensureRunHostCapability } from '../../shared/host/capabilities';

const RUN_ID = '1700000000999';

function testCase(params: Record<string, unknown>): Case {
  return {
    id: 'enforcement-test',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    fixture: 'existing-react-vite',
    preSeed: {
      mode: 'existing-codebase',
      currentRunId: RUN_ID,
      frontend: 'react-vite',
      backend: 'none',
    },
    prompt: 'probe',
    assertions: [{ id: assertion.id, params }],
  };
}

function context(
  cwd: string,
  host: HostId,
  params: Record<string, unknown>,
): AssertionContext {
  const config = defaultConfig();
  return {
    cwd,
    env: {},
    host,
    testCase: testCase(params),
    spec: { id: assertion.id, params },
    hostResult: { status: 'COMPLETED', exitCode: 0, durationMs: 1 },
    hostConfig: config.hosts[host],
  };
}

function project(t: TestContext): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-live-evidence-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), `${JSON.stringify({
    mode: 'existing-codebase',
    onboardingComplete: true,
    currentRunId: RUN_ID,
  })}\n`, 'utf8');
  return cwd;
}

test('dedicated case catalog contains primary deny and child/model live probes', () => {
  assert.deepEqual(HOST_ENFORCEMENT_CASES.map((entry) => entry.id), [
    'enf-primary-pretool-deny',
    'enf-claude-child-bootstrap',
    'enf-codex-first-tool-model',
  ]);
  const primary = HOST_ENFORCEMENT_CASES[0]!;
  assert.deepEqual(primary.hostFilter, ['claude', 'codex', 'cursor']);
  const codex = HOST_ENFORCEMENT_CASES[2]!;
  assert.deepEqual(codex.hostFilter, ['codex']);
  assert.match(codex.prompt || '', /task_name `quick_fix`/);
  assert.match(codex.prompt || '', /\{TEST_MODEL_CHEAPEST\}/);
  assert.match(codex.prompt || '', /first and only project operation is to read package\.json/);
});

test('primary deny evidence passes only when the denied outcome is live and the target is absent', async (t) => {
  const cwd = project(t);
  const params = {
    denyPrimary: true,
    absentPaths: ['.traffic-one/runs/e2e-deny/model-policy.json'],
  };
  ensureRunHostCapability(cwd, RUN_ID, 'codex', {
    point: 'PreToolUse',
    event: 'PreToolUse',
    source: 'host-hook-result',
    outcome: 'denied',
  });
  const passed = await assertion.run(context(cwd, 'codex', params));
  assert.equal(passed.status, 'PASS');

  fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'e2e-deny'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', 'e2e-deny', 'model-policy.json'), '{}\n');
  const escaped = await assertion.run(context(cwd, 'codex', params));
  assert.equal(escaped.status, 'FAIL');
  assert.match(escaped.detail, /operation was not prevented/i);
});

test('hook invocation without a deny outcome is never prevention proof', async (t) => {
  const cwd = project(t);
  ensureRunHostCapability(cwd, RUN_ID, 'claude', {
    point: 'PreToolUse',
    event: 'PreToolUse',
    source: 'host-hook-result',
    outcome: 'allowed',
  });
  const observedOnly = await assertion.run(context(cwd, 'claude', { denyPrimary: true }));
  assert.equal(observedOnly.status, 'FAIL');
  assert.match(observedOnly.detail, /did not produce the required deny outcome/i);
});

test('Codex first-tool model proof requires the verified-child-model-gate source', async (t) => {
  const cwd = project(t);
  ensureRunHostCapability(cwd, RUN_ID, 'codex', {
    point: 'SubagentStart',
    event: 'SubagentStart',
    source: 'host-hook-result',
  });
  ensureRunHostCapability(cwd, RUN_ID, 'codex', {
    point: 'first-tool-model-check',
    event: 'PreToolUse',
    source: 'verified-child-model-gate',
  });
  const passed = await assertion.run(context(cwd, 'codex', {
    observedPoints: ['SubagentStart', 'first-tool-model-check'],
    authoritativeModel: true,
    childProbe: true,
  }));
  assert.equal(passed.status, 'PASS');
});

test('declared headless child limitation is UNSUPPORTED, never a synthetic pass', async (t) => {
  const cwd = project(t);
  ensureRunHostCapability(cwd, RUN_ID, 'codex', {
    point: 'PreToolUse',
    event: 'PreToolUse',
    source: 'host-hook-result',
    outcome: 'allowed',
  });
  const unsupported = await assertion.run(context(cwd, 'codex', {
    observedPoints: ['SubagentStart', 'first-tool-model-check'],
    authoritativeModel: true,
    childProbe: true,
  }));
  assert.equal(unsupported.status, 'UNSUPPORTED');
  assert.match(unsupported.detail, /not certification/i);
});

test('report aggregation combines dedicated cases without weakening any host required points', (t) => {
  const root = project(t);
  const projectFor = (name: string, runId: string): string => {
    const cwd = path.join(root, name);
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), `${JSON.stringify({
      currentRunId: runId,
    })}\n`);
    return cwd;
  };
  const result = (
    caseId: string,
    host: HostId,
    cwd: string,
    runId: string,
  ): CaseRunResult => ({
    caseId,
    category: 'project-lifecycle',
    layer: 'host-e2e',
    host,
    runFolder: cwd,
    hostResult: {
      status: 'COMPLETED',
      exitCode: 0,
      durationMs: 1,
      hostCapability: hostCapabilityReportForRun(cwd, runId, host),
    },
    assertions: [],
    startedAt: '2026-07-27T00:00:00.000Z',
    finishedAt: '2026-07-27T00:00:01.000Z',
  });

  const claudeDeny = projectFor('claude-deny', 'claude-deny');
  ensureRunHostCapability(claudeDeny, 'claude-deny', 'claude', {
    point: 'PreToolUse',
    event: 'PreToolUse',
    source: 'host-hook-result',
    outcome: 'denied',
  });
  const claudeChild = projectFor('claude-child', 'claude-child');
  for (const point of ['SubagentStart', 'native-bootstrap']) {
    ensureRunHostCapability(claudeChild, 'claude-child', 'claude', {
      point,
      event: point,
      source: point === 'native-bootstrap' ? 'runtime-bootstrap' : 'host-hook-result',
    });
  }

  const codexDeny = projectFor('codex-deny', 'codex-deny');
  ensureRunHostCapability(codexDeny, 'codex-deny', 'codex', {
    point: 'PreToolUse',
    event: 'PreToolUse',
    source: 'host-hook-result',
    outcome: 'denied',
  });
  const codexChild = projectFor('codex-child', 'codex-child');
  ensureRunHostCapability(codexChild, 'codex-child', 'codex', {
    point: 'SubagentStart',
    event: 'SubagentStart',
    source: 'host-hook-result',
  });
  ensureRunHostCapability(codexChild, 'codex-child', 'codex', {
    point: 'first-tool-model-check',
    event: 'PreToolUse',
    source: 'verified-child-model-gate',
  });

  const cursorDeny = projectFor('cursor-deny', 'cursor-deny');
  ensureRunHostCapability(cursorDeny, 'cursor-deny', 'cursor', {
    point: 'preToolUse',
    event: 'preToolUse',
    source: 'host-hook-result',
    outcome: 'denied',
  });

  const aggregate = aggregateAutomaticHostCertifications([
    result('enf-primary-pretool-deny', 'claude', claudeDeny, 'claude-deny'),
    result('enf-claude-child-bootstrap', 'claude', claudeChild, 'claude-child'),
    result('enf-primary-pretool-deny', 'codex', codexDeny, 'codex-deny'),
    result('enf-codex-first-tool-model', 'codex', codexChild, 'codex-child'),
    result('enf-primary-pretool-deny', 'cursor', cursorDeny, 'cursor-deny'),
  ]);
  assert.equal(aggregate.find((entry) => entry.host === 'claude')?.preventionCertified, true);
  assert.equal(aggregate.find((entry) => entry.host === 'codex')?.preventionCertified, true);
  assert.equal(
    aggregate.find((entry) => entry.host === 'codex')?.authoritativeModelObserved,
    true,
  );
  const cursor = aggregate.find((entry) => entry.host === 'cursor');
  assert.equal(cursor?.preventionCertified, false);
  assert.deepEqual(cursor?.observedEnforcementPoints, ['preToolUse']);
  assert.deepEqual(cursor?.contractRequiredBlockingPoints, [
    'preToolUse',
    'beforeShellExecution',
    'beforeReadFile',
    'beforeMCPExecution',
  ]);
});
