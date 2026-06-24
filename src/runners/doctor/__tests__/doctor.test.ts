import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

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
  probeCodexHooks,
  probeMcpAuth,
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

test('probeMcpAuth reads the .mcp.json under the plugin root', () => {
  const root = tmp('root');
  const savedRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = root;
  try {
    assert.equal(probeMcpAuth().configExists, false);
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'mcp-auth': { type: 'http', url: 'https://x' } } }), 'utf8');
    const probe = probeMcpAuth();
    assert.equal(probe.configExists, true);
    assert.equal(probe.configured, true);
    assert.equal(probe.type, 'http');
    assert.equal(probe.url, 'https://x');
  } finally {
    if (savedRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = savedRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyzeCodexSessionFile counts tools + detects mutate-before-auth-gate', () => {
  const dir = tmp('codexsess');
  const savedAuth = process.env.TRAFFIC_ONE_AUTH_STATE_PATH;
  process.env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json'); // absent → present:false
  try {
    const file = path.join(dir, 'rollout-sess1.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'sess1', cwd: '/proj', base_instructions: { text: 'Traffic One Codex Instructions\nAuthenticate with the `mcp-auth` server' } } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-01-01T00:01:00Z', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm install x' }) } }),
    ].join('\n'), 'utf8');
    const d = analyzeCodexSessionFile(file);
    assert.ok(d);
    assert.equal(d?.id, 'sess1');
    assert.equal(d?.cwd, '/proj');
    assert.equal(d?.toolCallCount, 1);
    assert.equal(d?.mutatingToolCallCount, 1);
    assert.equal(d?.trafficOneInstructionInjected, true);
    assert.equal(d?.mutatingToolBeforeAuthGate, true); // no auth gate line precedes the mutate
    assert.equal(d?.authState?.present, false);
  } finally {
    if (savedAuth === undefined) delete process.env.TRAFFIC_ONE_AUTH_STATE_PATH; else process.env.TRAFFIC_ONE_AUTH_STATE_PATH = savedAuth;
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
function baseProject(over: Partial<ProjectProbe> = {}): ProjectProbe {
  return {
    cwd: '/repo', hasState: false, state: null, localPreferences: {}, localPreferencesPath: null,
    hasLocalPreferences: false, normalizedState: null, nvmrc: null, hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
    runState: { currentRunId: null, runDirExists: false, runJsonExists: false, runJsonStatus: null, hasOrchestratedArtifacts: false },
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
      runState: { currentRunId: 'run-ghost', runDirExists: false, runJsonExists: false, runJsonStatus: null, hasOrchestratedArtifacts: false },
    }),
  });
  assert.equal(ghost.find((x) => x.code === 'GHOST_CURRENT_RUN_ID')?.severity, 'fix-needed');

  const planned = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gn(),
    project: baseProject({
      runState: { currentRunId: 'run-planned', runDirExists: true, runJsonExists: true, runJsonStatus: 'planned', hasOrchestratedArtifacts: false },
    }),
  });
  assert.equal(planned.find((x) => x.code === 'PLANNED_RUN_LEDGER_ONLY')?.severity, 'info');
  assert.ok(!planned.some((x) => x.code === 'GHOST_CURRENT_RUN_ID'));
});
