import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { HOST_IDS } from '../../../config/model-tiers';
import {
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
} from '../../../config/one-mcp';
import {
  commandLooksMutating,
  getPayloadText,
  parseArgs,
  parseCodexConfigToml,
  parseTomlScalar,
  rawStateHasLegacyShape,
  sessionIdFromFile,
  trustedProjectForCwd,
} from '../lib';
import {
  analyzeCodexSessionFile,
  probeCanonicalAuth,
  probeCodexHooks,
  probeOneMcp,
  probeProject,
  probeSessionDiagnostics,
  resolveCodexSession,
  type GitnexusProbe,
  type NodeProbe,
  type NvmProbe,
  type ProjectProbe,
} from '../probes';
import { buildFindings } from '../findings';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t1-doctor-${prefix}-`));
}

test('parseArgs reads --session', () => {
  assert.deepEqual(parseArgs(['--session', 'abc']), { session: 'abc' });
  assert.deepEqual(parseArgs([]), { session: null });
  assert.deepEqual(parseArgs(['--session']), { session: null });
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

test('sessionIdFromFile extracts uuid or strips rollout-/.jsonl', () => {
  assert.equal(sessionIdFromFile('/x/rollout-2026-01-01T00-00-00-12345678-1234-1234-1234-123456789abc.jsonl'), '12345678-1234-1234-1234-123456789abc');
  assert.equal(sessionIdFromFile('/x/rollout-sess9.jsonl'), 'sess9');
  assert.equal(sessionIdFromFile('/x/plain.jsonl'), 'plain');
});

test('commandLooksMutating flags installs/patches, not reads', () => {
  assert.equal(commandLooksMutating('apply_patch', ''), true);
  assert.equal(commandLooksMutating('exec_command', JSON.stringify({ cmd: 'npm install left-pad' })), true);
  assert.equal(commandLooksMutating('exec_command', JSON.stringify({ cmd: 'ls -la' })), false);
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
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    assert.equal(probeProject(dir).hasState, false);
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

test('probeCodexHooks parses plugin + hook trust from config.toml', () => {
  const home = tmp('codexhome');
  const savedHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(probeCodexHooks('/repo').configExists, false);
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
    const probe = probeCodexHooks('/repo');
    assert.equal(probe.configExists, true);
    assert.equal(probe.pluginEnabled, true);
    assert.equal(probe.hookStateEntryCount, 1);
    assert.equal(probe.trustCovered, true);
    assert.deepEqual(probe.missingHookEvents, ['user_prompt_submit', 'pre_tool_use', 'post_tool_use']);
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
  const file = path.join(root, 'one-mcp.json');
  const env = {
    TRAFFIC_ONE_MCP_CACHE_PATH: file,
    TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT: 'https://must-not-appear.example/public-mcp',
  } as NodeJS.ProcessEnv;
  try {
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION,
      hosts: {
        codex: {
          config: {
            endpoint: 'https://must-not-appear.example/public-mcp',
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
  const file = path.join(root, 'one-mcp.json');
  const env = {
    TRAFFIC_ONE_MCP_CACHE_PATH: file,
    TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT: 'https://current.example/public-mcp',
  } as NodeJS.ProcessEnv;
  try {
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

test('analyzeCodexSessionFile counts tools and detects injected instructions', () => {
  const dir = tmp('codexsess');
  try {
    const file = path.join(dir, 'rollout-sess1.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'sess1', cwd: '/proj', base_instructions: { text: 'Traffic One Codex Instructions\nUse the canonical API-key wizard' } } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:01:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm install x' }) } }),
    ].join('\n'), 'utf8');
    const d = analyzeCodexSessionFile(file);
    assert.ok(d);
    assert.equal(d?.id, 'sess1');
    assert.equal(d?.cwd, '/proj');
    assert.equal(d?.toolCallCount, 1);
    assert.equal(d?.mutatingToolCallCount, 1);
    assert.equal(d?.trafficOneInstructionInjected, true);
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
    ...over,
  };
}
const node = (over: Partial<NodeProbe> = {}): NodeProbe => ({ runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node', requiredMajor: 22, ...over });
const nvm = (over: Partial<NvmProbe> = {}): NvmProbe => ({ installed: false, ...over });
const gn = (over: Partial<GitnexusProbe> = {}): GitnexusProbe => ({ onPath: null, absoluteV22: null, crashRiskInOldNvm: false, ...over });

test('buildFindings: session-not-found', () => {
  const f = buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(), sessionDiagnostics: { id: 's', found: false, sessionsDir: '/d' } });
  assert.ok(f.some((x) => x.code === 'CODEX_SESSION_NOT_FOUND'));
});

test('buildFindings: codex plugin disabled', () => {
  const f = buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(), codexHooks: { host: 'codex', configPath: '/c', configExists: true, cwd: '/repo', pluginEnabled: false } });
  assert.ok(f.some((x) => x.code === 'CODEX_TRAFFIC_ONE_PLUGIN_DISABLED'));
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

test('buildFindings: Codex trusted hashes do not require enabled hook counters', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject(),
    codexHooks: {
      host: 'codex',
      configPath: '/c',
      configExists: true,
      cwd: '/repo',
      pluginEnabled: true,
      hookStateEntryCount: 13,
      hookStateEnabledCount: 0,
      hookStateTrustedHashCount: 13,
      missingHookEvents: [],
      trustCovered: true,
    },
  });
  assert.ok(!f.some((x) => x.code === 'CODEX_TRAFFIC_ONE_HOOKS_NOT_TRUSTED'));
});

test('buildFindings: legacy state shape + local prefs in project state', () => {
  const f = buildFindings({ node: node(), nvm: nvm(), gitnexus: gn(), project: baseProject({ state: { projectMode: 'new-project', team: {} } }) });
  assert.ok(f.some((x) => x.code === 'LEGACY_TRAFFIC_ONE_STATE'));
  assert.ok(f.some((x) => x.code === 'LOCAL_PREFERENCES_IN_PROJECT_STATE'));
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
  const missing = buildFindings({ ...base, codexHooks: { host: 'codex' as const, configPath: '/c', configExists: true, cwd: '/repo', pluginEnabled: true, opencodeMcpRegistered: false } });
  assert.ok(missing.some((x) => x.code === 'CODEX_OPENCODE_MCP_NOT_REGISTERED'));
  const registered = buildFindings({ ...base, codexHooks: { host: 'codex' as const, configPath: '/c', configExists: true, cwd: '/repo', pluginEnabled: true, opencodeMcpRegistered: true } });
  assert.ok(!registered.some((x) => x.code === 'CODEX_OPENCODE_MCP_NOT_REGISTERED'));
});

test('buildFindings: opencode findings are silent when delegation is not enabled', () => {
  const f = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({ openCodeCli: 'missing' }),
    codexHooks: { host: 'codex', configPath: '/c', configExists: true, cwd: '/repo', pluginEnabled: true, opencodeMcpRegistered: false },
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
