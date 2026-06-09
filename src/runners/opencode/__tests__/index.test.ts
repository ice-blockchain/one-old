import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { delegate, delegateFromPlan, parsePlanDelegationQueue } from '../index';

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
  const savedPwd = env.PWD;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed');
  // Mirror production: the caller's PWD is the project root (`dir`), not the
  // worktree. The real `opencode run` resolves its working dir from PWD, so the
  // runner MUST repoint PWD (+ --dir) at the worktree; if it regresses, the
  // PWD-honoring stub below writes into `dir` instead of the sandbox and the
  // success test fails. (See the --dir/PWD pinning in delegate().)
  env.PWD = dir;
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
    if (savedPwd === undefined) delete env.PWD; else env.PWD = savedPwd;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function stubOpencode(behavior: 'edit' | 'error' | 'noop' | 'retry' | 'multi'): void {
  const bin = path.join(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT || '', 'opencode', 'npm-prefix', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const scripts: Record<typeof behavior, string> = {
    // emits a text event AND writes a file. A NODE stub (not /bin/sh): the real
    // opencode resolves its working dir from the --dir flag / process.env.PWD and
    // does NOT normalize PWD to the actual cwd the way a shell does. So this only
    // lands in the worktree when delegate() pins --dir/PWD at the sandbox; if that
    // regresses, it writes into the project dir and the success test fails. Do not
    // port this back to a shell stub or a bare cwd write — that silently defeats
    // the regression guard for the PWD/--dir sandbox-escape bug.
    edit: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'created foo.txt' } }) + '\\n');
fs.writeFileSync(path.join(dir, 'foo.txt'), 'delegated\\n');
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
    // non-deterministic: no-op on attempt 1, edits on attempt 2 (counter file next
    // to the stub survives the worktree reset). Exercises the bounded free retry.
    retry: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
const counter = path.join(__dirname, 'attempts');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) || 0 : 0) + 1;
fs.writeFileSync(counter, String(n));
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'attempt ' + n } }) + '\\n');
if (n >= 2) fs.writeFileSync(path.join(dir, 'foo.txt'), 'delegated\\n');
`,
    // writes a UNIQUE file per invocation (counter) so multiple queued plan units
    // produce disjoint diffs that all apply cleanly.
    multi: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
const counter = path.join(__dirname, 'plan-attempts');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) || 0 : 0) + 1;
fs.writeFileSync(counter, String(n));
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'unit ' + n } }) + '\\n');
fs.writeFileSync(path.join(dir, 'unit-' + n + '.txt'), 'u' + n + '\\n');
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

test('delegate retries once on a no-op and applies the second attempt (free model is non-deterministic)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('retry'); // attempt 1 chats only, attempt 2 writes foo.txt
    const r = delegate(dir, { role: 'frontend', task: 'create foo.txt', runId: 'retry-1' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'delegated');
    assert.ok(r.touched.includes('foo.txt'));
    assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8').trim(), 'delegated');
    // exactly 2 attempts were made (bounded retry, not a loop)
    const attempts = path.join(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT || '', 'opencode', 'npm-prefix', 'bin', 'attempts');
    assert.equal(fs.readFileSync(attempts, 'utf8').trim(), '2');
  });
});

test('parsePlanDelegationQueue extracts only the marked queue block', () => {
  const plan = [
    '# Plan', 'prose',
    '<!-- opencode-delegate:start -->',
    '- role: backend | files: src/seed.ts | task: Create dummy seed data',
    '- role: frontend | task: Boilerplate card component',
    '- not a unit line (ignored)',
    '<!-- opencode-delegate:end -->',
    '- role: architect | task: outside the block — must be ignored',
  ].join('\n');
  const q = parsePlanDelegationQueue(plan);
  assert.equal(q.length, 2);
  assert.equal(q[0]?.role, 'backend');
  assert.equal(q[0]?.files, 'src/seed.ts');
  assert.equal(q[1]?.role, 'frontend');
  assert.equal(q[1]?.task, 'Boilerplate card component');
  assert.deepEqual(parsePlanDelegationQueue('# plan with no queue'), []);
});

test('delegateFromPlan deterministically delegates every queued bounded unit', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- role: backend | files: a | task: make unit A',
      '- role: frontend | files: b | task: make unit B',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'plan-1' });
    assert.equal(r.total, 2);
    assert.equal(r.delegated, 2);
    assert.equal(r.units.every((u) => u.action === 'delegated'), true);
    // both units' disjoint diffs landed in the real working tree
    assert.equal(fs.existsSync(path.join(dir, 'unit-1.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'unit-2.txt')), true);
  });
});

test('delegateFromPlan is a no-op when the plan has no delegation queue', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), '# Plan\nno queue here\n', 'utf8');
    const r = delegateFromPlan(dir, { runId: 'plan-2' });
    assert.equal(r.total, 0);
    assert.equal(r.delegated, 0);
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
