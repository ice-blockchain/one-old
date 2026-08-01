// The exploration cap: at most ONE consolidation deny per (runId, role) once a
// CHILD's tally passes its cap, only for search/file-read, only for
// implementer roles. Everything uncertain fails open — this check rides every
// tool call of every child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { codexChildModelGate, explorationCapDecision } from '../codex-child-model';
import {
  AGENT_ACTIVITY_EXPLORATION_CAP_DEFAULT,
  EXPLORATION_CAPPED_ROLES,
  agentActivityCapDenied,
  bumpRunAgentActivity,
  explorationCapForRole,
  markAgentActivityCapDenied,
  readEffectiveState,
  recordRunAgent,
} from '../../../shared/state';
import { PROJECT_PREF_KEYS } from '../../../shared/state/local-prefs/pref-schema';
import { readRunModelPolicy } from '../../../shared/run-model-policy';
import { ensureRunBootstrap } from '../../../shared/run-bootstrap-policy';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { freezeRunPolicy, withMaterialized } from './agent-model-fixtures';

const CAP = AGENT_ACTIVITY_EXPLORATION_CAP_DEFAULT;

test('explorationCapDecision: only search/file-read, only implementers, only past cap, only once', () => {
  const base = { toolClass: 'search', role: 'senior-frontend', childKey: 'child-1', count: CAP, cap: CAP, alreadyDenied: false } as const;
  assert.equal(explorationCapDecision({ ...base }), 'deny');
  assert.equal(explorationCapDecision({ ...base, toolClass: 'file-read' }), 'deny');
  // Negative rows: verification/edits/spawns are never denied, at any count.
  for (const toolClass of ['shell', 'file-write', 'file-edit', 'spawn-agent', 'other']) {
    assert.equal(explorationCapDecision({ ...base, toolClass, count: CAP * 10 }), null, toolClass);
  }
  // Reviewer/tester/architect are exempt at any count.
  for (const role of ['senior-reviewer', 'senior-tester', 'senior-architect', 'senior-shipper']) {
    assert.equal(explorationCapDecision({ ...base, role, count: CAP * 10 }), null, role);
    assert.equal(EXPLORATION_CAPPED_ROLES.has(role), false, role);
  }
  // Under the cap → allow; 0 disables; unknown bucket never denies; once only.
  assert.equal(explorationCapDecision({ ...base, count: CAP - 1 }), null);
  assert.equal(explorationCapDecision({ ...base, cap: 0, count: 500 }), null);
  assert.equal(explorationCapDecision({ ...base, childKey: '' }), null);
  assert.equal(explorationCapDecision({ ...base, childKey: 'unknown', count: 500 }), null);
  assert.equal(explorationCapDecision({ ...base, alreadyDenied: true }), null);
});

test('explorationCapForRole: env override, numeric pref, per-role map, default', () => {
  const saved = process.env.T1_EXPLORATION_CAP;
  try {
    delete process.env.T1_EXPLORATION_CAP;
    assert.equal(explorationCapForRole({}, 'senior-frontend'), CAP);
    assert.equal(explorationCapForRole({ agentActivity: { explorationCap: 40 } }, 'senior-frontend'), 40);
    assert.equal(explorationCapForRole({ agentActivity: { explorationCap: { 'senior-frontend': 60 } } }, 'senior-frontend'), 60);
    assert.equal(explorationCapForRole({ agentActivity: { explorationCap: { 'senior-backend': 60 } } }, 'senior-frontend'), CAP);
    process.env.T1_EXPLORATION_CAP = '25';
    assert.equal(explorationCapForRole({ agentActivity: { explorationCap: 40 } }, 'senior-frontend'), 25);
    process.env.T1_EXPLORATION_CAP = '0';
    assert.equal(explorationCapForRole({}, 'senior-frontend'), 0, 'env 0 disables the cap');
    process.env.T1_EXPLORATION_CAP = 'junk';
    assert.equal(explorationCapForRole({}, 'senior-frontend'), CAP);
  } finally {
    if (saved === undefined) delete process.env.T1_EXPLORATION_CAP;
    else process.env.T1_EXPLORATION_CAP = saved;
  }
});

test('the deny marker is verified-then-deny: unwritable marker state can never deny', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cap-marker-'));
  try {
    assert.equal(agentActivityCapDenied(dir, 'R', 'senior-frontend'), false);
    assert.equal(markAgentActivityCapDenied(dir, 'R', 'senior-frontend'), true, 'a writable marker lands and authorizes the deny');
    assert.equal(agentActivityCapDenied(dir, 'R', 'senior-frontend'), true);
    // Unwritable root (a FILE where a directory must go → ENOTDIR) → the mark
    // cannot land → the caller must fail open.
    fs.writeFileSync(path.join(dir, 'blocker'), 'x', 'utf8');
    assert.equal(markAgentActivityCapDenied(path.join(dir, 'blocker', 'below'), 'R', 'senior-frontend'), false);
    assert.equal(markAgentActivityCapDenied('', 'R', ''), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agentActivity is a projected project preference key', () => {
  assert.equal(PROJECT_PREF_KEYS.has('agentActivity'), true);
});

// End-to-end through the child gate: a bound senior-frontend child at the cap
// draws exactly one deny on a Read, then everything flows again; a fresh child
// id starts a fresh bucket.
test('the child gate denies the 101st exploration call once, then stands down', () => {
  withMaterialized({ teamApproved: true }, (cwd) => {
    const onePath = path.join(cwd, '.traffic-one', '.one.json');
    const one = JSON.parse(fs.readFileSync(onePath, 'utf8'));
    one.mode = 'existing-codebase';
    one.lifecycle = { phase: 'maintenance', source: 'test' };
    fs.writeFileSync(onePath, JSON.stringify(one), 'utf8');
    freezeRunPolicy(cwd, 'claude');
    const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'claude' });
    const policy = readRunModelPolicy(cwd, 'run-test');
    assert.ok(policy);
    assert.ok(ensureRunBootstrap(cwd, 'run-test', 'senior-frontend', state, {
      host: 'claude',
      hostAgentType: 'senior-frontend',
      evidenceSource: 'opencode-maintenance-preflight',
      modelPolicyId: policy!.policyId,
      boundedOutputs: ['src/bounded-page.tsx'],
      boundedAllowlist: ['src/bounded-page.tsx'],
    }));

    const childCtx = (agentId: string, toolClass: ToolClass, rawName: string): Ctx => {
      const input: HookInput = {
        event: 'PreToolUse', host: 'claude', cwd,
        raw: {
          hook_event_name: 'PreToolUse', tool_name: rawName, session_id: 'parent-session',
          agent_id: agentId, agent_type: 'senior-frontend',
        },
        tool: toolClass === 'shell'
          ? { class: toolClass, rawName, command: 'npm run typecheck' }
          : { class: toolClass, rawName, filePath: path.join(cwd, 'README.md') },
      };
      return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
    };

    // Parent-issued registry row → the child is adopted on its first call.
    recordRunAgent(cwd, 'run-test', 'senior-frontend', {
      agentId: 'cap-child-1',
      parentSessionId: 'parent-session',
    });
    const bind = codexChildModelGate(childCtx('cap-child-1', 'file-read', 'Read'));
    assert.equal(bind.kind, 'noop', bind.kind === 'deny' ? bind.reason : undefined);
    // Push the child's tally to the cap.
    for (let i = 0; i < CAP; i += 1) bumpRunAgentActivity(cwd, 'run-test', 'senior-frontend', 'cap-child-1');

    // Shell at the cap is untouched — verification is never blocked.
    const shellResult = codexChildModelGate(childCtx('cap-child-1', 'shell', 'Bash'));
    assert.equal(shellResult.kind, 'noop', shellResult.kind === 'deny' ? shellResult.reason : undefined);

    const denied = codexChildModelGate(childCtx('cap-child-1', 'file-read', 'Read'));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') {
      assert.match(denied.reason, /exploration cap/i);
      assert.match(denied.reason, /refused ONCE/);
    }
    assert.equal(agentActivityCapDenied(cwd, 'run-test', 'senior-frontend'), true);

    // The very next exploration call flows — the cap is a checkpoint, not a wall.
    assert.equal(codexChildModelGate(childCtx('cap-child-1', 'file-read', 'Read')).kind, 'noop');
    assert.equal(codexChildModelGate(childCtx('cap-child-1', 'search', 'Grep')).kind, 'noop');
  });
});
