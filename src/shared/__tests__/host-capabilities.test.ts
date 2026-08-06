import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { codexAdapter } from '../../adapters/claude';
import { makeOpenCodeAdapter } from '../../adapters/opencode';
import { dispatch } from '../../core/dispatch';
import { deny } from '../../core/result';
import {
  ensureRunHostCapability,
  HOST_CAPABILITIES,
  hostCapability,
  observeRunHostCapabilityFromHook,
  readRunHostCapability,
  runHostCapabilityPath,
  type TrafficOneHost,
} from '../host/capabilities';
import { resetAuthoringRootCache } from '../authoring-root';
import { sha256 } from '../text';
import type { Handler, HookInput } from '../../core/types';
import { OPENCODE_HOOK_TOOL_BEFORE } from '../../config/opencode-host';
import { KILO_HOOK_TOOL_BEFORE } from '../../config/kilo-host';
import { WINDSURF_HOOK_EVENTS } from '../../config/windsurf-host';
import {
  COPILOT_EVENTS,
  CURSOR_EVENTS,
  PRE_TOOL_USE,
} from '../../gen/sources/hooks';

test('all seven supported hosts have one runtime-owned enforcement contract', () => {
  const expected: TrafficOneHost[] = [
    'claude', 'codex', 'cursor', 'opencode', 'kilo', 'copilot', 'windsurf',
  ];
  assert.deepEqual(Object.keys(HOST_CAPABILITIES).sort(), expected.sort());
  for (const host of expected) {
    const capability = HOST_CAPABILITIES[host];
    assert.equal(capability.schemaVersion, 1);
    assert.ok(capability.enforcementPoints.includes(capability.primaryBlockingPoint));
    assert.ok(capability.requiredBlockingPoints.length > 0);
    assert.ok(capability.requiredBlockingPoints.every((point) => (
      capability.enforcementPoints.includes(point)
    )));
    assert.equal(capability.prevention, 'pre-tool');
  }
});

test('only Claude/Codex claim automatic live certification; Cursor is certified but manual-e2e', () => {
  const auto = Object.values(HOST_CAPABILITIES)
    .filter((capability) => capability.certification === 'contract+live-auto')
    .map((capability) => capability.host)
    .sort();
  assert.deepEqual(auto, ['claude', 'codex']);
  const manual = Object.values(HOST_CAPABILITIES)
    .filter((capability) => capability.certification === 'contract+manual-e2e')
    .map((capability) => capability.host)
    .sort();
  // Cursor joins the manual-e2e slot for a different reason than the other
  // four: it is certified (tier) but has no scriptable install for release CI
  // to drive live, so `certification` and `tier` diverge for it alone.
  assert.deepEqual(manual, ['copilot', 'cursor', 'kilo', 'opencode', 'windsurf']);
});

test('host tier is the product enforcement-guarantee decision, independent of release certification', () => {
  const certified = Object.values(HOST_CAPABILITIES)
    .filter((capability) => capability.tier === 'certified')
    .map((capability) => capability.host)
    .sort();
  assert.deepEqual(certified, ['claude', 'codex', 'cursor']);
  const uncertified = Object.values(HOST_CAPABILITIES)
    .filter((capability) => capability.tier === 'uncertified')
    .map((capability) => capability.host)
    .sort();
  assert.deepEqual(uncertified, ['copilot', 'kilo', 'opencode', 'windsurf']);
  // Cursor is the one host where certification (release-harness proof
  // methodology) and tier (end-user enforcement guarantee) disagree.
  assert.equal(HOST_CAPABILITIES.cursor.tier, 'certified');
  assert.equal(HOST_CAPABILITIES.cursor.certification, 'contract+manual-e2e');
});

test('only Codex claims authoritative child-model observation at the first tool', () => {
  assert.equal(HOST_CAPABILITIES.codex.modelObservation, 'first-tool-authoritative');
  for (const host of Object.keys(HOST_CAPABILITIES) as TrafficOneHost[]) {
    if (host === 'codex') continue;
    assert.equal(
      HOST_CAPABILITIES[host].modelObservation,
      'spawn-request-only',
      `${host} must not overclaim observed runtime model enforcement`,
    );
  }
});

test('an adapter without its blocking point is truthfully downgraded to completion-only', () => {
  assert.equal(hostCapability('windsurf', ['pre_write_code'])?.prevention, 'completion-only');
  assert.equal(hostCapability('windsurf', [
    'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use',
  ])?.prevention, 'completion-only');
  assert.equal(hostCapability('windsurf', [
    'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use',
  ], [
    'pre_write_code',
  ])?.prevention, 'pre-tool');
  assert.equal(hostCapability('windsurf', ['post_write_code'])?.prevention, 'completion-only');
});

test('host capability contracts match the generated blocking hook sources', () => {
  assert.ok(PRE_TOOL_USE.some((group) => group.entries.some((entry) => entry.subcommand === 'check-codex-child-model')));
  assert.ok(PRE_TOOL_USE.some((group) => group.entries.some((entry) => entry.subcommand === 'check-agent-model')));
  assert.ok(CURSOR_EVENTS.some((entry) => entry.event === HOST_CAPABILITIES.cursor.primaryBlockingPoint));
  assert.equal(OPENCODE_HOOK_TOOL_BEFORE, HOST_CAPABILITIES.opencode.primaryBlockingPoint);
  assert.equal(KILO_HOOK_TOOL_BEFORE, HOST_CAPABILITIES.kilo.primaryBlockingPoint);
  assert.ok(COPILOT_EVENTS.some((entry) => entry.event === HOST_CAPABILITIES.copilot.primaryBlockingPoint));
  for (const point of HOST_CAPABILITIES.windsurf.enforcementPoints) {
    assert.ok(WINDSURF_HOOK_EVENTS.includes(point as (typeof WINDSURF_HOOK_EVENTS)[number]));
  }
});

test('all seven hosts persist observed per-run blocking capability instead of claiming static prevention', () => {
  const fixtures: Array<{ host: TrafficOneHost; raw: Record<string, unknown>; hostHookPoint?: string }> = [
    { host: 'claude', raw: {} },
    { host: 'codex', raw: {} },
    { host: 'cursor', raw: {}, hostHookPoint: 'preToolUse' },
    { host: 'opencode', raw: {}, hostHookPoint: 'tool.execute.before' },
    { host: 'kilo', raw: {}, hostHookPoint: 'tool.execute.before' },
    { host: 'copilot', raw: {} },
    { host: 'windsurf', raw: {}, hostHookPoint: 'pre_write_code' },
  ];
  for (const { host, raw, hostHookPoint } of fixtures) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `t1-host-cap-${host}-`));
    try {
      const initial = ensureRunHostCapability(cwd, 'R', host);
      assert.equal(initial?.prevention, 'completion-only', `${host}: static registry is not observed evidence`);
      let observed = observeRunHostCapabilityFromHook(cwd, 'R', {
        event: 'PreToolUse',
        host,
        ...(hostHookPoint ? { hostHookPoint } : {}),
        cwd,
        raw: { ...raw, host_version: `${host}-1.2.3` },
        tool: { class: 'file-write', rawName: 'write' },
      } satisfies HookInput);
      assert.equal(observed?.primaryBlockingPointObserved, true, host);
      assert.equal(observed?.primaryBlockingPointDenied, false, host);
      assert.equal(observed?.prevention, 'completion-only', host);
      for (const point of HOST_CAPABILITIES[host].requiredBlockingPoints) {
        observed = ensureRunHostCapability(cwd, 'R', host, {
          point,
          event: point,
          source: 'contract-test',
        });
      }
      assert.equal(observed?.requiredBlockingPointsObserved, true, host);
      assert.equal(observed?.prevention, 'completion-only', host);
      observed = ensureRunHostCapability(cwd, 'R', host, {
        point: HOST_CAPABILITIES[host].primaryBlockingPoint,
        event: HOST_CAPABILITIES[host].primaryBlockingPoint,
        source: 'contract-denial-test',
        outcome: 'denied',
      });
      assert.equal(observed?.prevention, 'pre-tool', host);
      assert.equal(observed?.requiredBlockingPointsObserved, true, host);
      assert.equal(observed?.primaryBlockingPointDenied, true, host);
      assert.equal(observed?.hostVersion, `${host}-1.2.3`, host);
      assert.ok(observed?.observedEnforcementPoints.includes(HOST_CAPABILITIES[host].primaryBlockingPoint));
      assert.deepEqual(observed?.observedDeniedEnforcementPoints, [
        HOST_CAPABILITIES[host].primaryBlockingPoint,
      ]);
      assert.deepEqual(readRunHostCapability(cwd, 'R', host), observed);
      assert.ok(fs.existsSync(runHostCapabilityPath(cwd, 'R')));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('wrapper hosts without their concrete blocking point remain completion-only', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-absent-'));
  try {
    const capability = observeRunHostCapabilityFromHook(cwd, 'R', {
      event: 'PreToolUse',
      host: 'windsurf',
      cwd,
      raw: { event: 'post_write_code', host_version: 'windsurf-1' },
      tool: { class: 'file-write', rawName: 'write' },
    });
    assert.equal(capability?.prevention, 'completion-only');
    assert.equal(capability?.primaryBlockingPointObserved, false);
    assert.deepEqual(capability?.observedEnforcementPoints, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('mutable evidence has its own full tamper-evidence hash', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-tamper-'));
  try {
    const capability = ensureRunHostCapability(cwd, 'R', 'codex', {
      point: 'PreToolUse',
      event: 'PreToolUse',
      source: 'host-hook',
      sessionId: 'original-session',
    });
    assert.ok(capability);
    const file = runHostCapabilityPath(cwd, 'R');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      evidence: Array<{ sessionId: string | null }>;
    };
    assert.ok(raw.evidence[0]);
    raw.evidence[0]!.sessionId = 'tampered-session';
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(readRunHostCapability(cwd, 'R', 'codex'), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('bounded evidence retention preserves the deny proof used for certification', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-retention-'));
  try {
    ensureRunHostCapability(cwd, 'R', 'opencode', {
      point: 'tool.execute.before',
      event: 'tool.execute.before',
      source: 'host-hook-result',
      sessionId: 'denied-session',
      outcome: 'denied',
    });
    for (let index = 0; index < 96; index += 1) {
      ensureRunHostCapability(cwd, 'R', 'opencode', {
        point: 'tool.execute.before',
        event: 'tool.execute.before',
        source: 'host-hook-result',
        sessionId: `allowed-${index}`,
        outcome: 'allowed',
      });
    }
    const capability = readRunHostCapability(cwd, 'R', 'opencode');
    assert.ok(capability);
    assert.equal(capability.evidence.length, 16);
    assert.ok(capability.evidence.some((entry) => (
      entry.point === 'tool.execute.before'
      && entry.outcome === 'denied'
      && entry.sessionId === 'denied-session'
    )));
    assert.equal(capability.primaryBlockingPointDenied, true);
    assert.equal(capability.prevention, 'pre-tool');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('verified-child-model-gate evidence survives bounded retention explicitly', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-model-gate-'));
  try {
    ensureRunHostCapability(cwd, 'R', 'codex', {
      point: 'first-tool-model-check',
      event: 'SubagentStart',
      source: 'verified-child-model-gate',
      sessionId: 'child-1',
    });
    for (let index = 0; index < 40; index += 1) {
      ensureRunHostCapability(cwd, 'R', 'codex', {
        point: 'PreToolUse',
        event: 'PreToolUse',
        source: 'host-hook-result',
        sessionId: `allowed-${index}`,
      });
    }
    const capability = readRunHostCapability(cwd, 'R', 'codex');
    assert.ok(capability);
    assert.ok(capability.evidence.length <= 16);
    // The e2e certification assertion requires this exact row; a small cap must
    // protect it explicitly, not incidentally.
    assert.ok(capability.evidence.some((entry) => (
      entry.point === 'first-tool-model-check'
      && entry.source === 'verified-child-model-gate'
    )));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a legacy sidecar with more evidence than the retention cap still parses and trims on next write', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-legacy-'));
  try {
    ensureRunHostCapability(cwd, 'R', 'codex', {
      point: 'PreToolUse',
      event: 'PreToolUse',
      source: 'host-hook-result',
      sessionId: 'seed',
    });
    const file = runHostCapabilityPath(cwd, 'R');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> & {
      evidence: Array<Record<string, unknown>>;
    };
    // Rebuild the file the way a pre-split runtime left it: 40 evidence rows
    // (over the new retention cap of 16, under the accept ceiling of 64).
    const template = raw.evidence[0]!;
    raw.evidence = Array.from({ length: 40 }, (_, index) => ({
      ...template,
      sessionId: `legacy-${index}`,
    }));
    const stable = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stable);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, stable(child)]),
      );
    };
    const { evidenceHash: _oldHash, ...evidenceCanonical } = raw;
    raw.evidenceHash = sha256(JSON.stringify(stable(evidenceCanonical)));
    fs.writeFileSync(file, JSON.stringify(raw));

    // An old oversized sidecar must parse — refusing it would permanently wedge
    // the run (published-but-invalid files are never replaced).
    const legacy = readRunHostCapability(cwd, 'R', 'codex');
    assert.ok(legacy);
    assert.equal(legacy.evidence.length, 40);

    // The next observation rewrite trims it to the retention cap.
    ensureRunHostCapability(cwd, 'R', 'codex', {
      point: 'PreToolUse',
      event: 'PreToolUse',
      source: 'host-hook-result',
      sessionId: 'post-upgrade',
    });
    const trimmed = readRunHostCapability(cwd, 'R', 'codex');
    assert.ok(trimmed);
    assert.ok(trimmed.evidence.length <= 16);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function makeAuthoringRoot(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'gen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'gen', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'traffic-one' }));
}

function makeObservedProject(root: string, runId: string): void {
  fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'existing-codebase',
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'go',
    currentRunId: runId,
  }));
}

test('dispatch records host capability at an external target project, not plugin cwd', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-dispatch-external-'));
  const authoring = path.join(base, 'plugin');
  const project = path.join(base, 'project');
  try {
    makeAuthoringRoot(authoring);
    makeObservedProject(project, 'external-run');
    resetAuthoringRootCache();
    await dispatch(codexAdapter, [], {
      argv: [],
      stdin: JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: authoring,
        session_id: 'external-child',
        tool_name: 'Write',
        tool_input: { file_path: path.join(project, 'src', 'server.go'), content: 'package main' },
      }),
    });
    const capability = readRunHostCapability(project, 'external-run', 'codex');
    assert.equal(capability?.prevention, 'completion-only');
    assert.equal(capability?.primaryBlockingPointObserved, true);
    assert.equal(capability?.primaryBlockingPointDenied, false);
    assert.equal(capability?.requiredBlockingPointsObserved, false);
    assert.equal(fs.existsSync(runHostCapabilityPath(authoring, 'external-run')), false);
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('dispatch resolves a nested package cwd to the onboarded project root', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-dispatch-nested-'));
  const nested = path.join(project, 'apps', 'web', 'src');
  try {
    makeObservedProject(project, 'nested-run');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(project, 'apps', 'web', 'package.json'), JSON.stringify({
      name: '@fixture/web',
    }));
    await dispatch(codexAdapter, [], {
      argv: [],
      stdin: JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: nested,
        session_id: 'nested-child',
        tool_name: 'Read',
        tool_input: { file_path: 'route.ts' },
      }),
    });
    const capability = readRunHostCapability(project, 'nested-run', 'codex');
    assert.equal(capability?.prevention, 'completion-only');
    assert.equal(capability?.primaryBlockingPointObserved, true);
    assert.equal(capability?.primaryBlockingPointDenied, false);
    assert.equal(capability?.requiredBlockingPointsObserved, false);
    assert.equal(fs.existsSync(runHostCapabilityPath(path.join(project, 'apps', 'web'), 'nested-run')), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('hook invocation with an empty pipeline cannot certify prevention; a real deny outcome can', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 't1-host-cap-deny-outcome-'));
  try {
    makeObservedProject(project, 'deny-run');
    const adapter = makeOpenCodeAdapter();
    const invocation = {
      argv: ['before-tool-use', '--host=opencode'],
      stdin: JSON.stringify({
        event: 'tool.execute.before',
        cwd: project,
        session_id: 'host-session',
        tool_name: 'write',
        tool_input: {
          file_path: path.join(project, 'src', 'server.go'),
          content: 'package main',
        },
      }),
    };

    const allowedWire = JSON.parse(await dispatch(adapter, [], invocation)) as {
      kind?: string;
    };
    assert.equal(allowedWire.kind, 'noop');
    const invocationOnly = readRunHostCapability(project, 'deny-run', 'opencode');
    assert.equal(invocationOnly?.requiredBlockingPointsObserved, true);
    assert.equal(invocationOnly?.primaryBlockingPointDenied, false);
    assert.deepEqual(invocationOnly?.observedDeniedEnforcementPoints, []);
    assert.equal(invocationOnly?.prevention, 'completion-only');

    const blockingHandlers: Handler[] = [{
      id: 'test.real-denial',
      event: 'PreToolUse',
      priority: 0,
      run: () => deny('blocked by test policy'),
    }];
    const deniedWire = JSON.parse(await dispatch(adapter, blockingHandlers, invocation)) as {
      kind?: string;
      reason?: string;
    };
    assert.equal(deniedWire.kind, 'deny');
    assert.match(deniedWire.reason || '', /blocked by test policy/);
    const denied = readRunHostCapability(project, 'deny-run', 'opencode');
    assert.equal(denied?.requiredBlockingPointsObserved, true);
    assert.equal(denied?.primaryBlockingPointDenied, true);
    assert.deepEqual(denied?.observedDeniedEnforcementPoints, ['tool.execute.before']);
    assert.equal(denied?.prevention, 'pre-tool');
    assert.ok(denied?.evidence.some((entry) => entry.outcome === 'denied'));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
