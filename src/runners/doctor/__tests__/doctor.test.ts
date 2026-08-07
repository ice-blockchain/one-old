import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { NODE_FLOOR_MAJOR } from '../../../shared/node-floor';
import { HOST_IDS } from '../../../config/model-tiers';
import {
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
} from '../../../config/one-mcp';
import {
  codexConfigPath,
  commandLooksMutating,
  getPayloadText,
  parseArgs,
  parseCodexConfigToml,
  parseTomlScalar,
  rawStateHasLegacyShape,
  sessionIdFromFile,
  trustedProjectForCwd,
} from '../lib';
import { platformPathContains, samePlatformPath } from '../path-identity';
import {
  analyzeCodexSessionFile,
  probeCanonicalAuth,
  probeCodexHooks,
  probeNode,
  probeOneMcp,
  probeProject,
  probeSessionDiagnostics,
  resolveCodexSession,
  type GitnexusProbe,
  type NodeProbe,
  type NvmProbe,
  type ProjectProbe,
  type CodexHooksProbe,
} from '../probes';
import {
  CODEX_TRAFFIC_ONE_HOOK_KEYS,
  type CodexHookTrustProbe,
} from '../codex-hook-trust';
import { buildFindings } from '../findings';
import { selectDoctorProjectCwd } from '../index';
import { createPaidFallbackCompletion } from '../../../shared/maintenance/fallback-proof';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t1-doctor-${prefix}-`));
}

// The assertions are exhaustive on the WHOLE parsed shape on purpose (a new
// flag defaulting to something surprising is the failure mode), so `args()`
// spells the defaults once and every case still pins every field.
function args(over: Partial<ReturnType<typeof parseArgs>> = {}): ReturnType<typeof parseArgs> {
  return { session: null, run: null, bundle: false, unblock: null, ttl: null, ...over };
}

test('parseArgs reads --session, --run, and --bundle', () => {
  assert.deepEqual(parseArgs(['--session', 'abc']), args({ session: 'abc' }));
  assert.deepEqual(parseArgs([]), args());
  assert.deepEqual(parseArgs(['--session']), args());
  assert.deepEqual(parseArgs(['--run', '1785169657252']), args({ run: '1785169657252' }));
  assert.deepEqual(parseArgs(['--run']), args());
  assert.deepEqual(parseArgs(['--bundle']), args({ bundle: true }));
  // All three can combine (doctor never rejects an argument combination itself —
  // that is isTrafficOneDoctorCommand's job at the gate boundary).
  assert.deepEqual(
    parseArgs(['--session', 'abc', '--run', '123', '--bundle']),
    args({ session: 'abc', run: '123', bundle: true }),
  );
  // `--unblock`/`--ttl` parse here like any other flag; what keeps them out of
  // an agent's hands is the gate grammar (tool-classify.ts) and the mint's TTY
  // confirmation, never this parser.
  assert.deepEqual(parseArgs(['--unblock', 'plan-guard']), args({ unblock: 'plan-guard' }));
  assert.deepEqual(parseArgs(['--unblock']), args());
  assert.deepEqual(parseArgs(['--ttl', '30m']), args({ ttl: '30m' }));
});

test('codexConfigPath supports Windows USERPROFILE when HOME is absent', () => {
  assert.equal(
    codexConfigPath({ USERPROFILE: path.join('C:', 'Users', 'doctor') }),
    path.join('C:', 'Users', 'doctor', '.codex', 'config.toml'),
  );
});

test('selectDoctorProjectCwd anchors incident probes to the session cwd', () => {
  const invocation = tmp('doctor-invocation');
  const incident = tmp('doctor-incident');
  try {
    fs.mkdirSync(path.join(incident, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(incident, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    assert.equal(selectDoctorProjectCwd(invocation, {
      found: true,
      id: 'session-id',
      cwd: incident,
      startedAt: null,
      hookPayloadCount: 0,
      promptRequestCount: 0,
      permissionDecisionCount: 0,
      toolCallCount: 0,
      mutatingToolCallCount: 0,
    }), incident);
    assert.equal(selectDoctorProjectCwd(invocation, null), invocation);
  } finally {
    fs.rmSync(invocation, { recursive: true, force: true });
    fs.rmSync(incident, { recursive: true, force: true });
  }
});

test('parseTomlScalar coerces booleans + strips quotes', () => {
  assert.equal(parseTomlScalar('true'), true);
  assert.equal(parseTomlScalar('false'), false);
  assert.equal(parseTomlScalar('"hello"'), 'hello');
  assert.equal(parseTomlScalar('bare'), 'bare');
});

test('parseCodexConfigToml builds nested sections', () => {
  const toml = [
    '# comment',
    '[plugins."traffic-one@traffic-one-local"]',
    'enabled = true',
    '[projects."/repo"]',
    'trust_level = "trusted"',
  ].join('\n');
  const sections = parseCodexConfigToml(toml);
  assert.equal(sections['plugins."traffic-one@traffic-one-local"']?.enabled, true);
  assert.equal(sections['projects."/repo"']?.trust_level, 'trusted');
});

test('trustedProjectForCwd returns the longest covering trusted root', () => {
  const sections = {
    'projects."/repo"': { trust_level: 'trusted' },
    'projects."/repo/sub"': { trust_level: 'trusted' },
    'projects."/other"': { trust_level: 'trusted' },
  };
  assert.equal(trustedProjectForCwd('/repo/sub/feature', sections), path.resolve('/repo/sub'));
  assert.equal(trustedProjectForCwd('/elsewhere', sections), null);
});

test('doctor path identity is case-insensitive on Windows and boundary-aware', () => {
  assert.equal(samePlatformPath('C:\\Users\\Doctor\\Repo', 'c:\\users\\doctor\\repo', 'win32'), true);
  assert.equal(platformPathContains('C:\\Users\\Doctor\\Repo', 'c:\\users\\doctor\\repo\\sub', 'win32'), true);
  assert.equal(platformPathContains('C:\\Users\\Doctor\\Repo', 'c:\\users\\doctor\\repo-other', 'win32'), false);
  assert.equal(samePlatformPath('/Repo', '/repo', 'linux'), false);
});

test('sessionIdFromFile extracts uuid or strips rollout-/.jsonl', () => {
  assert.equal(sessionIdFromFile('/x/rollout-2026-01-01T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl'), '12345678-1234-1234-1234-123456789abc');
  assert.equal(sessionIdFromFile('/x/rollout-sess9.jsonl'), 'sess9');
  assert.equal(sessionIdFromFile('/x/plain.jsonl'), 'plain');
});

test('commandLooksMutating flags installs/patches, not reads', () => {
  assert.equal(commandLooksMutating('apply_patch', ''), true);
  assert.equal(commandLooksMutating('exec_command', JSON.stringify({ cmd: 'npm install left-pad' })), true);
  assert.equal(commandLooksMutating('exec_command', JSON.stringify({ cmd: 'ls -la' })), false);
  assert.equal(commandLooksMutating('exec', 'await tools.apply_patch("*** Begin Patch")'), true);
  assert.equal(commandLooksMutating('exec', 'await tools.exec_command({cmd: "pnpm install"})'), true);
  assert.equal(commandLooksMutating('exec', 'await tools.exec_command({cmd: "ls -la"})'), false);
  assert.equal(commandLooksMutating('exec', 'text("apply_patch was not called")'), false);
  assert.equal(commandLooksMutating('shell', 'rm -rf /'), false); // only exec_command/apply_patch count
});

test('getPayloadText joins the instruction text fields', () => {
  const text = getPayloadText({ base_instructions: { text: 'A' }, user_instructions: { text: 'B' } });
  assert.equal(text, 'A\nB');
  assert.equal(getPayloadText(null), '');
});

test('rawStateHasLegacyShape detects legacy fields', () => {
  assert.equal(rawStateHasLegacyShape({ projectMode: 'new-project' }), true);
  assert.equal(rawStateHasLegacyShape({ stack: { frontend: 'x' } }), true);
  assert.equal(rawStateHasLegacyShape({ mode: 'new-project', stack: 'default' }), false);
});

test('probeProject reads + normalizes the state file', () => {
  const dir = tmp('proj');
  const savedPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prefsPath = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsPath;
  try {
    fs.writeFileSync(prefsPath, JSON.stringify({ pluginUse: { enabled: false } }), 'utf8');
    const beforeState = probeProject(dir);
    assert.equal(beforeState.hasState, false);
    assert.equal((beforeState.localPreferences.pluginUse as { enabled?: boolean })?.enabled, false);
    assert.equal(beforeState.hasLocalPreferences, true);
    assert.equal(beforeState.localPreferencesPath, prefsPath);
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'new-project', stack: 'default' }), 'utf8');
    const p = probeProject(dir);
    assert.equal(p.hasState, true);
    assert.equal(p.state?.stack, 'default');
    assert.ok(p.normalizedState);
    assert.ok(p.localPreferencesPath);
  } finally {
    if (savedPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeProject reports legacy custom-backend migration conservatively without writing state', () => {
  const safe = tmp('legacy-safe');
  const ambiguous = tmp('legacy-ambiguous');
  try {
    for (const dir of [safe, ambiguous]) {
      fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
        mode: 'existing-codebase',
        stack: 'custom-backend',
        frontend: 'react-vite',
        backend: 'other',
      }));
    }
    fs.writeFileSync(path.join(ambiguous, 'package.json'), JSON.stringify({
      dependencies: { react: '19.0.0' },
    }));
    assert.equal(probeProject(safe).legacyCapabilityMigration.status, 'auto-correctable');
    assert.equal(probeProject(ambiguous).legacyCapabilityMigration.status, 'ambiguous');
    const onDisk = JSON.parse(fs.readFileSync(path.join(safe, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(onDisk.frontend, 'react-vite', 'doctor remains read-only');
  } finally {
    fs.rmSync(safe, { recursive: true, force: true });
    fs.rmSync(ambiguous, { recursive: true, force: true });
  }
});

test('probeProject evaluates fallback-paid terminality from the complete runtime proof', () => {
  const dir = tmp('paid-fallback-proof');
  try {
    const runId = 'paid';
    const runDir = path.join(dir, '.traffic-one', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'existing-codebase',
      currentRunId: runId,
    }));
    const marker = {
      version: 1,
      role: 'quick-fix',
      outcome: 'fallback-paid',
      overallOutcome: 'fallback-paid',
      workUnitContractHash: '1'.repeat(64),
      allowlistHash: '2'.repeat(64),
    };
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify(marker));
    assert.equal(probeProject(dir).runState.maintenanceTerminalOrFallbackPending, false);

    const fallbackCompletion = createPaidFallbackCompletion({
      role: 'quick-fix',
      envelopeHash: '3'.repeat(64),
      workUnitContractHash: marker.workUnitContractHash,
      allowlistHash: marker.allowlistHash,
      digestPath: '.traffic-one/digests/paid/quick-fix.md',
      digestHash: '4'.repeat(64),
      sourceBaselineHash: '5'.repeat(64),
      sourceResultHash: '6'.repeat(64),
      runBaselineHash: '7'.repeat(64),
      changedPaths: ['src/value.ts'],
      completedAt: '2026-07-27T00:00:00.000Z',
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      ...marker,
      fallbackCompletion,
    }));
    assert.equal(probeProject(dir).runState.maintenanceTerminalOrFallbackPending, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeCodexHooks parses structural plugin/workspace state but does not claim structural hook trust', async () => {
  const home = tmp('codexhome');
  const savedHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const absent = await probeCodexHooks('/repo');
    assert.equal(absent.configExists, false);
    assert.equal(absent.hookTrust.evaluation, 'indeterminate');
    const cfg = [
      '[plugins."traffic-one@traffic-one-local"]',
      'enabled = true',
      '[hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:session_start:0"]',
      'enabled = true',
      'trusted_hash = "sha256:abc"',
      '[projects."/repo"]',
      'trust_level = "trusted"',
    ].join('\n');
    fs.writeFileSync(path.join(home, 'config.toml'), cfg, 'utf8');
    const probe = await probeCodexHooks('/repo');
    assert.equal(probe.configExists, true);
    assert.equal(probe.pluginEnabled, true);
    assert.equal(probe.trustCovered, true);
    assert.deepEqual(probe.hookTrust, {
      evaluation: 'indeterminate',
      source: 'structural-config',
      reason: 'plugin-cache-missing',
      detail: null,
    });
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('probeCanonicalAuth reports path, validity, and update time without exposing the key', () => {
  const root = tmp('auth');
  const file = path.join(root, 'one.json');
  const env = { TRAFFIC_ONE_STATE_PATH: file } as NodeJS.ProcessEnv;
  try {
    assert.deepEqual(probeCanonicalAuth(env), { filePath: file, present: false, valid: false, updatedAt: null });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 3,
      auth: {
        version: 1,
        authenticated: true,
        apiKey: 'sk-must-never-appear-in-probe',
        updatedAt: '2026-07-15T00:00:00Z',
      },
      hosts: {},
    }), 'utf8');
    const probe = probeCanonicalAuth(env);
    assert.deepEqual(probe, {
      filePath: file,
      present: true,
      valid: true,
      updatedAt: '2026-07-15T00:00:00Z',
    });
    assert.equal(JSON.stringify(probe).includes('sk-must-never-appear-in-probe'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probeOneMcp reports bounded runtime-usable cache state for all hosts without payloads or remote text', () => {
  const root = tmp('onemcp');
  const file = path.join(root, 'traffic-one', 'one-mcp.json');
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION,
      hosts: {
        codex: {
          config: {
            endpoint: DEFAULT_PUBLIC_ENDPOINT,
            configName: ONE_MCP_CONFIG_NAME_BY_HOST.codex,
            decoderVersion: ONE_MCP_DECODER_VERSION,
            version: 9,
            createdAt: '2026-07-01T09:00:00.000Z',
            updatedAt: '2026-07-17T09:00:00.000Z',
            payload: {
              tiers: {
                high: ['secret-model-high'],
                balanced: ['secret-model-balanced'],
                low: ['secret-model-low'],
                auto: ['secret-model-balanced'],
              },
            },
          },
          lastSync: {
            attemptedAt: '2026-07-17T10:00:00.000Z',
            outcome: 'invalid-response',
            source: 'one-mcp',
            requestedVersion: 9,
            observedVersion: 10,
            reason: 'invalid-full-config',
            remoteError: 'remote stack trace must not appear',
          },
        },
        cursor: {
          lastSync: {
            attemptedAt: '2026-07-17T10:01:00.000Z',
            outcome: 'unavailable',
            source: 'bundled',
            requestedVersion: 0,
            observedVersion: 0,
            reason: 'transport-failed',
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    const probe = probeOneMcp(env);
    assert.deepEqual(probe.hosts.map((host) => host.host), [...HOST_IDS]);
    assert.deepEqual(
      probe.hosts.map((host) => host.configName),
      HOST_IDS.map((host) => ONE_MCP_CONFIG_NAME_BY_HOST[host]),
    );
    const codex = probe.hosts.find((host) => host.host === 'codex');
    assert.equal(codex?.catalogSource, 'one-mcp');
    assert.equal(codex?.configVersion, 9);
    assert.deepEqual(codex?.lastSync, {
      attemptedAt: '2026-07-17T10:00:00.000Z',
      outcome: 'invalid-response',
      source: 'one-mcp',
      requestedVersion: 9,
      observedVersion: 10,
      reason: 'invalid-full-config',
    });
    assert.equal(probe.hosts.find((host) => host.host === 'cursor')?.lastSync?.reason, 'transport-failed');
    const serialized = JSON.stringify(probe);
    assert.doesNotMatch(serialized, /must-not-appear|secret-model|remote stack trace|"endpoint"|"payload"/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probeOneMcp falls back to bundled when runtime rejects a cache from another endpoint', () => {
  const root = tmp('onemcp-unusable');
  const file = path.join(root, 'traffic-one', 'one-mcp.json');
  const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION,
      hosts: {
        codex: {
          config: {
            endpoint: 'https://stale.example/public-mcp',
            configName: ONE_MCP_CONFIG_NAME_BY_HOST.codex,
            decoderVersion: ONE_MCP_DECODER_VERSION,
            version: 11,
            createdAt: '2026-07-01T09:00:00.000Z',
            updatedAt: '2026-07-17T09:00:00.000Z',
            payload: {
              tiers: {
                high: ['gpt-5.6-sol'],
                balanced: ['gpt-5.6-terra'],
                low: ['gpt-5.6-terra'],
                auto: ['gpt-5.6-terra'],
              },
            },
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    const codex = probeOneMcp(env).hosts.find((host) => host.host === 'codex');
    assert.equal(codex?.catalogSource, 'bundled');
    assert.equal(codex?.configVersion, 0);
    assert.equal(codex?.configUpdatedAt, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeCodexSessionFile detects Codex hook developer messages without requiring plugin-root instructions', () => {
  const dir = tmp('codexsess');
  try {
    const file = path.join(dir, 'rollout-sess1.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'sess1', cwd: '/proj' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:20Z', payload: { type: 'user_message' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:30Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '[ACTIVE STACK: default]\n\nTraffic One setup is complete.' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:01:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm install x' }) } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:01:10Z', payload: { type: 'custom_tool_call', call_id: 'call-2', name: 'exec', input: 'const r = await tools.apply_patch("*** Begin Patch"); text(r);' } }),
    ].join('\n'), 'utf8');
    const d = analyzeCodexSessionFile(file);
    assert.ok(d);
    assert.equal(d?.id, 'sess1');
    assert.equal(d?.cwd, '/proj');
    assert.equal(d?.hookPayloadCount, 1);
    assert.equal(d?.toolCallCount, 2);
    assert.equal(d?.mutatingToolCallCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeCodexSessionFile does not mistake project AGENTS instructions for hook execution', () => {
  const dir = tmp('codexsess-project-agents');
  try {
    const file = path.join(dir, 'rollout-sess2.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'sess2', cwd: '/proj' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'user_message' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:02Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '# Traffic One Local Agent Context\n<!-- GENERATED BY traffic-one: project-local active rules -->\n[ACTIVE STACK: default]\n[traffic-one] example only' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:03Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '# Traffic One Codex Instructions\ntraffic-one — example only' }] } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:00:04Z', payload: { type: 'custom_tool_call_output', call_id: 'unmatched', output: '{"hookSpecificOutput":{"promptRequest":{},"permissionDecision":"deny"}}' } }),
    ].join('\n'), 'utf8');
    const d = analyzeCodexSessionFile(file);
    assert.equal(d?.hookPayloadCount, 0);
    assert.equal(d?.promptRequestCount, 0);
    assert.equal(d?.permissionDecisionCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeCodexSessionFile recognizes valid structured hook output once and ignores quoted field names', () => {
  const dir = tmp('codexsess-structured');
  try {
    const file = path.join(dir, 'rollout-sess3.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'traffic-one — claim required',
        },
        promptRequest: { id: 'confirm' },
      }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'none', output: 'hookSpecificOutput promptRequest permissionDecision' } }),
    ].join('\n'), 'utf8');
    const d = analyzeCodexSessionFile(file);
    assert.equal(d?.hookPayloadCount, 1);
    assert.equal(d?.promptRequestCount, 1);
    assert.equal(d?.permissionDecisionCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeCodexSessionFile validates versioned markers against their causal event window', () => {
  const dir = tmp('codexsess-markers');
  try {
    const file = path.join(dir, 'rollout-sess4.jsonl');
    const developer = (text: string): string => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      developer('<!-- traffic-one-hook-context:v1 event=SessionStart -->\n[ACTIVE STACK: default]'),
      developer('<!-- traffic-one-hook-context:v1 event=UserPromptSubmit -->\n[ACTIVE STACK: default]'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message' } }),
      developer('<!-- traffic-one-hook-context:v1 event=UserPromptSubmit -->\n[ACTIVE STACK: default]'),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
      developer('[ACTIVE STACK: default]'),
    ].join('\n'), 'utf8');
    assert.equal(analyzeCodexSessionFile(file)?.hookPayloadCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeCodexSessionFile bounds historical markers to prompt and matched tool windows', () => {
  const dir = tmp('codexsess-causal');
  try {
    const file = path.join(dir, 'rollout-sess5.jsonl');
    const developer = (text: string): string => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message' } }),
      developer('Total output lines: 42\n\n═══ traffic-one — setup required'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning' } }),
      developer('[ACTIVE STACK: default]'),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-a', name: 'exec', input: 'text("read only")' } }),
      developer('[traffic-one] pre-tool context'),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-a', output: 'ok' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
      developer('[graphify] Auto-bootstrap failed safely'),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
      developer('[traffic-one] quoted after the causal window'),
    ].join('\n'), 'utf8');
    assert.equal(analyzeCodexSessionFile(file)?.hookPayloadCount, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCodexSession finds the rollout by filename + probeSessionDiagnostics(null) is null', () => {
  assert.equal(probeSessionDiagnostics(null), null);
  const home = tmp('codexresolve');
  const savedHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const sessDir = path.join(home, 'sessions', '2026', '01');
    fs.mkdirSync(sessDir, { recursive: true });
    const file = path.join(sessDir, 'rollout-sess9.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 'sess9' } })}\n`, 'utf8');
    assert.equal(resolveCodexSession('sess9'), file);
    assert.equal(resolveCodexSession('nope'), null);
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── buildFindings: crafted probe objects (no FS) ──────────────────────────────
function runState(over: Partial<ProjectProbe['runState']> = {}): ProjectProbe['runState'] {
  return {
    currentRunId: null,
    runDirExists: false,
    runJsonExists: false,
    runJsonStatus: null,
    hasOrchestratedArtifacts: false,
    maintenanceJsonExists: false,
    maintenanceOutcome: null,
    maintenanceOverallOutcome: null,
    maintenanceOpencodeOutcome: null,
    maintenanceFallbackAllowed: false,
    maintenanceTerminalOrFallbackPending: false,
    ...over,
  };
}

function baseProject(over: Partial<ProjectProbe> = {}): ProjectProbe {
  return {
    cwd: '/repo', hasState: false, state: null, localPreferences: {}, localPreferencesPath: null,
    hasLocalPreferences: false, normalizedState: null, nvmrc: null, hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
    runState: runState(),
    nestedTrafficOneRoots: [],
    openCodeCli: 'managed',
    legacyCapabilityMigration: { status: 'not-applicable', message: null },
    ...over,
  };
}
const node = (over: Partial<NodeProbe> = {}): NodeProbe => ({ runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node', requiredMajor: 22, pluginRequiredMajor: NODE_FLOOR_MAJOR, ...over });
const nvm = (over: Partial<NvmProbe> = {}): NvmProbe => ({ installed: false, ...over });
const gn = (over: Partial<GitnexusProbe> = {}): GitnexusProbe => ({ onPath: null, absoluteV22: null, crashRiskInOldNvm: false, ...over });
type VerifiedHookTrust = Extract<CodexHookTrustProbe, { evaluation: 'verified' }>;
const healthyHookTrust = (over: Partial<VerifiedHookTrust> = {}): VerifiedHookTrust => ({
  evaluation: 'verified',
  source: 'codex-hooks-list',
  expectedCount: 16,
  counts: { discovered: 16, trusted: 16, managed: 0, modified: 0, untrusted: 0, disabled: 0, runnable: 16 },
  missingKeys: [],
  unexpectedKeys: [],
  hooks: CODEX_TRAFFIC_ONE_HOOK_KEYS.map((key) => ({
    key, eventName: 'preToolUse', enabled: true, trustStatus: 'trusted', currentHash: 'sha256:current',
  })),
  binaryPath: '/usr/bin/codex',
  codexVersion: '1.0.0',
  warnings: [],
  errors: [],
  ...over,
});
const codexProbe = (over: Partial<CodexHooksProbe> = {}): CodexHooksProbe => ({
  host: 'codex', configPath: '/c', configExists: true, cwd: '/repo', pluginEnabled: true,
  hookTrust: healthyHookTrust(), trustCovered: true, ...over,
});

test('buildFindings: session-not-found', () => {
  const f = buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(), sessionDiagnostics: { id: 's', found: false, sessionsDir: '/d' } });
  assert.ok(f.some((x) => x.code === 'CODEX_SESSION_NOT_FOUND'));
});

test('buildFindings: hook evidence is sufficient without plugin-root instruction injection', () => {
  const f = buildFindings({
    node: node(),
    nvm: nvm(),
    gitnexus: gn(),
    project: baseProject(),
    sessionDiagnostics: {
      found: true,
      id: 's',
      cwd: '/repo',
      startedAt: '2026-01-01T00:00:00Z',
      hookPayloadCount: 1,
      promptRequestCount: 0,
      permissionDecisionCount: 0,
      toolCallCount: 0,
      mutatingToolCallCount: 0,
    },
  });
  assert.equal(f.some((x) => x.code === 'CODEX_HOOK_OUTPUT_NOT_OBSERVED_FOR_SESSION'), false);
  assert.equal(f.some((x) => x.code.includes('INSTRUCTIONS_NOT_INJECTED')), false);
});

test('buildFindings: absent hook output is informational evidence, not proof hooks failed', () => {
  const sessionDiagnostics = {
    found: true as const,
    id: 's',
    cwd: '/repo',
    startedAt: '2026-01-01T00:00:00Z',
    hookPayloadCount: 0,
    promptRequestCount: 3,
    permissionDecisionCount: 0,
    toolCallCount: 0,
    mutatingToolCallCount: 0,
  };
  const f = buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(), sessionDiagnostics });
  const finding = f.find((x) => x.code === 'CODEX_HOOK_OUTPUT_NOT_OBSERVED_FOR_SESSION');
  assert.equal(finding?.severity, 'info');
  assert.match(finding?.message || '', /no attributable Traffic One hook-output evidence/i);

  const declined = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({ localPreferences: { pluginUse: { enabled: false } }, hasLocalPreferences: true }),
    sessionDiagnostics,
  });
  assert.equal(declined.some((x) => x.code === 'CODEX_HOOK_OUTPUT_NOT_OBSERVED_FOR_SESSION'), false);
});

test('buildFindings: codex plugin disabled', () => {
  const f = buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(), codexHooks: codexProbe({ pluginEnabled: false }) });
  assert.ok(f.some((x) => x.code === 'CODEX_TRAFFIC_ONE_HOOKS_DISABLED'));
});

test('buildFindings: One MCP invalid, missing, and temporary outcomes are bounded informational diagnostics', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(),
    oneMcp: {
      hosts: [
        {
          host: 'codex',
          configName: ONE_MCP_CONFIG_NAME_BY_HOST.codex,
          catalogSource: 'one-mcp',
          configVersion: 4,
          configUpdatedAt: '2026-07-17T09:00:00.000Z',
          lastSync: {
            attemptedAt: '2026-07-17T10:00:00.000Z',
            outcome: 'invalid-response',
            source: 'one-mcp',
            requestedVersion: 4,
            observedVersion: 5,
            reason: 'invalid-full-config',
          },
        },
        {
          host: 'cursor',
          configName: ONE_MCP_CONFIG_NAME_BY_HOST.cursor,
          catalogSource: 'bundled',
          configVersion: 0,
          configUpdatedAt: null,
          lastSync: {
            attemptedAt: '2026-07-17T10:00:00.000Z',
            outcome: 'config-not-found',
            source: 'bundled',
            requestedVersion: 2,
            observedVersion: 0,
          },
        },
        {
          host: 'kilo',
          configName: ONE_MCP_CONFIG_NAME_BY_HOST.kilo,
          catalogSource: 'bundled',
          configVersion: 0,
          configUpdatedAt: null,
          lastSync: {
            attemptedAt: '2026-07-17T10:00:00.000Z',
            outcome: 'unavailable',
            source: 'bundled',
            requestedVersion: 0,
            observedVersion: 0,
            reason: 'transport-failed',
          },
        },
      ],
    },
  });
  assert.equal(f.find((finding) => finding.code === 'ONE_MCP_CONFIG_REJECTED')?.severity, 'info');
  assert.equal(f.find((finding) => finding.code === 'ONE_MCP_CONFIG_NOT_FOUND')?.severity, 'info');
  assert.equal(f.find((finding) => finding.code === 'ONE_MCP_SYNC_UNAVAILABLE')?.severity, 'info');
  assert.match(f.find((finding) => finding.code === 'ONE_MCP_SYNC_UNAVAILABLE')?.message || '', /transport-failed/);
});

test('buildFindings: exact runnable Codex hooks are healthy', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(),
    codexHooks: codexProbe(),
  });
  assert.ok(!f.some((x) => x.code === 'CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED'));
  assert.ok(!f.some((x) => x.code === 'CODEX_TRAFFIC_ONE_HOOK_ABI_MISMATCH'));
  assert.ok(!f.some((x) => x.code === 'CODEX_TRAFFIC_ONE_HOOKS_DISABLED'));
  assert.ok(!f.some((x) => x.code === 'CODEX_HOOK_TRUST_INDETERMINATE'));
});

test('buildFindings: official Codex hook findings distinguish ABI, disabled, trust, and indeterminate', () => {
  const base = { node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject() };
  const abi = buildFindings({
    ...base,
    codexHooks: codexProbe({
      hookTrust: healthyHookTrust({
        counts: { discovered: 15, trusted: 15, managed: 0, modified: 0, untrusted: 0, disabled: 0, runnable: 15 },
        missingKeys: [CODEX_TRAFFIC_ONE_HOOK_KEYS[15] as string],
      }),
    }),
  });
  assert.ok(abi.some((finding) => finding.code === 'CODEX_TRAFFIC_ONE_HOOK_ABI_MISMATCH'));

  const disabled = buildFindings({
    ...base,
    codexHooks: codexProbe({
      hookTrust: healthyHookTrust({
        counts: { discovered: 16, trusted: 16, managed: 0, modified: 0, untrusted: 0, disabled: 1, runnable: 15 },
      }),
    }),
  });
  assert.ok(disabled.some((finding) => finding.code === 'CODEX_TRAFFIC_ONE_HOOKS_DISABLED'));

  const notTrusted = buildFindings({
    ...base,
    codexHooks: codexProbe({
      hookTrust: healthyHookTrust({
        counts: { discovered: 16, trusted: 0, managed: 0, modified: 14, untrusted: 2, disabled: 0, runnable: 0 },
      }),
    }),
  });
  assert.ok(notTrusted.some((finding) => finding.code === 'CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED'));

  const notFullyRunnable = buildFindings({
    ...base,
    codexHooks: codexProbe({
      hookTrust: healthyHookTrust({
        counts: { discovered: 16, trusted: 16, managed: 0, modified: 0, untrusted: 0, disabled: 0, runnable: 15 },
      }),
    }),
  });
  assert.ok(notFullyRunnable.some((finding) => finding.code === 'CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED'));

  const uncertain = buildFindings({
    ...base,
    codexHooks: codexProbe({
      hookTrust: { evaluation: 'indeterminate', source: 'structural-config', reason: 'unsupported-api', detail: null },
    }),
  });
  assert.ok(uncertain.some((finding) => finding.code === 'CODEX_HOOK_TRUST_INDETERMINATE'));
});

test('buildFindings: legacy state shape + local prefs in project state', () => {
  const f = buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject({ state: { projectMode: 'new-project', team: {} } }) });
  assert.ok(f.some((x) => x.code === 'LEGACY_TRAFFIC_ONE_STATE'));
  assert.ok(f.some((x) => x.code === 'LOCAL_PREFERENCES_IN_PROJECT_STATE'));
});

test('buildFindings distinguishes safe and ambiguous legacy capability migrations', () => {
  const safe = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({
      legacyCapabilityMigration: { status: 'auto-correctable', message: 'no frontend artifacts were detected' },
    }),
  });
  assert.equal(safe.find((item) => item.code === 'LEGACY_CUSTOM_BACKEND_SAFE_MIGRATION')?.severity, 'info');

  const ambiguous = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({
      legacyCapabilityMigration: { status: 'ambiguous', message: 'active run preserves its original capability profile' },
    }),
  });
  assert.equal(ambiguous.find((item) => item.code === 'LEGACY_CUSTOM_BACKEND_AMBIGUOUS')?.severity, 'fix-needed');
});

test('buildFindings: gitnexus crash-risk + node-too-old-no-nvm', () => {
  const f = buildFindings({
    node: node({ runningMajor: 20 }),
    nvm: nvm({ installed: false }),
    gitnexus: gn({ onPath: '/home/u/.nvm/versions/node/v20.0.0/bin/gitnexus', crashRiskInOldNvm: true }),
    project: baseProject({ state: { mode: 'new-project', stack: 'default', codeGraphProvider: 'gitnexus' } }),
  });
  assert.ok(f.some((x) => x.code === 'GITNEXUS_IN_OLD_NVM_NODE'));
  assert.ok(f.some((x) => x.code === 'NO_NVM_NO_V22'));
});

// The plugin's own runtime floor, which is a DIFFERENT question from the three
// gitnexus findings above: those ask whether a Node 22 exists somewhere for the
// code-graph provider (and only when gitnexus is the provider), this asks
// whether the process running the hooks is a supported runtime at all. The case
// below is on graphify precisely so a pass cannot be borrowed from the
// provider-scoped block.
test('buildFindings: a hook runtime below the declared engine floor is reported on any provider', () => {
  const probe = node({ runningMajor: NODE_FLOOR_MAJOR - 4, runningVersion: `${NODE_FLOOR_MAJOR - 4}.20.4` });
  assert.ok(probe.runningMajor !== null && probe.runningMajor < probe.pluginRequiredMajor,
    'the fixture is not below the floor, so the assertions below mean nothing');

  const f = buildFindings({
    node: probe,
    nvm: nvm({ installed: true, hasV22: true }),
    gitnexus: gn(),
    project: baseProject({ state: { mode: 'new-project', stack: 'default', codeGraphProvider: 'graphify' } }),
  });
  const hit = f.find((x) => x.code === 'HOOK_RUNTIME_NODE_BELOW_FLOOR');
  assert.ok(hit, 'an unsupported hook runtime produced no finding');
  assert.equal(hit?.severity, 'fix-needed');
  assert.match(hit?.message || '', new RegExp(`Node ${NODE_FLOOR_MAJOR - 4}\\.20\\.4`));
  assert.match(hit?.message || '', new RegExp(`floor of Node ${NODE_FLOOR_MAJOR}`));
  assert.match(hit?.message || '', /engines\.node/, 'the message must say where the floor is declared');
  assert.match(hit?.message || '', /\/usr\/bin\/node/, 'the message must name the PATH node doctor actually saw');
  assert.match(hit?.message || '', /launched from the desktop does not inherit/, 'the message must name the GUI-PATH cause');
  // On graphify none of the provider-scoped node findings may fire, or this case
  // would be indistinguishable from the gitnexus block firing.
  for (const code of ['NODE_LT22_BUT_V22_AVAILABLE', 'NVM_INSTALLED_NO_V22', 'NO_NVM_NO_V22']) {
    assert.equal(f.some((x) => x.code === code), false, `${code} must be provider-scoped`);
  }

  // At the floor: silent. Same fixture otherwise, so the discriminator is the
  // version and nothing else.
  const supported = buildFindings({
    node: node({ runningMajor: NODE_FLOOR_MAJOR }),
    nvm: nvm({ installed: true, hasV22: true }),
    gitnexus: gn(),
    project: baseProject({ state: { mode: 'new-project', stack: 'default', codeGraphProvider: 'graphify' } }),
  });
  assert.equal(supported.some((x) => x.code === 'HOOK_RUNTIME_NODE_BELOW_FLOOR'), false);
});

// One probe, not two. probeNode() already reported the running version for the
// gitnexus questions; the floor finding reads the same fields off the same probe.
test('probeNode reports the plugin floor from the shared declaration, on the same reading', () => {
  const probe = probeNode();
  assert.equal(probe.pluginRequiredMajor, NODE_FLOOR_MAJOR);
  assert.equal(probe.runningVersion, process.versions.node, 'the probe must report THIS process, not a second reading');
  assert.equal(probe.runningMajor, Number(process.versions.node.split('.')[0]));
});

test('buildFindings: opencode enabled + CLI missing → fix-needed (self-heal messaging)', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({ normalizedState: { openCode: { enabled: true } }, openCodeCli: 'missing' }),
  });
  const hit = f.find((x) => x.code === 'OPENCODE_CLI_MISSING');
  assert.ok(hit);
  assert.equal(hit?.severity, 'fix-needed');
});

test('buildFindings: opencode enabled + PATH-resolved CLI → info (unpinned version)', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({ normalizedState: { openCode: { enabled: true } }, openCodeCli: 'path' }),
  });
  const hit = f.find((x) => x.code === 'OPENCODE_CLI_UNMANAGED');
  assert.ok(hit);
  assert.equal(hit?.severity, 'info');
  assert.ok(!f.some((x) => x.code === 'OPENCODE_CLI_MISSING'));
});

test('buildFindings: opencode enabled on codex without [mcp_servers.opencode-worker] → fix-needed; registered → silent', () => {
  const base = {
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({ normalizedState: { openCode: { enabled: true } } }),
  };
  const missing = buildFindings({ ...base, codexHooks: codexProbe({ opencodeMcpRegistered: false }) });
  assert.ok(missing.some((x) => x.code === 'CODEX_OPENCODE_MCP_NOT_REGISTERED'));
  const registered = buildFindings({ ...base, codexHooks: codexProbe({ opencodeMcpRegistered: true }) });
  assert.ok(!registered.some((x) => x.code === 'CODEX_OPENCODE_MCP_NOT_REGISTERED'));
});

test('buildFindings: opencode findings are silent when delegation is not enabled', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({ openCodeCli: 'missing' }),
    codexHooks: codexProbe({ opencodeMcpRegistered: false }),
  });
  assert.ok(!f.some((x) => x.code === 'OPENCODE_CLI_MISSING' || x.code === 'CODEX_OPENCODE_MCP_NOT_REGISTERED' || x.code === 'OPENCODE_CLI_UNMANAGED'));
});

test('buildFindings: ghost currentRunId is report-only and planned ledgers are info', () => {
  const ghost = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({
      runState: runState({ currentRunId: 'run-ghost', runDirExists: false }),
    }),
  });
  assert.equal(ghost.find((x) => x.code === 'GHOST_CURRENT_RUN_ID')?.severity, 'fix-needed');

  const planned = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({
      runState: runState({ currentRunId: 'run-planned', runDirExists: true, runJsonExists: true, runJsonStatus: 'planned' }),
    }),
  });
  assert.equal(planned.find((x) => x.code === 'PLANNED_RUN_LEDGER_ONLY')?.severity, 'info');
  assert.ok(!planned.some((x) => x.code === 'GHOST_CURRENT_RUN_ID'));
});

test('buildFindings: maintenance fallback metadata is not a ghost run', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({
      runState: runState({
        currentRunId: 'run-maint',
        runDirExists: true,
        maintenanceJsonExists: true,
        maintenanceOutcome: 'failed',
        maintenanceOverallOutcome: 'fallback-pending',
        maintenanceOpencodeOutcome: 'failed',
        maintenanceFallbackAllowed: true,
        maintenanceTerminalOrFallbackPending: true,
      }),
    }),
  });
  assert.equal(f.find((x) => x.code === 'MAINTENANCE_FALLBACK_PENDING')?.severity, 'info');
  assert.ok(!f.some((x) => x.code === 'GHOST_CURRENT_RUN_ID'));
});

test('buildFindings: nested roots are reported non-destructively', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({ nestedTrafficOneRoots: ['/repo/apps/web'] }),
  });
  assert.equal(f.find((x) => x.code === 'NESTED_TRAFFIC_ONE_ROOTS')?.severity, 'fix-needed');
});
