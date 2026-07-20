import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { runOneMcpHostCommand } from '../index';

test('one-mcp host maintenance requires consent and safely uninstalls its Codex block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-host-'));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  try {
    assert.equal(runOneMcpHostCommand(['install'], env).code, 2);
    assert.equal(runOneMcpHostCommand(['install', '--yes'], env, true).code, 0);
    const config = path.join(home, 'config.toml');
    assert.match(fs.readFileSync(config, 'utf8'), /enabled = false/);
    assert.equal(runOneMcpHostCommand(['uninstall'], env).code, 2);
    assert.equal(runOneMcpHostCommand(['uninstall', '--yes'], env).code, 0);
    assert.doesNotMatch(fs.readFileSync(config, 'utf8'), /traffic-one managed public MCP/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('one-mcp host maintenance refuses to remove a modified block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-host-'));
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;
  try {
    assert.equal(runOneMcpHostCommand(['install', '--yes'], env, true).code, 0);
    const config = path.join(home, 'config.toml');
    const edited = fs.readFileSync(config, 'utf8').replace('enabled = false', 'enabled = true');
    fs.writeFileSync(config, edited, 'utf8');
    const result = runOneMcpHostCommand(['uninstall', '--yes'], env);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /modified/);
    assert.equal(fs.readFileSync(config, 'utf8'), edited);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('one-mcp host maintenance honors the central registration switch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-host-'));
  const env = {
    CODEX_HOME: home,
    TRAFFIC_ONE_DISABLE_ONE_MCP_REGISTRATION: '1',
  } as NodeJS.ProcessEnv;
  try {
    const result = runOneMcpHostCommand(['install', '--yes'], env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /skipped-disabled/);
    assert.equal(fs.existsSync(path.join(home, 'config.toml')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
