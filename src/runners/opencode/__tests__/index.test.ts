import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { delegate, delegateFromPlan, parsePlanDelegationQueue, resetOpenCodeModelMemo } from '../index';
import { OPENCODE_FREE_MODELS } from '../../../config/opencode';

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
  // success test fails. (See the --dir/PWD pinning in runModel().)
  env.PWD = dir;
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
  sh(dir, 'git', ['init', '-q']);
  sh(dir, 'git', ['config', 'user.email', 't@example.com']);
  sh(dir, 'git', ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  // The free-model chain memo is module-level process state — reset so every
  // test starts at the head of the chain regardless of execution order.
  resetOpenCodeModelMemo();
  try {
    fn(dir);
  } finally {
    if (savedPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
    if (savedRoot === undefined) delete env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
    if (savedPwd === undefined) delete env.PWD; else env.PWD = savedPwd;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type StubBehavior = 'edit' | 'error' | 'noop' | 'retry' | 'multi' | 'model' | 'chain' | 'neterr' | 'modelerr' | 'env' | 'commit';

function stubOpencode(behavior: StubBehavior): string {
  const bin = path.join(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT || '', 'opencode', 'npm-prefix', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const scripts: Record<StubBehavior, string> = {
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
    // echoes the resolved -m model into model.txt so the test can assert which
    // model delegate() picked.
    model: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv;
const dir = a.indexOf('--dir') >= 0 ? a[a.indexOf('--dir') + 1] : process.env.PWD;
const model = a.indexOf('-m') >= 0 ? a[a.indexOf('-m') + 1] : '(none)';
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'model ' + model } }) + '\\n');
fs.writeFileSync(path.join(dir, 'model.txt'), model + '\\n');
`,
    // gateway behavior when a promo model was RETIRED: model-class error for the
    // first chain entry, success for any other model. Appends every -m it sees
    // to models-seen (next to the stub) so tests can assert the walk order. A
    // UNIQUE file per successful invocation (oc-<n>.txt) so back-to-back
    // delegations in one repo produce disjoint diffs that all apply cleanly.
    chain: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv;
const dir = a.indexOf('--dir') >= 0 ? a[a.indexOf('--dir') + 1] : process.env.PWD;
const model = a.indexOf('-m') >= 0 ? a[a.indexOf('-m') + 1] : '(none)';
fs.appendFileSync(path.join(__dirname, 'models-seen'), model + '\\n');
if (model === ${JSON.stringify(OPENCODE_FREE_MODELS[0])}) {
  process.stdout.write(JSON.stringify({ type: 'error', error: { name: 'ProviderModelNotFoundError', data: { message: 'Model not found: ' + model } } }) + '\\n');
  process.exit(0);
}
const counter = path.join(__dirname, 'chain-wins');
const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) || 0 : 0) + 1;
fs.writeFileSync(counter, String(n));
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'model ' + model } }) + '\\n');
fs.writeFileSync(path.join(dir, 'oc-' + n + '.txt'), model + '\\n');
`,
    // network down: NOT a model-class error — must fail fast without walking the
    // chain. Also records -m so the no-advance assertion can count invocations.
    neterr: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv;
const model = a.indexOf('-m') >= 0 ? a[a.indexOf('-m') + 1] : '(none)';
fs.appendFileSync(path.join(__dirname, 'models-seen'), model + '\\n');
process.stdout.write(JSON.stringify({ type: 'error', error: { name: 'UnknownError', data: { message: 'getaddrinfo ENOTFOUND opencode.ai' } } }) + '\\n');
`,
    // ALWAYS rejects the model (model-class). With an explicit user model this
    // must fail terminally with no fallback attempt.
    modelerr: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv;
const model = a.indexOf('-m') >= 0 ? a[a.indexOf('-m') + 1] : '(none)';
fs.appendFileSync(path.join(__dirname, 'models-seen'), model + '\\n');
process.stdout.write(JSON.stringify({ type: 'error', error: { name: 'GatewayModelNotFoundError', data: { message: 'Model ' + model + ' is not supported' } } }) + '\\n');
`,
    // dumps the headless-hardening env the runner must set into env.json.
    env: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'env dump' } }) + '\\n');
fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({
  autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE || null,
  claudePrompt: process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT || null,
  configContent: process.env.OPENCODE_CONFIG_CONTENT || null,
}) + '\\n');
`,
    // writes a file AND git-commits it inside the detached worktree (real models
    // do this). HEAD moves — the diff must be captured vs the pinned base sha or
    // the work is falsely classified no-changes and silently discarded.
    commit: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const { execSync } = require('child_process');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'committed foo.txt' } }) + '\\n');
fs.writeFileSync(path.join(dir, 'foo.txt'), 'delegated\\n');
execSync('git add -A && git commit -q -m delegated', { cwd: dir, stdio: 'ignore', shell: '/bin/sh' });
`,
  };
  fs.writeFileSync(path.join(bin, 'opencode'), scripts[behavior], { mode: 0o755 });
  return bin;
}

function modelsSeen(bin: string): string[] {
  const p = path.join(bin, 'models-seen');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
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
    // each unit reports the model that delivered it
    assert.equal(r.units.every((u) => u.model === OPENCODE_FREE_MODELS[0]), true);
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

test('delegate defaults to the head of the free-model chain (same on every host)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('model');
    const r = delegate(dir, { role: 'frontend', task: 'echo model', runId: 'chain-head' });
    assert.equal(r.ok, true);
    assert.equal(r.model, OPENCODE_FREE_MODELS[0]);
    assert.equal(fs.readFileSync(path.join(dir, 'model.txt'), 'utf8').trim(), OPENCODE_FREE_MODELS[0]);
  });
});

test('delegate walks the free chain when the gateway retires a promo model, and memoizes the survivor', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    const bin = stubOpencode('chain'); // chain[0] → "Model not found", others succeed
    const r = delegate(dir, { role: 'frontend', task: 'create model.txt', runId: 'chain-1' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'delegated');
    assert.equal(r.model, OPENCODE_FREE_MODELS[1]);
    assert.equal(fs.readFileSync(path.join(dir, 'oc-1.txt'), 'utf8').trim(), OPENCODE_FREE_MODELS[1]);
    assert.deepEqual(modelsSeen(bin), [OPENCODE_FREE_MODELS[0], OPENCODE_FREE_MODELS[1]]);
    // second delegation in the same process SKIPS the dead id (memoized)
    const r2 = delegate(dir, { role: 'frontend', task: 'create model.txt again', runId: 'chain-2' });
    assert.equal(r2.ok, true);
    assert.equal(r2.model, OPENCODE_FREE_MODELS[1]);
    assert.deepEqual(modelsSeen(bin), [OPENCODE_FREE_MODELS[0], OPENCODE_FREE_MODELS[1], OPENCODE_FREE_MODELS[1]]);
  });
});

test('delegate fails fast on a network error — no chain walk (a new model cannot fix a dead network)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    const bin = stubOpencode('neterr');
    const r = delegate(dir, { role: 'frontend', task: 'do it', runId: 'net-1' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /ENOTFOUND/);
    // exactly ONE invocation: the chain did not advance
    assert.deepEqual(modelsSeen(bin), [OPENCODE_FREE_MODELS[0]]);
    // and the memo was not moved — the next call starts at the head again
    const r2 = delegate(dir, { role: 'frontend', task: 'do it', runId: 'net-2' });
    assert.equal(r2.ok, false);
    assert.deepEqual(modelsSeen(bin), [OPENCODE_FREE_MODELS[0], OPENCODE_FREE_MODELS[0]]);
  });
});

test('explicit openCode.model is tried alone — model errors do NOT fall back (user pinned it)', () => {
  withRepo({ openCode: { enabled: true, model: 'opencode/custom-x' } }, (dir) => {
    const bin = stubOpencode('modelerr'); // rejects every model as unsupported
    const r = delegate(dir, { role: 'frontend', task: 'do it', runId: 'pin-1' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /no usable OpenCode model|not supported/);
    assert.deepEqual(modelsSeen(bin), ['opencode/custom-x']);
  });
});

test('explicit openCode.model overrides the free chain', () => {
  withRepo({ openCode: { enabled: true, model: 'opencode/custom-x' } }, (dir) => {
    stubOpencode('model');
    const r = delegate(dir, { role: 'frontend', task: 'echo model', runId: 'pin-2' });
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'model.txt'), 'utf8').trim(), 'opencode/custom-x');
  });
});

test('delegate hardens the spawned CLI env for headless runs', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('env');
    const r = delegate(dir, { role: 'frontend', task: 'dump env', runId: 'env-1' });
    assert.equal(r.ok, true);
    const dumped = JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')) as Record<string, string | null>;
    assert.equal(dumped.autoupdate, '1');
    assert.equal(dumped.claudePrompt, '1');
    const cfg = JSON.parse(dumped.configContent || '{}') as { autoupdate?: boolean; share?: string; permission?: Record<string, string> };
    assert.equal(cfg.autoupdate, false);
    assert.equal(cfg.share, 'disabled');
    assert.equal(cfg.permission?.external_directory, 'deny');
    assert.equal(cfg.permission?.doom_loop, 'deny');
  });
});

test('delegate captures the diff even when the model git-commits inside the worktree (base-sha regression)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('commit'); // writes foo.txt AND commits it (moves worktree HEAD)
    const r = delegate(dir, { role: 'frontend', task: 'create foo.txt', runId: 'commit-1' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'delegated');
    assert.ok(r.touched.includes('foo.txt'));
    assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8').trim(), 'delegated');
    // the project's real HEAD did not move — only the throwaway worktree's did
    const log = spawnSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' }).stdout.trim().split('\n');
    assert.equal(log.length, 1);
  });
});
