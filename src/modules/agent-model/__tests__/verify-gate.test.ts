// The reviewer/tester verification spawn gate: deny ONCE while the Step-0
// batch is verifiably pending, never on a dead/terminal batch, own marker
// budget (never the opencode-gate-denies one — the tester sits in both gates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openCodeFirstGates } from '../gate-opencode-first';
import { agentModelGate } from '../handler';
import type { GateContext } from '../gate-context';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import {
  markOpenCodePlanBatchTerminal,
  markVerifyGateDenied,
  touchPlanBatchHeartbeat,
  verifyGateDenied,
} from '../../../shared/opencode-roles';
import { buildOpenCodeQueue, writeOpenCodeQueue } from '../../../shared/opencode-queue';
import { withMaterialized } from './agent-model-fixtures';

const STATE = {
  mode: 'new-project',
  openCode: { enabled: true },
  toolchain: { opencode: { installedVersion: '1.0.0' } },
};

function liveBatchProject(runId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-verify-gate-'));
  fs.mkdirSync(path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
    '<!-- opencode-delegate:start -->\n'
    + '- id: u1 | role: frontend | files: src/a.ts | task: t\n'
    + '<!-- opencode-delegate:end -->\n', 'utf8');
  writeOpenCodeQueue(dir, buildOpenCodeQueue(dir, runId, [{ role: 'frontend', files: 'src/a.ts', task: 't' }]));
  fs.writeFileSync(
    path.join(dir, '.traffic-one', 'runs', runId, 'opencode-plan-batch', 'batch.json'),
    JSON.stringify({ version: 1, outcome: 'running', startedAt: new Date().toISOString(), rolesCompleted: [] }),
    'utf8',
  );
  return dir;
}

function gateContext(cwd: string, role: string, runId: string): GateContext {
  const input: HookInput = {
    event: 'PreToolUse', host: 'claude', cwd,
    raw: { tool_name: 'Task', tool_input: { subagent_type: role } },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  const ctx = { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
  return {
    ctx, cwd, state: STATE as never, raw: {}, toolName: 'Task', toolInput: {},
    role, roleEvidence: { role } as never, spawnRunId: runId, runPolicy: null,
    subagentTeam: true, spawnPromptText: '', allowSpawn: (r) => r,
  } as GateContext;
}

test('reviewer spawn is denied ONCE while the batch is live, then always goes through', () => {
  const dir = liveBatchProject('run-vg');
  try {
    touchPlanBatchHeartbeat(dir, 'run-vg'); // verifiably alive
    const first = openCodeFirstGates(gateContext(dir, 'senior-reviewer', 'run-vg'));
    assert.ok(first && first.kind === 'deny');
    if (first && first.kind === 'deny') {
      assert.match(first.reason, /verification gate/i);
      assert.match(first.reason, /denies at most once/);
    }
    assert.equal(verifyGateDenied(dir, 'run-vg', 'senior-reviewer'), true);
    // Second spawn: the budget is spent — the gate stands down for good.
    assert.equal(openCodeFirstGates(gateContext(dir, 'senior-reviewer', 'run-vg')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead or terminal batch never gates the verifiers; implementer roles are untouched by this gate', () => {
  // Dead: running batch.json but no heartbeat, no fresh unit, no latch.
  const dead = liveBatchProject('run-vg-dead');
  try {
    assert.equal(openCodeFirstGates(gateContext(dead, 'senior-reviewer', 'run-vg-dead')), null, 'a dead batch does not gate');
    assert.equal(verifyGateDenied(dead, 'run-vg-dead', 'senior-reviewer'), false, 'no budget burned on a dead batch');
  } finally {
    fs.rmSync(dead, { recursive: true, force: true });
  }
  // Terminal: batch finished → nothing to wait for.
  const done = liveBatchProject('run-vg-done');
  try {
    touchPlanBatchHeartbeat(done, 'run-vg-done');
    markOpenCodePlanBatchTerminal(done, 'run-vg-done', 'success');
    assert.equal(openCodeFirstGates(gateContext(done, 'senior-reviewer', 'run-vg-done')), null);
  } finally {
    fs.rmSync(done, { recursive: true, force: true });
  }
});

// The tester sits in BOTH gates (verify + per-role OpenCode-first): distinct
// marker budgets, so the worst case is exactly two denies, then through.
test('tester composition: verify-gate deny, then the OpenCode-first deny, then through', () => {
  const dir = liveBatchProject('run-vg-tester');
  try {
    // Queue a TESTER unit too so the per-role OpenCode-first gate has work.
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'),
      '<!-- opencode-delegate:start -->\n'
      + '- id: u1 | role: frontend | files: src/a.ts | task: t\n'
      + '- id: u2 | role: tester | files: e2e/b.ts | task: t2\n'
      + '<!-- opencode-delegate:end -->\n', 'utf8');
    writeOpenCodeQueue(dir, buildOpenCodeQueue(dir, 'run-vg-tester', [
      { role: 'frontend', files: 'src/a.ts', task: 't' },
      { role: 'tester', files: 'e2e/b.ts', task: 't2' },
    ]));
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'run-vg-tester' }), 'utf8');
    touchPlanBatchHeartbeat(dir, 'run-vg-tester');

    const first = openCodeFirstGates(gateContext(dir, 'senior-tester', 'run-vg-tester'));
    assert.ok(first && first.kind === 'deny');
    if (first && first.kind === 'deny') assert.match(first.reason, /verification gate/i);

    const second = openCodeFirstGates(gateContext(dir, 'senior-tester', 'run-vg-tester'));
    assert.ok(second && second.kind === 'deny', 'the per-role OpenCode-first deny still has its own budget');
    if (second && second.kind === 'deny') assert.doesNotMatch(second.reason, /verification gate/i);

    const third = openCodeFirstGates(gateContext(dir, 'senior-tester', 'run-vg-tester'));
    assert.equal(third, null, 'after two bounded denies the spawn always goes through');
    // Distinct marker files — shared budgets would disable one gate silently.
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'run-vg-tester', 'verify-gate-denies', 'senior-tester')), true);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'run-vg-tester', 'opencode-gate-denies', 'senior-tester')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('marker helpers: verified-write convention', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-verify-marker-'));
  try {
    assert.equal(verifyGateDenied(dir, 'R', 'senior-reviewer'), false);
    assert.equal(markVerifyGateDenied(dir, 'R', 'senior-reviewer'), true);
    assert.equal(verifyGateDenied(dir, 'R', 'senior-reviewer'), true);
    fs.writeFileSync(path.join(dir, 'blocker'), 'x', 'utf8');
    assert.equal(markVerifyGateDenied(path.join(dir, 'blocker', 'below'), 'R', 'senior-reviewer'), false, 'no durable marker, no deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Parallel mode: implementer spawns stand down while the batch runs, but the
// verifier gate is NOT flag-gated — reviewers/testers wait in both modes.
test('openCode.parallelImplementers lifts the implementer spawn gate but never the verify gate', () => {
  const dir = liveBatchProject('run-vg-par');
  try {
    touchPlanBatchHeartbeat(dir, 'run-vg-par');
    const parallelState = { ...STATE, openCode: { enabled: true, parallelImplementers: true } };
    const gc = (role: string): GateContext => ({
      ...gateContext(dir, role, 'run-vg-par'),
      state: parallelState as never,
    });
    // Implementer: with the flag ON, the plan-batch spawn deny stands down
    // (the frontend has queued units and no attempt marker, so the per-role
    // OpenCode-first deny still gets its single say — that budget is separate).
    const frontend = openCodeFirstGates(gc('senior-frontend'));
    if (frontend && frontend.kind === 'deny') {
      assert.doesNotMatch(frontend.reason, /opencode-plan-batch-required|Step-0 plan batch/i, 'the batch spawn deny must stand down under the flag');
    }
    // Verifier: still gated on the live batch, flag or no flag.
    const reviewer = openCodeFirstGates(gc('senior-reviewer'));
    assert.ok(reviewer && reviewer.kind === 'deny');
    if (reviewer && reviewer.kind === 'deny') assert.match(reviewer.reason, /verification gate/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// One row through the REAL spawn pipeline: with no live batch, a reviewer
// spawn in the standard fixture flows exactly as before this gate existed.
test('pipeline regression: a reviewer spawn without a live batch is not affected', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const input: HookInput = {
      event: 'PreToolUse', host: 'claude', cwd,
      raw: { tool_name: 'Task', tool_input: { subagent_type: 'senior-reviewer', model: 'opus' } },
      tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
    };
    const ctx = { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
    const result = agentModelGate(ctx);
    assert.equal(result.kind, 'noop', result.kind === 'deny' ? result.reason : undefined);
  });
});
