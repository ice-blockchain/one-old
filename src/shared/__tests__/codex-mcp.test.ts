import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  codexConfigPath,
  codexMcpServerBlock,
  codexStablePluginRoot,
  ensureCodexMcpServerRegistered,
  ensureCodexOneMcpServerRegistered,
  removeCodexMcpServerRegistration,
  removeCodexOneMcpServerRegistration,
} from '../codex-mcp';

// Simulate the Codex marketplace cache layout for CODEX_PLUGIN_ROOT so detectHost
// returns 'codex' and the stable-path derivation has something to chew on.
function withCodexHome(fn: (home: string, env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codexmcp-'));
  try {
    const cacheRoot = path.join(dir, 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '2.9.109');
    fn(dir, { CODEX_HOME: dir, CODEX_PLUGIN_ROOT: cacheRoot } as NodeJS.ProcessEnv);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRegistrationChild(home: string): string {
  const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'src', 'shared', 'codex-mcp.ts')).href;
  const scriptFile = path.join(home, 'codex-mcp-registration-child.mts');
  fs.writeFileSync(scriptFile, `
    const m = await import(${JSON.stringify(moduleUrl)});
    const fn = process.env.TRAFFIC_ONE_TEST_REGISTRATION_FN;
    process.stdout.write(m[fn](process.env));
  `, 'utf8');
  return scriptFile;
}

function runRegistrationChild(
  scriptFile: string,
  functionName: 'ensureCodexMcpServerRegistered' | 'ensureCodexOneMcpServerRegistered',
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptFile], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, TRAFFIC_ONE_TEST_REGISTRATION_FN: functionName },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}

test('codexStablePluginRoot derives the version-stable marketplace source from the cache path', () => {
  withCodexHome((home, env) => {
    assert.equal(
      codexStablePluginRoot(env),
      path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one'),
    );
  });
  // Unknown layout → fall back to the given root.
  assert.equal(codexStablePluginRoot({ CODEX_PLUGIN_ROOT: '/opt/plugin' } as NodeJS.ProcessEnv), '/opt/plugin');
});

test('codexStablePluginRoot discovers the local marketplace install in Codex Desktop without plugin-root env', () => {
  withCodexHome((home, env) => {
    const root = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'opencode-mcp.cjs'), '#!/usr/bin/env node\n', 'utf8');
    delete env.CODEX_PLUGIN_ROOT;
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';
    assert.equal(codexStablePluginRoot(env), root);
  });
});

test('ensureCodexMcpServerRegistered writes the [mcp_servers.opencode-worker] block at the STABLE path (idempotent)', () => {
  withCodexHome((home, env) => {
    assert.equal(ensureCodexMcpServerRegistered(env), 'registered');
    const cfg = fs.readFileSync(codexConfigPath(env), 'utf8');
    const stableServer = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one', 'scripts', 'opencode-mcp.cjs');
    assert.match(cfg, /\[mcp_servers\.opencode-worker\]/);
    assert.ok(cfg.includes(`command = ${JSON.stringify(process.execPath)}`));
    assert.ok(cfg.includes(`args = [${JSON.stringify(stableServer)}]`));
    assert.doesNotMatch(cfg, /command = "sh"|"-lc"|exec node/);
    assert.match(cfg, /# >>> traffic-one managed opencode-worker MCP/);
    // points at the version-stable marketplace SOURCE, never the version cache
    assert.ok(cfg.includes(JSON.stringify(stableServer)));
    assert.equal(cfg.includes(JSON.stringify(env.CODEX_PLUGIN_ROOT)), false);
    // idempotent: a second call leaves the file byte-identical
    assert.equal(ensureCodexMcpServerRegistered(env), 'already-present');
    assert.equal(fs.readFileSync(codexConfigPath(env), 'utf8'), cfg);
  });
});

test('codex MCP block encodes Windows paths without a shell wrapper', () => {
  const serverPath = 'C:\\Users\\Ada Lovelace\\Traffic "One"\\scripts\\opencode-mcp.cjs';
  const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
  const block = codexMcpServerBlock(serverPath, nodePath);
  assert.ok(block.includes(`command = ${JSON.stringify(nodePath)}`));
  assert.ok(block.includes(`args = [${JSON.stringify(serverPath)}]`));
  assert.doesNotMatch(block, /command = "sh"|"-lc"|exec node|\$\{/);
});

test('codex MCP block launches the server directly with spaces preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-mcp-launch-'));
  const serverPath = path.join(dir, 'plugin with spaces', 'scripts', 'opencode-mcp.cjs');
  try {
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
    fs.writeFileSync(serverPath, "process.stdout.write(JSON.stringify({argv:process.argv.slice(2)}));\n", 'utf8');
    const block = codexMcpServerBlock(serverPath);
    const commandLine = block.split('\n').find((line) => line.startsWith('command = '));
    const argsLine = block.split('\n').find((line) => line.startsWith('args = '));
    assert.ok(commandLine && argsLine);
    const command = JSON.parse(commandLine.slice('command = '.length)) as string;
    const args = JSON.parse(argsLine.slice('args = '.length)) as string[];

    const result = spawnSync(command, args, { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { argv: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexMcpServerRegistered migrates only the exact legacy Traffic One shell block', () => {
  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    const serverPath = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one', 'scripts', 'opencode-mcp.cjs');
    const shellQuoted = `'${serverPath.replace(/'/g, `'\\''`)}'`;
    const tomlEscaped = `exec node ${shellQuoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const prefix = '# user config remains byte-identical\nmodel = "gpt-5"\n';
    const legacy = [
      '',
      '[mcp_servers.opencode-worker]',
      'command = "sh"',
      `args = ["-lc", "${tomlEscaped}"]`,
      'startup_timeout_sec = 120',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, prefix + legacy, 'utf8');

    assert.equal(ensureCodexMcpServerRegistered(env), 'registered');
    const migrated = fs.readFileSync(cfgPath, 'utf8');
    assert.ok(migrated.startsWith(prefix));
    assert.ok(migrated.includes(`command = ${JSON.stringify(process.execPath)}`));
    assert.ok(migrated.includes(`args = [${JSON.stringify(serverPath)}]`));
    assert.doesNotMatch(migrated, /command = "sh"|"-lc"|exec node/);
    assert.match(migrated, /# >>> traffic-one managed opencode-worker MCP/);
  });

  withCodexHome((_home, env) => {
    const cfgPath = codexConfigPath(env);
    const userOwned = '[mcp_servers.opencode-worker]\ncommand = "sh"\nargs = ["-lc", "custom-server"]\n';
    fs.writeFileSync(cfgPath, userOwned, 'utf8');
    assert.equal(ensureCodexMcpServerRegistered(env), 'already-present');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), userOwned);
  });

  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    const serverPath = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one', 'scripts', 'opencode-mcp.cjs');
    const priorPortableBlock = [
      '',
      '[mcp_servers.opencode-worker]',
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      'startup_timeout_sec = 120',
      '',
    ].join('\n');
    fs.writeFileSync(cfgPath, priorPortableBlock, 'utf8');
    assert.equal(ensureCodexMcpServerRegistered(env), 'registered');
    const migrated = fs.readFileSync(cfgPath, 'utf8');
    assert.ok(migrated.includes(`command = ${JSON.stringify(process.execPath)}`));
    assert.match(migrated, /# >>> traffic-one managed opencode-worker MCP/);
  });
});

test('ensureCodexMcpServerRegistered refreshes only its marked block when the Node path changes', () => {
  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    const serverPath = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one', 'scripts', 'opencode-mcp.cjs');
    const oldNodePath = path.join(home, 'Old Node Runtime', 'node');
    const newNodePath = path.join(home, 'New Node Runtime', 'node');
    const prefix = '# user bytes stay untouched\nmodel = "gpt-5"\n';
    fs.writeFileSync(cfgPath, prefix + codexMcpServerBlock(serverPath, oldNodePath), 'utf8');

    assert.equal(ensureCodexMcpServerRegistered(env, newNodePath), 'registered');
    const refreshed = fs.readFileSync(cfgPath, 'utf8');
    assert.equal(refreshed, prefix + codexMcpServerBlock(serverPath, newNodePath));
    assert.equal(ensureCodexMcpServerRegistered(env, newNodePath), 'already-present');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), refreshed);
  });
});

test('ensureCodexMcpServerRegistered preserves every valid user-owned same-name TOML form', () => {
  const declarations = [
    '[mcp_servers]\nopencode-worker = { command = "custom" }\n',
    'mcp_servers.opencode-worker = { command = "custom" }\n',
    '["mcp_servers"."opencode-worker"]\ncommand = "custom"\n',
    '["mcp_servers"]\n"opencode-worker" = { command = "custom" }\n',
    'mcp_servers = { opencode-worker = { command = "custom" } }\n',
  ];
  for (const userOwned of declarations) {
    withCodexHome((_home, env) => {
      const cfgPath = codexConfigPath(env);
      fs.writeFileSync(cfgPath, userOwned, 'utf8');
      assert.equal(ensureCodexMcpServerRegistered(env), 'already-present', userOwned);
      assert.equal(fs.readFileSync(cfgPath, 'utf8'), userOwned);
    });
  }
});

test('ensureCodexMcpServerRegistered serializes concurrent cold registrations', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codexmcp-worker-race-'));
  try {
    const scriptFile = writeRegistrationChild(home);
    const cacheRoot = path.join(home, 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '2.9.109');
    const env = {
      CODEX_HOME: home,
      CODEX_PLUGIN_ROOT: cacheRoot,
      TRAFFIC_ONE_HOST: 'codex',
    } as NodeJS.ProcessEnv;
    const results = await Promise.all(Array.from({ length: 8 }, () => (
      runRegistrationChild(scriptFile, 'ensureCodexMcpServerRegistered', env)
    )));
    assert.equal(results.filter((value) => value === 'registered').length, 1);
    assert.ok(results.every((value) => value === 'registered' || value === 'already-present'));
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.equal((config.match(/\[mcp_servers\.opencode-worker\]/g) || []).length, 1);
    assert.equal((config.match(/# >>> traffic-one managed opencode-worker MCP/g) || []).length, 1);
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.includes('traffic-one-mcp.lock')), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('legacy worker migration and concurrent public registration preserve both config edits', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codexmcp-mixed-race-'));
  try {
    const scriptFile = writeRegistrationChild(home);
    const cacheRoot = path.join(home, 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '2.9.109');
    const stableServer = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one', 'scripts', 'opencode-mcp.cjs');
    const shellQuoted = `'${stableServer.replace(/'/g, `'\\''`)}'`;
    const tomlEscaped = `exec node ${shellQuoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const prefix = '# user config remains byte-identical\nmodel = "gpt-5"\n';
    const legacy = [
      '',
      '[mcp_servers.opencode-worker]',
      'command = "sh"',
      `args = ["-lc", "${tomlEscaped}"]`,
      'startup_timeout_sec = 120',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(home, 'config.toml'), prefix + legacy, 'utf8');
    const env = {
      CODEX_HOME: home,
      CODEX_PLUGIN_ROOT: cacheRoot,
      TRAFFIC_ONE_HOST: 'codex',
    } as NodeJS.ProcessEnv;

    const results = await Promise.all([
      runRegistrationChild(scriptFile, 'ensureCodexMcpServerRegistered', env),
      runRegistrationChild(scriptFile, 'ensureCodexOneMcpServerRegistered', env),
    ]);
    assert.ok(results.every((value) => value === 'registered' || value === 'already-present'));
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.ok(config.startsWith(prefix));
    assert.equal((config.match(/\[mcp_servers\.opencode-worker\]/g) || []).length, 1);
    assert.equal((config.match(/\[mcp_servers\.traffic-one-mcp\]/g) || []).length, 1);
    assert.match(config, /# >>> traffic-one managed opencode-worker MCP/);
    assert.match(config, /# >>> traffic-one managed public MCP \(disabled\)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ensureCodexMcpServerRegistered works in Codex Desktop when no plugin-root env is set', () => {
  withCodexHome((home, env) => {
    const root = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'opencode-mcp.cjs'), '#!/usr/bin/env node\n', 'utf8');
    delete env.CODEX_PLUGIN_ROOT;
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';

    assert.equal(ensureCodexMcpServerRegistered(env), 'registered');
    const cfg = fs.readFileSync(codexConfigPath(env), 'utf8');
    const stableServer = path.join(root, 'scripts', 'opencode-mcp.cjs');
    assert.match(cfg, /\[mcp_servers\.opencode-worker\]/);
    assert.ok(cfg.includes(`args = [${JSON.stringify(stableServer)}]`));
  });
});

test('ensureCodexMcpServerRegistered appends without clobbering existing config.toml', () => {
  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, '[mcp_servers.node_repl]\ncommand = "x"\n', 'utf8');
    assert.equal(ensureCodexMcpServerRegistered(env), 'registered');
    const cfg = fs.readFileSync(cfgPath, 'utf8');
    assert.match(cfg, /\[mcp_servers\.node_repl\]/); // preserved
    assert.match(cfg, /\[mcp_servers\.opencode-worker\]/); // added
  });
});

test('ensureCodexMcpServerRegistered is a no-op off Codex (no config.toml touched)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codexmcp-noncodex-'));
  try {
    // No CODEX_* markers → detectHost falls to 'claude'.
    const env = { CODEX_HOME: dir, CLAUDE_PLUGIN_ROOT: '/x' } as NodeJS.ProcessEnv;
    assert.equal(ensureCodexMcpServerRegistered(env), 'skipped-not-codex');
    assert.equal(fs.existsSync(path.join(dir, 'config.toml')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureCodexOneMcpServerRegistered appends an inert public block without rewriting existing bytes', () => {
  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    const prefix = '# user config stays byte-for-byte\nmodel = "gpt-5"\n';
    fs.writeFileSync(cfgPath, prefix, 'utf8');
    assert.equal(ensureCodexOneMcpServerRegistered(env), 'registered');
    const once = fs.readFileSync(cfgPath, 'utf8');
    assert.ok(once.startsWith(prefix));
    assert.match(once, /\[mcp_servers\.traffic-one-mcp\]/);
    assert.match(once, /enabled = false/);
    assert.match(once, /disabled_tools = \["get_config","report_codebase_metadata"\]/);
    assert.equal(ensureCodexOneMcpServerRegistered(env), 'already-present');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), once);
  });
});

test('ensureCodexOneMcpServerRegistered preserves an existing same-name user table', () => {
  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    const userOwned = '[mcp_servers."traffic-one-mcp"]\nurl = "https://user.example/mcp"\nenabled = true\n';
    fs.writeFileSync(cfgPath, userOwned, 'utf8');
    assert.equal(ensureCodexOneMcpServerRegistered(env), 'already-present');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), userOwned);
  });
});

test('ensureCodexOneMcpServerRegistered preserves inline, dotted, parent-table, and quoted declarations', () => {
  const declarations = [
    '[mcp_servers]\ntraffic-one-mcp = { url = "https://user.example/mcp", enabled = true }\n',
    'mcp_servers.traffic-one-mcp = { url = "https://user.example/mcp", enabled = true }\n',
    '["mcp_servers"."traffic-one-mcp"]\nurl = "https://user.example/mcp"\n',
    '["mcp_servers"]\n"traffic-one-mcp" = { url = "https://user.example/mcp" }\n',
    'mcp_servers = { traffic-one-mcp = { url = "https://user.example/mcp" } }\n',
  ];
  for (const userOwned of declarations) {
    withCodexHome((_home, env) => {
      const cfgPath = codexConfigPath(env);
      fs.writeFileSync(cfgPath, userOwned, 'utf8');
      assert.equal(ensureCodexOneMcpServerRegistered(env), 'already-present', userOwned);
      assert.equal(fs.readFileSync(cfgPath, 'utf8'), userOwned);
    });
  }
});

test('ensureCodexOneMcpServerRegistered serializes concurrent cold-session appends', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codexmcp-race-'));
  try {
    const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'src', 'shared', 'codex-mcp.ts')).href;
    const script = `
      const { ensureCodexOneMcpServerRegistered } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(ensureCodexOneMcpServerRegistered(process.env));
    `;
    // Node <23 cannot expose a tsx-transpiled .ts module's exports from an
    // `--eval --input-type=module` entry (native type-strip only lands in Node 23).
    // A real .mts entry transpiles via `--import tsx` exactly like every test module.
    const scriptFile = path.join(home, 'codex-mcp-child.mts');
    fs.writeFileSync(scriptFile, script, 'utf8');
    const run = (): Promise<string> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', scriptFile], {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: home, TRAFFIC_ONE_HOST: 'codex' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`child exited ${code}: ${stderr}`));
      });
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => run()));
    assert.equal(results.filter((value) => value === 'registered').length, 1);
    assert.ok(results.every((value) => value === 'registered' || value === 'already-present'));
    const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.equal((config.match(/\[mcp_servers\.traffic-one-mcp\]/g) || []).length, 1);
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.includes('traffic-one-mcp.lock')), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Codex MCP registration recovers an old empty lock left by an interrupted release', () => {
  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    const lockDir = `${cfgPath}.traffic-one-mcp.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const abandonedAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, abandonedAt, abandonedAt);

    assert.equal(ensureCodexOneMcpServerRegistered(env), 'registered');
    assert.equal(fs.existsSync(lockDir), false);
    assert.deepEqual(
      fs.readdirSync(home).filter((name) => name.endsWith('.released')),
      [],
    );
  });
});

test('Codex One MCP removal restores surrounding bytes for the fixed endpoint', () => {
  withCodexHome((_home, env) => {
    const cfgPath = codexConfigPath(env);
    fs.writeFileSync(cfgPath, '# before\nmodel = "gpt-5"\n', 'utf8');
    assert.equal(ensureCodexOneMcpServerRegistered(env), 'registered');
    assert.match(fs.readFileSync(cfgPath, 'utf8'), /supabase\.co/);
    assert.equal(removeCodexOneMcpServerRegistration(env), 'removed');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), '# before\nmodel = "gpt-5"\n');
    assert.equal(removeCodexOneMcpServerRegistration(env), 'absent');
  });
});

test('Codex One MCP removal leaves edited and user-owned blocks byte-identical', () => {
  withCodexHome((_home, env) => {
    const cfgPath = codexConfigPath(env);
    assert.equal(ensureCodexOneMcpServerRegistered(env), 'registered');
    const edited = fs.readFileSync(cfgPath, 'utf8').replace('tool_timeout_sec = 60', 'tool_timeout_sec = 61');
    fs.writeFileSync(cfgPath, edited, 'utf8');
    assert.equal(removeCodexOneMcpServerRegistration(env), 'modified');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), edited);

    const userOwned = '[mcp_servers.traffic-one-mcp]\nurl = "https://user.example/mcp"\n';
    fs.writeFileSync(cfgPath, userOwned, 'utf8');
    assert.equal(removeCodexOneMcpServerRegistration(env), 'absent');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), userOwned);
  });
});

test('Codex opencode-worker MCP removal slices the unique BEGIN..END span', () => {
  withCodexHome((home, env) => {
    const cfgPath = codexConfigPath(env);
    const prefix = '# before\nmodel = "gpt-5"\n';
    const suffix = '# after\n';
    const foreignNode = path.join(home, 'other-runtime', 'node');
    const serverPath = path.join(home, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one', 'scripts', 'opencode-mcp.cjs');
    // Inner bytes need not match this process's execPath — the unique markers
    // are the ownership proof (SessionStart refreshes the Node path in place).
    fs.writeFileSync(cfgPath, prefix + codexMcpServerBlock(serverPath, foreignNode) + suffix, 'utf8');
    assert.equal(removeCodexMcpServerRegistration(env), 'removed');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), prefix + suffix);
    assert.equal(removeCodexMcpServerRegistration(env), 'absent');
  });
});

test('Codex opencode-worker MCP removal leaves unmarked and non-unique marked tables', () => {
  withCodexHome((_home, env) => {
    const cfgPath = codexConfigPath(env);
    const userOwned = '[mcp_servers.opencode-worker]\ncommand = "custom"\n';
    fs.writeFileSync(cfgPath, userOwned, 'utf8');
    assert.equal(removeCodexMcpServerRegistration(env), 'absent');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), userOwned);

    const unmatched = '# >>> traffic-one managed opencode-worker MCP\n[mcp_servers.opencode-worker]\ncommand = "x"\n';
    fs.writeFileSync(cfgPath, unmatched, 'utf8');
    assert.equal(removeCodexMcpServerRegistration(env), 'modified');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), unmatched);

    const serverPath = '/opt/traffic-one/scripts/opencode-mcp.cjs';
    const once = codexMcpServerBlock(serverPath);
    const duplicated = `${once}${once}`;
    fs.writeFileSync(cfgPath, duplicated, 'utf8');
    assert.equal(removeCodexMcpServerRegistration(env), 'modified');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), duplicated);
  });
});

test('Codex public and opencode-worker removers each leave the other block', () => {
  withCodexHome((_home, env) => {
    const cfgPath = codexConfigPath(env);
    assert.equal(ensureCodexMcpServerRegistered(env), 'registered');
    assert.equal(ensureCodexOneMcpServerRegistered(env), 'registered');
    const both = fs.readFileSync(cfgPath, 'utf8');
    assert.match(both, /# >>> traffic-one managed opencode-worker MCP/);
    assert.match(both, /# >>> traffic-one managed public MCP \(disabled\)/);

    assert.equal(removeCodexOneMcpServerRegistration(env), 'removed');
    const afterPublic = fs.readFileSync(cfgPath, 'utf8');
    assert.match(afterPublic, /# >>> traffic-one managed opencode-worker MCP/);
    assert.doesNotMatch(afterPublic, /# >>> traffic-one managed public MCP \(disabled\)/);

    assert.equal(removeCodexMcpServerRegistration(env), 'removed');
    const afterWorker = fs.readFileSync(cfgPath, 'utf8');
    assert.doesNotMatch(afterWorker, /# >>> traffic-one managed opencode-worker MCP/);
    assert.doesNotMatch(afterWorker, /# >>> traffic-one managed public MCP \(disabled\)/);
  });
});
