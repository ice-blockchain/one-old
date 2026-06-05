import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { delegate } from '../index';

function sh(cwd: string, cmd: string, args: string[]): void {
  spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'ignore' });
}

// A real git repo (HEAD commit so the worktree sandbox can branch) + sandboxed
// prefs/toolchain root, then a stubbed managed `opencode` binary.
function withRepo(prefs: Record<string, unknown>, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocdel-'));
  const env = process.env;
  const savedPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const savedRoot = env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
  sh(dir, 'git', ['init', '-q']);
  sh(dir, 'git', ['config', 'user.email', 't@example.com']);
  sh(dir, 'git', ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  try {
    fn(dir);
  } finally {
    if (savedPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
    if (savedRoot === undefined) delete env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function stubOpencode(behavior: 'edit' | 'error' | 'noop'): void {
  const bin = path.join(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT || '', 'opencode', 'npm-prefix', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const scripts: Record<string, string> = {
    // emits a text event AND writes a file in its cwd (the worktree)
    edit: `#!/bin/sh
echo '{"type":"text","part":{"type":"text","text":"created foo.txt"}}'
printf 'delegated\\n' > foo.txt
exit 0
`,
    // opencode-style failure: error event, but exit 0 (the real CLI does this)
    error: `#!/bin/sh
echo '{"type":"error","error":{"name":"UnknownError","data":{"message":"boom from gateway"}}}'
exit 0
`,
    // chats but changes nothing
    noop: `#!/bin/sh
echo '{"type":"text","part":{"type":"text","text":"nothing to do"}}'
exit 0
`,
  };
  fs.writeFileSync(path.join(bin, 'opencode'), scripts[behavior], { mode: 0o755 });
}

test('delegate applies a successful run to the working tree + writes a digest', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('edit');
    const r = delegate(dir, { role: 'frontend', task: 'create foo.txt', runId: '2026-01-01T00-00-00Z' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'delegated');
    // change landed in the REAL working tree
    assert.equal(fs.existsSync(path.join(dir, 'foo.txt')), true);
    assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8').trim(), 'delegated');
    assert.ok(r.touched.includes('foo.txt'));
    // digest written in the standard location
    const digest = path.join(dir, '.traffic-one', 'digests', '2026-01-01T00-00-00Z', 'frontend.md');
    assert.equal(r.digest, digest);
    assert.match(fs.readFileSync(digest, 'utf8'), /verdict: DELEGATED_OK/);
    // worktree cleaned up
    assert.equal(spawnSync('git', ['-C', dir, 'worktree', 'list'], { encoding: 'utf8' }).stdout.trim().split('\n').length, 1);
  });
});

test('delegate fails closed on an opencode error event — working tree untouched (→ fallback)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('error');
    const r = delegate(dir, { role: 'frontend', task: 'do it', runId: 'r1' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /boom from gateway/);
    assert.equal(fs.existsSync(path.join(dir, 'foo.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', 'r1')), false);
  });
});

test('delegate returns no-changes when opencode edits nothing (→ fallback)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('noop');
    const r = delegate(dir, { task: 'no-op', runId: 'r1' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'no-changes');
  });
});

test('delegate is skipped when OpenCode is not enabled (→ fallback)', () => {
  withRepo({ openCode: { enabled: false } }, (dir) => {
    stubOpencode('edit');
    const r = delegate(dir, { task: 'create foo.txt' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'skipped');
    assert.match(r.error || '', /not enabled/);
    assert.equal(fs.existsSync(path.join(dir, 'foo.txt')), false);
  });
});
