// Sentinel: agentModelGate must not create or mutate the developer's real
// ~/.traffic-one. The suite pins HOME (test-preload.mjs); this asserts the
// unpinned home captured before that pin was left alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { agentModelGate } from '../handler';
import { freezeRunPolicy, withMaterialized } from './agent-model-fixtures';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function spawnCtx(cwd: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: {
      tool_name: 'Task',
      tool_input: { subagent_type: 'senior-frontend', model: 'opus', prompt: 'build the thing' },
      session_id: 'parent-1',
    },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function snapshotRealTrafficOne(realHome: string): {
  existed: boolean;
  binExisted: boolean;
  binListing: string[] | null;
} {
  const root = path.join(realHome, '.traffic-one');
  const existed = fs.existsSync(root);
  const bin = path.join(root, 'bin');
  const binExisted = existed && fs.existsSync(bin);
  if (!binExisted) {
    return { existed, binExisted: false, binListing: null };
  }
  return {
    existed,
    binExisted: true,
    binListing: fs.readdirSync(bin).sort(),
  };
}

test('agentModelGate does not create or mutate the unpinned real ~/.traffic-one', () => {
  const realHome = process.env.TRAFFIC_ONE_TEST_UNPINNED_HOME;
  // Do not invent a path: a no-preload run must fail rather than skip the
  // real-home half (and must not call agentModelGate against an invented home).
  assert.ok(realHome,
    'TRAFFIC_ONE_TEST_UNPINNED_HOME must be set by test-preload.mjs');
  const before = snapshotRealTrafficOne(realHome);

  withMaterialized({ teamApproved: true }, (cwd) => {
    freezeRunPolicy(cwd, 'claude');
    agentModelGate(spawnCtx(cwd));
  });

  const after = snapshotRealTrafficOne(realHome);
  if (!before.existed) {
    assert.equal(after.existed, false,
      `agentModelGate must not create ${path.join(realHome, '.traffic-one')}`);
    return;
  }
  if (!before.binExisted) {
    assert.equal(after.binExisted, false,
      `agentModelGate must not create ${path.join(realHome, '.traffic-one', 'bin')}`);
    return;
  }
  assert.deepEqual(after.binListing, before.binListing,
    'real ~/.traffic-one/bin must not gain files from this agentModelGate call');
});
