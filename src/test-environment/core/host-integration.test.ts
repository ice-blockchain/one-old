import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { prepareCaseHostIntegration } from './host-integration';

test('OpenCode and Kilo wrappers install and enable only inside the case XDG homes', () => {
  for (const host of ['opencode', 'kilo'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1-${host}-integration-`));
    const dist = path.join(dir, 'dist');
    const project = path.join(dir, 'project');
    const log = path.join(dir, 'calls.jsonl');
    fs.mkdirSync(path.join(dist, 'scripts'), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(dist, 'scripts', `${host}-host.cjs`), [
      "const fs = require('fs');",
      "fs.appendFileSync(process.env.T1_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, state: process.env.XDG_STATE_HOME }) + '\\n');",
    ].join('\n'), 'utf8');
    const env = {
      T1_TEST_LOG: log,
      XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
      XDG_DATA_HOME: path.join(dir, 'xdg-data'),
      XDG_STATE_HOME: path.join(dir, 'xdg-state'),
    };

    try {
      assert.deepEqual(prepareCaseHostIntegration(host, dist, project, env), { ok: true, prepared: true });
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(calls.map((call) => call.args), [
        ['install', '--yes'],
        ['enable', '--cwd', project, '--yes'],
      ], host);
      for (const call of calls) {
        assert.equal(call.config, env.XDG_CONFIG_HOME, host);
        assert.equal(call.data, env.XDG_DATA_HOME, host);
        assert.equal(call.state, env.XDG_STATE_HOME, host);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('marketplace/desktop hosts need no per-case wrapper mutation', () => {
  assert.deepEqual(prepareCaseHostIntegration('claude', '/missing', '/project', {}), { ok: true, prepared: false });
  assert.deepEqual(prepareCaseHostIntegration('windsurf', '/missing', '/project', {}), { ok: true, prepared: false });
});
