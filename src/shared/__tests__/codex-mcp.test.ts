import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  codexConfigPath,
  codexStablePluginRoot,
  ensureCodexMcpServerRegistered,
  ensureCodexOneMcpServerRegistered,
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
    assert.match(cfg, /\[mcp_servers\.opencode-worker\]/);
    assert.match(cfg, /command = "sh"/);
    assert.match(cfg, /exec node/);
    // points at the version-stable marketplace SOURCE, never the version cache
    assert.match(cfg, /local-marketplaces\/traffic-one-local\/plugins\/traffic-one\/scripts\/opencode-mcp\.cjs/);
    assert.doesNotMatch(cfg, /plugins\/cache/);
    // idempotent: a second call leaves the file byte-identical
    assert.equal(ensureCodexMcpServerRegistered(env), 'already-present');
    assert.equal(fs.readFileSync(codexConfigPath(env), 'utf8'), cfg);
  });
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
    assert.match(cfg, /\[mcp_servers\.opencode-worker\]/);
    assert.match(cfg, /local-marketplaces\/traffic-one-local\/plugins\/traffic-one\/scripts\/opencode-mcp\.cjs/);
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

test('Codex One MCP removal restores surrounding bytes and honors endpoint overrides', () => {
  withCodexHome((_home, env) => {
    env.TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT = 'https://edge.example.test/public-mcp';
    const cfgPath = codexConfigPath(env);
    fs.writeFileSync(cfgPath, '# before\nmodel = "gpt-5"\n', 'utf8');
    assert.equal(ensureCodexOneMcpServerRegistered(env), 'registered');
    assert.match(fs.readFileSync(cfgPath, 'utf8'), /edge\.example\.test/);
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
