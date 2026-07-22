import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CODEX_TRUST_PROOF_EXPECTED_HOOKS,
  CODEX_TRUST_PROOF_PLUGIN_ID,
  codexTrustUpgradeProofRequired,
  createIsolatedCodexProofEnv,
  runCodexTrustUpgradeProof,
  runRequiredCodexTrustUpgradeProof,
  type CodexHookAbiFixture,
  type CodexProofAppServer,
  type CodexProofAppServerOptions,
  type ProofCommandRunner,
} from './codex-trust-upgrade-proof';
import { parseCodexTrustProofArgs } from '../codex-trust-upgrade-proof';

function makeFixture(): CodexHookAbiFixture {
  const keys = [
    'session_start:0:0',
    'user_prompt_submit:0:0',
    'pre_tool_use:0:0',
    'pre_tool_use:1:0',
    'pre_tool_use:2:0',
    'pre_tool_use:2:1',
    'pre_tool_use:3:0',
    'pre_tool_use:4:0',
    'pre_tool_use:5:0',
    'pre_tool_use:6:0',
    'post_tool_use:0:0',
    'post_tool_use:0:1',
    'post_tool_use:1:0',
    'post_tool_use:2:0',
    'subagent_start:0:0',
  ];
  return {
    version: 1,
    entries: keys.map((key, index) => ({ key, currentHash: `${(index + 1).toString(16)}`.padStart(64, '0') })),
  };
}

function makeDist(): { root: string; dispose: () => void } {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-trust-dist-'));
  const root = path.join(owner, 'dist');
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }));
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), '{"hooks":{"SessionStart":[]}}\n');
  fs.writeFileSync(path.join(root, 'scripts', 'hook-runtime.cjs'), "'use strict';\nmodule.exports = {};\n");
  return { root, dispose: () => fs.rmSync(owner, { recursive: true, force: true }) };
}

function hookRows(fixture: CodexHookAbiFixture, status: 'untrusted' | 'trusted' | 'modified'): Array<Record<string, unknown>> {
  return fixture.entries.map((entry, index) => ({
    key: `${CODEX_TRUST_PROOF_PLUGIN_ID}:hooks/hooks.json:${entry.key}`,
    pluginId: CODEX_TRUST_PROOF_PLUGIN_ID,
    enabled: true,
    isManaged: false,
    handlerType: 'command',
    source: 'plugin',
    currentHash: `sha256:${entry.currentHash}`,
    trustStatus: status,
    displayOrder: index,
  }));
}

test('Codex trust proof approves v1 only in the isolated config and proves v2 lifecycle hooks without bypass', async (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-trust-parent-'));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  const fixture = makeFixture();
  const commandCalls: Array<{ command: string; args: string[]; codexHome: string }> = [];
  const installs: Array<{ version: string; hooks: Buffer; runtime: Buffer }> = [];
  let marketplaceRoot = '';

  const commandRunner: ProofCommandRunner = (command, args, options) => {
    commandCalls.push({ command, args: [...args], codexHome: String(options.env.CODEX_HOME) });
    assert.equal(options.env.HOME?.startsWith(tempParent), true);
    assert.equal(options.env.USERPROFILE, options.env.HOME);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.CODEX_ACCESS_TOKEN, undefined);
    assert.equal(args.some((arg) => arg.includes('dangerously-bypass-hook-trust')), false);
    if (args[0] === 'plugin' && args[1] === 'marketplace') marketplaceRoot = args[3]!;
    if (args[0] === 'plugin' && args[1] === 'add') {
      const pluginRoot = path.join(marketplaceRoot, 'plugins', 'traffic-one');
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')) as { version: string };
      installs.push({
        version: manifest.version,
        hooks: fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json')),
        runtime: fs.readFileSync(path.join(pluginRoot, 'scripts', 'hook-runtime.cjs')),
      });
    }
    return { ok: true, out: '' };
  };

  const appServerOptions: CodexProofAppServerOptions[] = [];
  const requests: Array<{ server: number; method: string; params: unknown }> = [];
  let approvalParams: unknown;
  let closeCount = 0;
  const appServerFactory = async (options: CodexProofAppServerOptions): Promise<CodexProofAppServer> => {
    const server = appServerOptions.length;
    appServerOptions.push(options);
    assert.equal(fs.statSync(options.codexHome).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(options.codexHome, 'config.toml')).mode & 0o777, 0o600);
    return {
      async request<T>(method: string, params: unknown): Promise<T> {
        requests.push({ server, method, params });
        if (method === 'hooks/list') {
          return {
            data: [{
              cwd: options.cwd,
              // hooks/list ordering is presentation detail. Positional identity
              // is already encoded in each key and is compared per key.
              hooks: hookRows(fixture, server === 0 ? 'untrusted' : 'trusted').reverse(),
              warnings: [],
              errors: [],
            }],
          } as T;
        }
        if (method === 'config/batchWrite') {
          approvalParams = params;
          return { status: 'ok', version: '1', filePath: path.join(options.codexHome, 'config.toml') } as T;
        }
        if (method === 'thread/start') {
          return { thread: { id: 'thread-proof' } } as T;
        }
        if (method === 'turn/start') {
          fs.appendFileSync(options.markerPath, `${JSON.stringify({ proofVersion: 2, subcommand: 'session-start' })}\n`);
          fs.appendFileSync(options.markerPath, `${JSON.stringify({ proofVersion: 2, subcommand: 'user-prompt-submit' })}\n`);
          return { turn: { id: 'turn-proof' } } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
      async close() { closeCount += 1; },
      stderrTail: () => '',
    };
  };

  const result = await runCodexTrustUpgradeProof({
    distRoot: dist.root,
    codexBin: '/fake/codex',
    tempRootParent: tempParent,
    abiFixture: fixture,
  }, {
    commandRunner,
    appServerFactory,
    materializedV2Probe: (codexHome) => path.join(codexHome, 'plugins', 'cache', 'proof-v2'),
  });

  assert.equal(result.ok, true, result.detail);
  assert.equal(result.beforeTrusted, 0);
  assert.equal(result.afterTrusted, CODEX_TRUST_PROOF_EXPECTED_HOOKS);
  assert.deepEqual(result.observedEvents, ['SessionStart', 'UserPromptSubmit']);
  assert.equal(closeCount, 2);
  assert.equal(appServerOptions.length, 2);
  assert.equal(new Set(commandCalls.map((call) => call.codexHome)).size, 1);
  assert.deepEqual(commandCalls.map((call) => call.args.slice(0, 2)), [
    ['plugin', 'marketplace'],
    ['plugin', 'add'],
    ['plugin', 'add'],
  ]);
  assert.equal(commandCalls.every((call) => call.command === '/fake/codex'), true);
  assert.equal(installs.length, 2);
  assert.notEqual(installs[0]!.version, installs[1]!.version);
  assert.equal(installs[0]!.hooks.equals(installs[1]!.hooks), true);
  assert.equal(installs[0]!.runtime.equals(installs[1]!.runtime), false);

  assert.ok(approvalParams && typeof approvalParams === 'object');
  const approval = approvalParams as {
    edits: Array<{ keyPath: string; value: Record<string, { trusted_hash: string }>; mergeStrategy: string }>;
    reloadUserConfig: boolean;
  };
  assert.equal(approval.reloadUserConfig, true);
  assert.equal(approval.edits.length, 1);
  assert.equal(approval.edits[0]!.keyPath, 'hooks.state');
  assert.equal(approval.edits[0]!.mergeStrategy, 'upsert');
  assert.equal(Object.keys(approval.edits[0]!.value).length, CODEX_TRUST_PROOF_EXPECTED_HOOKS);
  for (const entry of fixture.entries) {
    const key = `${CODEX_TRUST_PROOF_PLUGIN_ID}:hooks/hooks.json:${entry.key}`;
    assert.deepEqual(approval.edits[0]!.value[key], { trusted_hash: `sha256:${entry.currentHash}` });
  }

  const threadParams = requests.find((request) => request.method === 'thread/start')!.params as Record<string, unknown>;
  assert.equal(threadParams.modelProvider, 'traffic-one-trust-proof');
  assert.equal(threadParams.ephemeral, true);
  const turnParams = requests.find((request) => request.method === 'turn/start')!.params as Record<string, unknown>;
  assert.equal(turnParams.threadId, 'thread-proof');
  assert.deepEqual(fs.readdirSync(tempParent), [], 'strict cleanup removes the isolated proof root');
});

test('Codex trust proof child environment allowlists system variables and drops ambient credentials', (t) => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-trust-env-'));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  const codexHome = path.join(owner, 'codex-home');
  fs.mkdirSync(codexHome, { mode: 0o700 });
  const marker = path.join(owner, 'marker.jsonl');
  const env = createIsolatedCodexProofEnv(owner, codexHome, marker, {
    PATH: '/safe/bin',
    LANG: 'C.UTF-8',
    HOME: '/real/home',
    USERPROFILE: 'C:\\real-home',
    CODEX_HOME: '/real/codex-home',
    CODEX_ACCESS_TOKEN: 'real-token',
    CODEX_AUTH: 'real-auth',
    CODEX_API_KEY: 'real-key',
    OPENAI_API_KEY: 'real-openai-key',
    CHATGPT_API_KEY: 'real-chatgpt-key',
    OPENAI_ORGANIZATION: 'real-org',
    OPENAI_PROJECT: 'real-project',
    NODE_OPTIONS: '--require=/real/injection.cjs',
  });

  assert.equal(env.PATH, '/safe/bin');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.CODEX_HOME, codexHome);
  assert.equal(env.HOME, path.join(owner, 'home'));
  assert.equal(env.USERPROFILE, env.HOME);
  for (const key of [
    'CODEX_ACCESS_TOKEN', 'CODEX_AUTH', 'CODEX_API_KEY', 'OPENAI_API_KEY',
    'CHATGPT_API_KEY', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'NODE_OPTIONS',
  ]) assert.equal(env[key], undefined, `${key} must not cross the proof boundary`);
});

test('Codex trust proof fails closed when hooks/list is unavailable and still cleans the isolated home', async (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-trust-fail-'));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  let closed = false;
  let batchWriteCalled = false;

  const result = await runCodexTrustUpgradeProof({
    distRoot: dist.root,
    codexBin: 'codex-fake',
    tempRootParent: tempParent,
    abiFixture: makeFixture(),
  }, {
    commandRunner: () => ({ ok: true, out: '' }),
    materializedV2Probe: (codexHome) => path.join(codexHome, 'plugins', 'cache', 'proof-v2'),
    appServerFactory: async () => ({
      async request<T>(method: string): Promise<T> {
        if (method === 'config/batchWrite') batchWriteCalled = true;
        throw new Error('Codex RPC error -32601: Method not found: hooks/list');
      },
      async close() { closed = true; },
      stderrTail: () => '',
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'list-v1');
  assert.match(result.detail, /Method not found: hooks\/list/);
  assert.equal(batchWriteCalled, false);
  assert.equal(closed, true);
  assert.deepEqual(fs.readdirSync(tempParent), []);
});

test('Codex trust proof rejects changed v2 trust before starting a thread', async (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-trust-modified-'));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  const fixture = makeFixture();
  let factoryCall = 0;
  let threadStarted = false;

  const result = await runCodexTrustUpgradeProof({
    distRoot: dist.root,
    tempRootParent: tempParent,
    abiFixture: fixture,
  }, {
    commandRunner: () => ({ ok: true, out: '' }),
    materializedV2Probe: (codexHome) => path.join(codexHome, 'plugins', 'cache', 'proof-v2'),
    appServerFactory: async (options) => {
      const call = factoryCall++;
      return {
        async request<T>(method: string): Promise<T> {
          if (method === 'hooks/list') {
            return { data: [{ cwd: options.cwd, hooks: hookRows(fixture, call === 0 ? 'untrusted' : 'modified'), warnings: [], errors: [] }] } as T;
          }
          if (method === 'config/batchWrite') return { status: 'ok', filePath: path.join(options.codexHome, 'config.toml') } as T;
          if (method === 'thread/start') threadStarted = true;
          return {} as T;
        },
        async close() {},
        stderrTail: () => '',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'list-v2');
  assert.match(result.detail, /enabled trusted plugin commands/);
  assert.equal(threadStarted, false);
  assert.deepEqual(fs.readdirSync(tempParent), []);
});

test('Codex trust proof rejects lifecycle markers emitted before the tested task boundary', async (t) => {
  const dist = makeDist();
  t.after(dist.dispose);
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-trust-stale-marker-'));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  const fixture = makeFixture();
  let factoryCall = 0;

  const result = await runCodexTrustUpgradeProof({
    distRoot: dist.root,
    tempRootParent: tempParent,
    abiFixture: fixture,
    timeoutMs: 600,
  }, {
    commandRunner: () => ({ ok: true, out: '' }),
    materializedV2Probe: (codexHome) => path.join(codexHome, 'plugins', 'cache', 'proof-v2'),
    appServerFactory: async (options) => {
      const call = factoryCall++;
      return {
        async request<T>(method: string): Promise<T> {
          if (method === 'hooks/list') {
            if (call === 1) {
              fs.appendFileSync(options.markerPath, `${JSON.stringify({ proofVersion: 2, subcommand: 'session-start' })}\n`);
              fs.appendFileSync(options.markerPath, `${JSON.stringify({ proofVersion: 2, subcommand: 'user-prompt-submit' })}\n`);
            }
            return { data: [{ cwd: options.cwd, hooks: hookRows(fixture, call === 0 ? 'untrusted' : 'trusted'), warnings: [], errors: [] }] } as T;
          }
          if (method === 'config/batchWrite') return { status: 'ok', filePath: path.join(options.codexHome, 'config.toml') } as T;
          if (method === 'thread/start') return { thread: { id: 'thread-without-hooks' } } as T;
          if (method === 'turn/start') return { turn: { id: 'turn-without-hooks' } } as T;
          throw new Error(`unexpected method ${method}`);
        },
        async close() {},
        stderrTail: () => '',
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, 'session-start');
  assert.match(result.detail, /did not observe session-start/);
  assert.deepEqual(result.observedEvents, []);
  assert.deepEqual(fs.readdirSync(tempParent), []);
});

test('Codex trust proof pre-gate applies only when Codex E2E is selected', async () => {
  assert.equal(codexTrustUpgradeProofRequired(new Set(['codex'])), true);
  assert.equal(codexTrustUpgradeProofRequired(new Set(['claude', 'cursor'])), false);
  const skipped = await runRequiredCodexTrustUpgradeProof(
    new Set(['claude', 'cursor']),
    { distRoot: '/deliberately-missing-because-proof-must-not-run' },
  );
  assert.equal(skipped, null);
});

test('standalone Codex trust proof entrypoint accepts release-path injections', () => {
  assert.deepEqual(parseCodexTrustProofArgs([
    '--dist-root=/tmp/proof-dist',
    '--codex-bin=/opt/codex-host-owned',
    '--timeout=45000',
  ]), {
    distRoot: '/tmp/proof-dist',
    codexBin: '/opt/codex-host-owned',
    timeoutMs: 45_000,
  });
  assert.throws(() => parseCodexTrustProofArgs(['--timeout=0']), /invalid --timeout/);
});
