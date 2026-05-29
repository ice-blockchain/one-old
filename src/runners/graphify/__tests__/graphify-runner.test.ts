import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { bootstrap } from '../index';

function withProject(fn: (cwd: string, prefs: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gfboot-'));
  const saved = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prefs = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
  try {
    fn(dir, prefs);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('graphify bootstrap honours the graphifyAutoRun:false opt-out', () => {
  withProject((cwd, prefs) => {
    fs.writeFileSync(prefs, JSON.stringify({ graphifyAutoRun: false }), 'utf8');
    const r = bootstrap(cwd);
    assert.equal(r.ok, false);
    assert.equal(r.action, 'install-skipped');
    assert.match(r.error || '', /graphifyAutoRun is false/);
  });
});

test('graphify bootstrap short-circuits on a fresh GRAPH_REPORT.md', () => {
  withProject((cwd) => {
    fs.mkdirSync(path.join(cwd, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'), '# graph\n', 'utf8');
    const r = bootstrap(cwd);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'fresh');
    assert.ok(r.report?.endsWith(path.join('graphify-out', 'GRAPH_REPORT.md')));
  });
});

test('graphify bootstrap returns install-skipped when graphify is absent + skipInstall', () => {
  withProject((cwd) => {
    // Force the "not on PATH" branch deterministically by pointing PATH at an
    // empty dir, so which('graphify') fails regardless of the host machine.
    const savedPath = process.env.PATH;
    process.env.PATH = path.join(cwd, 'empty-bin');
    try {
      const r = bootstrap(cwd, { skipInstall: true });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'install-skipped');
      assert.match(r.error || '', /not on PATH and skipInstall=true/);
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});
