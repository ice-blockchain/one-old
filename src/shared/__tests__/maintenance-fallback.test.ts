import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  captureMaintenanceFallbackBaseline,
  finalizePaidMaintenanceFallback,
  workUnitAllowlistHash,
} from '../maintenance-fallback';
import { paidFallbackCompletionFromMaintenance } from '../maintenance-fallback-proof';
import { isMaintenanceTerminal } from '../maintenance-terminal';
import { ensureRunBootstrap, quickFixDigestPath } from '../run-bootstrap-policy';
import { readRunSettlement, writeRunSettlement } from '../run-settlement';

const RUN_ID = 'paid-fallback';
const SOURCE = 'src/value.ts';

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function withFallbackProject(
  run: (fixture: {
    cwd: string;
    markerPath: string;
    digestPath: string;
    contractHash: string;
    allowlistHash: string;
  }) => void,
  options: { role?: 'quick-fix' | 'senior-frontend' } = {},
): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-paid-fallback-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, SOURCE), 'export const value = 1;\n');
    git(cwd, ['init', '-q']);
    git(cwd, ['config', 'user.email', 't@example.com']);
    git(cwd, ['config', 'user.name', 'T']);
    git(cwd, ['add', '-A']);
    git(cwd, ['commit', '-q', '-m', 'baseline']);
    const role = options.role || 'quick-fix';
    const state = {
      version: 1,
      mode: 'existing-codebase',
      stack: role === 'senior-frontend' ? 'default' : 'custom-backend',
      frontend: role === 'senior-frontend' ? 'react-vite' : 'none',
      backend: role === 'senior-frontend' ? 'supabase' : 'python',
      currentRunId: RUN_ID,
      lifecycle: { phase: 'maintenance' },
    };
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(state));
    const bootstrap = ensureRunBootstrap(cwd, RUN_ID, role, state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'test-parent',
      modelPolicyId: 'test-policy',
      boundedOutputs: [SOURCE],
      boundedAllowlist: [SOURCE],
    });
    assert.ok(bootstrap);
    const digestRelative = role === 'quick-fix'
      ? quickFixDigestPath(RUN_ID)
      : `.traffic-one/digests/${RUN_ID}/frontend.md`;
    assert.ok(bootstrap.workUnit.outputs.includes(digestRelative));
    assert.ok(bootstrap.workUnit.allowlist.includes(digestRelative));
    const fallbackSourceBaseline = captureMaintenanceFallbackBaseline(cwd, bootstrap);
    assert.ok(fallbackSourceBaseline);
    const allowlistHash = workUnitAllowlistHash(bootstrap);
    const markerPath = path.join(cwd, '.traffic-one', 'runs', RUN_ID, 'maintenance.json');
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      kind: 'opencode-delegation',
      role,
      outcome: 'failed',
      overallOutcome: 'fallback-pending',
      fallbackAllowed: true,
      workUnitContractHash: bootstrap.workUnit.contractHash,
      allowlistHash,
      fallbackSourceBaseline,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    }));
    writeRunSettlement(cwd, RUN_ID, {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: bootstrap.workUnit.contractHash,
      allowlistHash,
      fallback: {
        state: 'pending',
        workUnitContractHash: bootstrap.workUnit.contractHash,
        allowlistHash,
      },
      incompleteChecks: ['fallback-pending'],
    });
    run({
      cwd,
      markerPath,
      digestPath: path.join(cwd, digestRelative),
      contractHash: bootstrap.workUnit.contractHash,
      allowlistHash,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function writeImplementedDigest(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# quick-fix\n\nverdict: IMPLEMENTED\n');
}

test('paid fallback finalizer requires a source delta and rejects wrong role/hash evidence', () => {
  withFallbackProject(({ cwd, markerPath, digestPath }) => {
    writeImplementedDigest(digestPath);
    assert.deepEqual(finalizePaidMaintenanceFallback(cwd, RUN_ID), {
      status: 'pending',
      reason: 'paid fallback has not produced an in-allowlist source delta',
    });

    const original = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(markerPath, JSON.stringify({ ...original, role: 'senior-backend' }));
    assert.equal(finalizePaidMaintenanceFallback(cwd, RUN_ID).status, 'invalid');

    fs.writeFileSync(markerPath, JSON.stringify({
      ...original,
      workUnitContractHash: '0'.repeat(64),
    }));
    assert.equal(finalizePaidMaintenanceFallback(cwd, RUN_ID).status, 'invalid');
    assert.equal(readRunSettlement(cwd, RUN_ID)?.fallback?.state, 'pending');
  });
});

test('paid fallback finalizer atomically publishes fallback-paid and code-delivered, and replay is idempotent', () => {
  withFallbackProject(({ cwd, markerPath, digestPath, contractHash, allowlistHash }) => {
    fs.writeFileSync(path.join(cwd, SOURCE), 'export const value = 2;\n');
    writeImplementedDigest(digestPath);

    const completed = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.changedPaths, [SOURCE]);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    const proof = paidFallbackCompletionFromMaintenance(marker);
    assert.ok(proof);
    assert.equal(marker.outcome, 'fallback-paid');
    assert.equal(marker.overallOutcome, 'fallback-paid');
    assert.equal(isMaintenanceTerminal(marker), true);
    assert.equal(proof.role, 'quick-fix');
    assert.equal(proof.workUnitContractHash, contractHash);
    assert.equal(proof.allowlistHash, allowlistHash);
    assert.deepEqual(proof.changedPaths, [SOURCE]);

    const settlement = readRunSettlement(cwd, RUN_ID);
    assert.equal(settlement?.status, 'code-delivered');
    assert.equal(settlement?.fallback?.state, 'completed');
    assert.equal(settlement?.workUnitContractHash, contractHash);
    assert.equal(settlement?.allowlistHash, allowlistHash);
    assert.notEqual(settlement?.status, 'verified');

    const replay = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    const replayedSettlement = readRunSettlement(cwd, RUN_ID);
    assert.equal(replay.status, 'already-completed');
    assert.equal(replayedSettlement?.revision, settlement?.revision);
    assert.equal(replayedSettlement?.settlementHash, settlement?.settlementHash);
  });
});

test('paid frontend fallback finalizes against the same exact bounded role contract', () => {
  withFallbackProject(({ cwd, markerPath, digestPath, contractHash }) => {
    fs.writeFileSync(path.join(cwd, SOURCE), 'export const value = 3;\n');
    writeImplementedDigest(digestPath);

    const completed = finalizePaidMaintenanceFallback(cwd, RUN_ID);
    assert.equal(completed.status, 'completed');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    const proof = paidFallbackCompletionFromMaintenance(marker);
    assert.ok(proof);
    assert.equal(proof.role, 'senior-frontend');
    assert.equal(proof.workUnitContractHash, contractHash);
    assert.equal(proof.digestPath, `.traffic-one/digests/${RUN_ID}/frontend.md`);
    assert.equal(readRunSettlement(cwd, RUN_ID)?.status, 'code-delivered');
  }, { role: 'senior-frontend' });
});
