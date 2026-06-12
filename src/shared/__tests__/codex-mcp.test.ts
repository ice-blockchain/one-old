import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codexConfigPath, codexStablePluginRoot, ensureCodexMcpServerRegistered } from '../codex-mcp';

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
