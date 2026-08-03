import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openCodeMcpServerEntry } from '../opencode-mcp';

const PLUGIN_ROOT_KEYS = [
  'TRAFFIC_ONE_PLUGIN_ROOT',
  'CURSOR_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
] as const;

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of PLUGIN_ROOT_KEYS) delete env[key];
  delete env.XDG_STATE_HOME;
  return env;
}

test('opencode MCP entry is a shell-free Node stdio bootstrap', () => {
  const entry = openCodeMcpServerEntry(PLUGIN_ROOT_KEYS);
  assert.equal(entry.command, 'node');
  assert.equal(entry.args[0], '-e');
  const launch = entry.args.join(' ');
  assert.doesNotMatch(launch, /\$\{[A-Z][A-Z0-9_]*[:+\-]/);
  assert.doesNotMatch(launch, /\[\s+-f\s+|\bexec\s+node\b|\bsh\s+-[lc]+\b/);
});

test('opencode MCP Node bootstrap prefers the host plugin root and preserves spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-mcp-launch-'));
  const pluginRoot = path.join(dir, 'installed plugin with spaces');
  const foreignCwd = path.join(dir, 'foreign cwd');
  try {
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(foreignCwd, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'opencode-mcp.cjs'), [
      "'use strict';",
      "process.stdout.write(JSON.stringify({source:'direct',root:process.env.TRAFFIC_ONE_PLUGIN_ROOT||''}));",
    ].join('\n'), 'utf8');
    // A real install always carries this; the bootstrap now REQUIRES it so an arbitrary
    // directory that merely contains scripts/opencode-mcp.cjs cannot pose as the plugin.
    fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    const env = cleanEnv(path.join(dir, 'home'));
    env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    const entry = openCodeMcpServerEntry(PLUGIN_ROOT_KEYS);

    const result = spawnSync(entry.command, [...entry.args], {
      cwd: foreignCwd,
      encoding: 'utf8',
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { source: 'direct', root: pluginRoot });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode MCP Node bootstrap falls back to the version-stable state-home shim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-mcp-fallback-'));
  const foreignCwd = path.join(dir, 'foreign cwd');
  const stateRoot = path.join(dir, 'state home with spaces');
  const fallback = path.join(stateRoot, 'traffic-one', 'bin', 'opencode-mcp.cjs');
  try {
    fs.mkdirSync(foreignCwd, { recursive: true });
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, "process.stdout.write(JSON.stringify({source:'stable-fallback'}));\n", 'utf8');
    const env = cleanEnv(path.join(dir, 'home'));
    env.XDG_STATE_HOME = stateRoot;
    const entry = openCodeMcpServerEntry(PLUGIN_ROOT_KEYS);

    const result = spawnSync(entry.command, [...entry.args], {
      cwd: foreignCwd,
      encoding: 'utf8',
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { source: 'stable-fallback' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode MCP bootstrap preserves first-populated root precedence before stable fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-mcp-precedence-'));
  const foreignCwd = path.join(dir, 'foreign cwd');
  const lowerPriorityRoot = path.join(dir, 'lower-priority-plugin');
  const stateRoot = path.join(dir, 'state');
  const fallback = path.join(stateRoot, 'traffic-one', 'bin', 'opencode-mcp.cjs');
  const decoyMarker = path.join(dir, 'decoy-ran');
  try {
    fs.mkdirSync(path.join(foreignCwd, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(lowerPriorityRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    const decoy = `require('fs').writeFileSync(${JSON.stringify(decoyMarker)},'ran','utf8');\n`;
    fs.writeFileSync(path.join(foreignCwd, 'scripts', 'opencode-mcp.cjs'), decoy, 'utf8');
    fs.writeFileSync(path.join(lowerPriorityRoot, 'scripts', 'opencode-mcp.cjs'), decoy, 'utf8');
    fs.writeFileSync(fallback, "process.stdout.write('stable');\n", 'utf8');
    const env = cleanEnv(path.join(dir, 'home'));
    env.TRAFFIC_ONE_PLUGIN_ROOT = path.join(dir, 'missing-high-priority-root');
    env.CLAUDE_PLUGIN_ROOT = lowerPriorityRoot;
    env.XDG_STATE_HOME = stateRoot;
    const entry = openCodeMcpServerEntry(PLUGIN_ROOT_KEYS);

    const result = spawnSync(entry.command, [...entry.args], {
      cwd: foreignCwd,
      encoding: 'utf8',
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'stable');
    assert.equal(fs.existsSync(decoyMarker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// REGRESSION (observed live, cursor-15c): Cursor launches MCP servers with NO
// *_PLUGIN_ROOT and PWD=/, so deriving a root from the cwd let any directory that merely
// contained scripts/opencode-mcp.cjs pose as the plugin. A candidate root is now only
// honoured when it IS the traffic-one package; otherwise the bootstrap falls through to
// the version-stable shim (which resolves the newest install across all hosts).
test('opencode MCP bootstrap refuses a root that is not the traffic-one package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-opencode-mcp-impostor-'));
  const impostor = path.join(dir, 'impostor');
  const stateRoot = path.join(dir, 'state');
  const fallback = path.join(stateRoot, 'traffic-one', 'bin', 'opencode-mcp.cjs');
  const impostorMarker = path.join(dir, 'impostor-ran');
  try {
    fs.mkdirSync(path.join(impostor, 'scripts'), { recursive: true });
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    // Structurally identical to a plugin root, but a DIFFERENT package.
    fs.writeFileSync(
      path.join(impostor, 'scripts', 'opencode-mcp.cjs'),
      `require('fs').writeFileSync(${JSON.stringify(impostorMarker)},'ran','utf8');\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(impostor, 'package.json'),
      JSON.stringify({ name: 'some-user-app', version: '0.1.0' }),
      'utf8',
    );
    fs.writeFileSync(fallback, "process.stdout.write('stable');\n", 'utf8');
    const env = cleanEnv(path.join(dir, 'home'));
    env.CLAUDE_PLUGIN_ROOT = impostor;
    env.XDG_STATE_HOME = stateRoot;
    const entry = openCodeMcpServerEntry(PLUGIN_ROOT_KEYS);

    const result = spawnSync(entry.command, [...entry.args], { cwd: impostor, encoding: 'utf8', env });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'stable', 'a non-traffic-one package must never serve the MCP server');
    assert.equal(fs.existsSync(impostorMarker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
