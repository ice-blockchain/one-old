import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertion as digestAssertion } from '../assertions/digests-terminal.assert';
import { assertion as fingerprintAssertion } from '../assertions/plugin-runtime-fingerprint.assert';
import { assertion as manifestAssertion } from '../assertions/run-manifest-roles.assert';
import { defaultConfig } from '../config/test-config';
import { writeReport } from '../reporting/aggregate-report';
import { assertionSpecsForRun } from './case-runner';
import { releaseResultFailed } from './result-policy';
import { RUNTIME_PROOF_ENTRY_ENV, RUNTIME_PROOF_FILE_ENV, RUNTIME_PROOF_TOKEN_ENV } from './current-dist';
import type { AssertionContext, Case, CaseRunResult } from './types';

const CASE: Case = {
  id: 'filtered-cursor-edit',
  category: 'existing-project',
  layer: 'host-e2e',
  fixture: 'existing-react-vite',
  preSeed: {
    mode: 'existing-codebase',
    frontend: 'react-vite',
    backend: 'node',
    team: { mode: 'subagents', approved: true },
  },
  prompt: 'Edit one label.',
  assertions: [{ id: 'onboarding-complete' }],
};

function tempRoots(): { root: string; project: string; dist: string; dispose: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-release-proof-'));
  const project = path.join(root, 'project');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(dist, 'rules', 'common'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'rules', 'common', 'auth-gate.md'), '# current gate\n', 'utf8');
  return { root, project, dist, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function context(project: string, dist: string): AssertionContext {
  const config = defaultConfig();
  return {
    cwd: project,
    env: {
      TRAFFIC_ONE_PLUGIN_ROOT: dist,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(project, 'preferences.json'),
      [RUNTIME_PROOF_FILE_ENV]: path.join(project, 'runtime-proof.json'),
      [RUNTIME_PROOF_TOKEN_ENV]: '0123456789abcdef0123456789abcdef',
      [RUNTIME_PROOF_ENTRY_ENV]: 'scripts/cursor-hook-runtime.cjs',
    },
    host: 'cursor',
    testCase: CASE,
    spec: { id: 'plugin-runtime-fingerprint' },
    hostResult: { status: 'COMPLETED', exitCode: 0, durationMs: 1 },
    hostConfig: config.hosts.cursor,
  };
}

test('every selected host-E2E run receives the runtime fingerprint invariant', () => {
  assert.deepEqual(
    assertionSpecsForRun(CASE, 'cursor').map((spec) => spec.id),
    ['onboarding-complete', 'plugin-runtime-fingerprint'],
  );
  assert.deepEqual(
    assertionSpecsForRun(CASE, 'pure-node').map((spec) => spec.id),
    ['onboarding-complete'],
  );
});

test('runtime fingerprint requires the selected compiled entry token and rejects stale same-version output', async (t) => {
  const roots = tempRoots();
  t.after(roots.dispose);
  const ctx = context(roots.project, roots.dist);
  const proofFile = ctx.env[RUNTIME_PROOF_FILE_ENV];
  assert.ok(proofFile);
  fs.writeFileSync(proofFile, `${JSON.stringify({
    version: 1,
    token: ctx.env[RUNTIME_PROOF_TOKEN_ENV],
    entry: ctx.env[RUNTIME_PROOF_ENTRY_ENV],
  })}\n`, 'utf8');

  assert.equal((await fingerprintAssertion.run(ctx)).status, 'PASS');
  fs.writeFileSync(proofFile, `${JSON.stringify({
    version: 1,
    token: 'ffffffffffffffffffffffffffffffff',
    entry: ctx.env[RUNTIME_PROOF_ENTRY_ENV],
  })}\n`, 'utf8');
  assert.equal((await fingerprintAssertion.run(ctx)).status, 'FAIL');
  fs.rmSync(proofFile);
  assert.equal((await fingerprintAssertion.run(ctx)).status, 'FAIL');

  const prefsPath = ctx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  assert.ok(prefsPath);
  const unarmed: AssertionContext = { ...ctx, env: { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath } };
  assert.equal((await fingerprintAssertion.run(unarmed)).status, 'FAIL');
});

test('declared headless subagent absence is informational but unknown absence remains strict', async (t) => {
  const roots = tempRoots();
  t.after(roots.dispose);
  const ctx = context(roots.project, roots.dist);
  const digestCtx = { ...ctx, spec: { id: 'digests-terminal' } };
  const manifestCtx = { ...ctx, spec: { id: 'run-manifest-roles' } };

  assert.equal((await digestAssertion.run(digestCtx)).status, 'UNSUPPORTED');
  assert.equal((await manifestAssertion.run(manifestCtx)).status, 'UNSUPPORTED');
  assert.equal(releaseResultFailed({ fail: 0, skip: 0, inconclusive: 0 }, true), false);

  const runDir = path.join(roots.project, '.traffic-one', 'runs', '123');
  fs.mkdirSync(runDir, { recursive: true });
  const staleRunDir = path.join(roots.project, '.traffic-one', 'runs', '122');
  fs.mkdirSync(staleRunDir, { recursive: true });
  fs.writeFileSync(path.join(staleRunDir, 'assignments.json'), `${JSON.stringify({
    version: 1,
    runId: '122',
    assignments: [
      { role: 'senior-frontend', scope: { include: ['src/**'] } },
      { role: 'senior-backend', scope: { include: ['api/**'] } },
    ],
  })}\n`, 'utf8');
  assert.equal((await digestAssertion.run(digestCtx)).status, 'INCONCLUSIVE');
  assert.equal((await manifestAssertion.run(manifestCtx)).status, 'INCONCLUSIVE');

  const digestDir = path.join(roots.project, '.traffic-one', 'digests', '123');
  fs.mkdirSync(digestDir, { recursive: true });
  fs.writeFileSync(path.join(digestDir, 'reviewer.md'), 'Verdict: CHANGES_REQUESTED\n', 'utf8');
  assert.equal((await digestAssertion.run(digestCtx)).status, 'INCONCLUSIVE');

  fs.writeFileSync(path.join(runDir, 'assignments.json'), `${JSON.stringify({
    version: 1,
    runId: '123',
    assignments: [{ role: 'senior-frontend', scope: { include: ['src/**'] } }],
  })}\n`, 'utf8');
  const partial = await manifestAssertion.run(manifestCtx);
  assert.equal(partial.status, 'FAIL');
  assert.match(partial.detail, /missing \[senior-backend\]/);
  fs.writeFileSync(path.join(runDir, 'assignments.json'), `${JSON.stringify({
    version: 1,
    runId: '123',
    assignments: [
      { role: 'senior-frontend', scope: { include: ['src/**'] } },
      { role: 'senior-backend', scope: { include: ['api/**'] } },
    ],
  })}\n`, 'utf8');
  assert.equal((await manifestAssertion.run(manifestCtx)).status, 'PASS');

  const unknown = {
    ...digestCtx,
    hostConfig: { ...ctx.hostConfig!, headlessSubagents: 'unknown' as const },
  };
  assert.equal((await digestAssertion.run(unknown)).status, 'INCONCLUSIVE');
  assert.equal(releaseResultFailed({ fail: 0, skip: 0, inconclusive: 1 }, true), true);
  assert.equal(releaseResultFailed({ fail: 1, skip: 0, inconclusive: 0 }, true), true);
});

test('reports count UNSUPPORTED separately from strict failures', (t) => {
  const roots = tempRoots();
  t.after(roots.dispose);
  const result: CaseRunResult = {
    caseId: CASE.id,
    category: CASE.category,
    layer: CASE.layer,
    host: 'cursor',
    runFolder: roots.root,
    hostResult: { status: 'COMPLETED', exitCode: 0, durationMs: 1 },
    assertions: [{
      id: 'digests-terminal',
      title: 'Subagent digests reached terminal verdict',
      status: 'UNSUPPORTED',
      detail: 'headless capability unavailable',
    }],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
  const summary = writeReport([result], defaultConfig(), new Date().toISOString(), roots.root);
  assert.equal(summary.unsupported, 1);
  assert.equal(summary.fail + summary.skip + summary.inconclusive, 0);
  assert.match(fs.readFileSync(summary.reportPath, 'utf8'), /Assertions \(P\/F\/S\/I\/U\)/);
});
