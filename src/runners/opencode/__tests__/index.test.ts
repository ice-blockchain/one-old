import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { delegate, delegateFromPlan, normalizePlanRole, parsePlanDelegationQueue, postApplyTypecheck, resetOpenCodeModelMemo, stageExcludePathspecs } from '../index';
import { OPENCODE_FREE_MODELS } from '../../../config/opencode-delegation';
import { openCodePlanBatchComplete, openCodePlanRoleCompleted, openCodeRoleAttempted, readOpenCodePlanBatchState } from '../../../shared/opencode-roles';

function sh(cwd: string, cmd: string, args: string[]): void {
  spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'ignore' });
}

// A real git repo (HEAD commit so the worktree sandbox can branch) + sandboxed
// prefs/toolchain root, then a stubbed managed `opencode` binary.
function withRepo(prefs: Record<string, unknown>, fn: (dir: string) => void, opts: { noInitialCommit?: boolean } = {}): void {
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
  // opts.noInitialCommit leaves the repo with NO HEAD (a fresh scaffold mid-build) so
  // a test can exercise the delegate() self-heal path.
  if (!opts.noInitialCommit) {
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  }
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

type StubBehavior = 'edit' | 'append' | 'conflict' | 'error' | 'noop' | 'retry' | 'multi' | 'model' | 'chain' | 'neterr' | 'modelerr' | 'env' | 'commit' | 'junk' | 'artifacts' | 'scopeleak' | 'assignmentchange' | 'editts';

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
    // simulates a unit that ran an install in the sandbox: writes a real source
    // file PLUS node_modules junk and a wrong-package-manager lockfile. The
    // staging excludes must keep the junk out of the delegated diff.
    junk: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'created helper + ran npm install' } }) + '\\n');
fs.writeFileSync(path.join(dir, 'helper.txt'), 'real work\\n');
fs.mkdirSync(path.join(dir, 'pkg', 'node_modules', 'left-pad'), { recursive: true });
fs.writeFileSync(path.join(dir, 'pkg', 'node_modules', 'left-pad', 'index.js'), 'junk\\n');
fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\\n');
`,
    // writes legitimate source plus common build/test cache artifacts. Source should
    // apply; generated artifacts must be filtered before diff capture.
    artifacts: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'source plus generated artifacts' } }) + '\\n');
fs.mkdirSync(path.join(dir, 'apps', 'web', 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx'), 'export function App() { return null; }\\n');
fs.mkdirSync(path.join(dir, 'apps', 'web', 'dist', 'assets'), { recursive: true });
fs.writeFileSync(path.join(dir, 'apps', 'web', 'dist', 'assets', 'app.js'), 'bundle\\n');
fs.mkdirSync(path.join(dir, 'apps', 'web', '.turbo'), { recursive: true });
fs.writeFileSync(path.join(dir, 'apps', 'web', '.turbo', 'cache.json'), '{}\\n');
fs.writeFileSync(path.join(dir, 'apps', 'web', 'tsconfig.tsbuildinfo'), '{}\\n');
`,
    // writes one in-scope frontend file and one backend/API file. The whole patch
    // must be rejected before apply, leaving even the valid file untouched.
    scopeleak: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'frontend plus backend leak' } }) + '\\n');
fs.mkdirSync(path.join(dir, 'apps', 'web', 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx'), 'export function App() { return null; }\\n');
fs.mkdirSync(path.join(dir, 'packages', 'api-client', 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'packages', 'api-client', 'src', 'index.ts'), 'export const leaked = true;\\n');
`,
    // writes a valid in-scope file, then changes the real run assignment manifest
    // before delegate() validates the patch. The stale diff must be rejected.
    assignmentchange: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'frontend file while assignments changed' } }) + '\\n');
fs.mkdirSync(path.join(dir, 'apps', 'web', 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx'), 'export function App() { return null; }\\n');
const real = process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO;
if (real) {
  const t1 = '.traffic' + '-one';
  const runDir = path.join(real, t1, 'runs', 'r-stale');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'assignments.json'), JSON.stringify({ version: 1, runId: 'r-stale', assignments: [{ role: 'senior-frontend', scope: { include: ['apps/web/src/other/**'] } }] }));
}
`,
    // writes a TS source file so the post-apply typecheck path engages.
    editts: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'created src/foo.ts' } }) + '\\n');
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export const foo = 1;\\n');
`,
    // reads the worktree's foo.txt (which reflects the sandbox BASE) and appends a
    // marker. Lets a test assert which base the sandbox branched from: if the runner
    // branches off the live working tree, the stub sees the uncommitted content; if
    // it (wrongly) branches off committed HEAD, it sees the stale content instead.
    append: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'edited foo.txt' } }) + '\\n');
const p = path.join(dir, 'foo.txt');
const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
fs.writeFileSync(p, cur.replace(/\\n+$/, '') + '-EDITED\\n');
`,
    // Writes a worktree patch and simulates a concurrent real-tree edit before
    // delegate() applies that patch back. This reproduces the failed-apply path
    // that must be atomic: no conflict markers or partial files may leak.
    conflict: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'edited foo.txt with concurrent main change' } }) + '\\n');
fs.writeFileSync(path.join(dir, 'foo.txt'), 'delegated\\n');
fs.writeFileSync(path.join(dir, 'new-page.txt'), 'delegated page\\n');
const real = process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO;
if (real) fs.writeFileSync(path.join(real, 'foo.txt'), 'concurrent\\n');
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

function writeAssignments(dir: string, runId: string, assignments: Array<{ role: string; include: string[]; exclude?: string[] }>): void {
  const runDir = path.join(dir, '.traffic-one', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'assignments.json'), JSON.stringify({
    version: 1,
    runId,
    assignments: assignments.map((a) => ({
      role: a.role,
      scope: a.exclude && a.exclude.length > 0 ? { include: a.include, exclude: a.exclude } : { include: a.include },
    })),
  }), 'utf8');
}

function failWorktreeAddViaPath(dir: string): () => void {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
  const savedPath = process.env.PATH;
  const fakeBin = path.join(dir, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
if (args[0] === 'worktree' && args[1] === 'add') {
  process.stderr.write('fatal: could not create worktree metadata: Permission denied\\n');
  process.exit(128);
}
const child = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (child.error) {
  process.stderr.write(child.error.message + '\\n');
  process.exit(1);
}
process.exit(typeof child.status === 'number' ? child.status : 1);
`, { mode: 0o755 });
  process.env.PATH = `${fakeBin}${path.delimiter}${savedPath || ''}`;
  return () => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  };
}

function failApplyWithPartialViaPath(dir: string): () => void {
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
  const savedPath = process.env.PATH;
  const fakeBin = path.join(dir, 'fake-apply-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'apply' && args.includes('--whitespace=nowarn')) {
  process.stderr.write('error: direct apply failed\\n');
  process.exit(1);
}
if (args[0] === 'apply' && args.includes('--3way')) {
  fs.writeFileSync(path.join(process.cwd(), 'foo.txt'), 'partial leaked foo\\n');
  fs.writeFileSync(path.join(process.cwd(), 'new-page.txt'), 'partial leaked page\\n');
  process.stderr.write("Applied patch to 'foo.txt' cleanly.\\n");
  process.stderr.write("error: src/app/(public)/news/page.tsx: patch does not apply\\n");
  process.exit(1);
}
const child = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (child.error) {
  process.stderr.write(child.error.message + '\\n');
  process.exit(1);
}
process.exit(typeof child.status === 'number' ? child.status : 1);
`, { mode: 0o755 });
  process.env.PATH = `${fakeBin}${path.delimiter}${savedPath || ''}`;
  return () => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  };
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

test('delegate sandboxes from the live WORKING TREE, not stale HEAD — an uncommitted prior edit is seen (no cached base)', () => {
  // Regression: two sequential delegations reuse the same runId and leave their
  // edits UNCOMMITTED. The 2nd must branch its sandbox off the current working tree,
  // not the committed HEAD — else it operates on a "cached" snapshot of the repo and
  // its diff fails to apply / lands the wrong content.
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('append');
    // HEAD has foo.txt='base'; the working tree carries an UNCOMMITTED change to
    // 'WORKING' (stands in for a previous delegation's not-yet-committed edit).
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'base\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'add foo']);
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'WORKING\n'); // uncommitted
    const r = delegate(dir, { role: 'quick-fix', task: 'edit foo', runId: 'seq-1' });
    assert.equal(r.action, 'delegated', 'a sandbox built on the live tree applies cleanly');
    // The stub appended to what it SAW in the sandbox: 'WORKING' (live), not 'base'
    // (HEAD). With the old HEAD-based sandbox this is 'base-EDITED' and the apply
    // conflicts against the 'WORKING' tree → action:'failed'.
    assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8').trim(), 'WORKING-EDITED');
  });
});

test('delegate sandboxes UNTRACKED files — editing a never-committed file applies back (no "does not exist in index")', () => {
  // Regression: mid-build, most new source exists ONLY in the working tree
  // (never committed or staged). `git stash create` omits untracked files, so
  // the sandbox lacked them; OpenCode re-created the file from scratch, the
  // patch came back as "new file", and apply failed — plain apply with
  // "already exists in working directory", --3way with "does not exist in
  // index". Whole delegations fell back to paid subagents because of this.
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('append');
    // foo.txt exists ONLY in the working tree: never committed, never staged.
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'UNTRACKED\n');
    const r = delegate(dir, { role: 'quick-fix', task: 'edit foo', runId: 'untracked-1' });
    assert.equal(r.action, 'delegated', `sandbox must include untracked files (got ${r.action}: ${r.error})`);
    // The stub saw the real untracked content and appended to it; the patch
    // applied back onto the same untracked file in the real tree.
    assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8').trim(), 'UNTRACKED-EDITED');
    // The snapshot must not touch the user's git state: still untracked, no
    // stash entries, nothing staged.
    const status = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout;
    assert.match(status, /^\?\? foo\.txt$/m, 'foo.txt stays untracked after delegation');
    assert.equal(spawnSync('git', ['-C', dir, 'stash', 'list'], { encoding: 'utf8' }).stdout.trim(), '');
  });
});

test('delegate sandboxes UNTRACKED files in gitignore-respecting fashion — ignored files stay out of the sandbox snapshot', () => {
  // node_modules-class safety: the untracked snapshot must respect .gitignore,
  // or every delegation would copy build output into the sandbox worktree.
  withRepo({ openCode: { enabled: true } }, (dir) => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored-dir/\n');
    fs.mkdirSync(path.join(dir, 'ignored-dir'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ignored-dir', 'blob.txt'), 'never snapshot me\n');
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'UNTRACKED\n');
    stubOpencode('append');
    const r = delegate(dir, { role: 'quick-fix', task: 'edit foo', runId: 'untracked-2' });
    assert.equal(r.action, 'delegated', `expected delegated, got ${r.action}: ${r.error}`);
    assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8').trim(), 'UNTRACKED-EDITED');
    // The ignored file was not committed into the snapshot. The snapshot is a
    // DANGLING commit (unreachable from any ref), so find it via fsck and
    // assert its tree omits ignored-dir. Require at least one dangling commit
    // so the loop can't pass vacuously.
    const fsck = spawnSync('git', ['-C', dir, 'fsck', '--dangling'], { encoding: 'utf8' }).stdout;
    const dangling = [...fsck.matchAll(/dangling commit ([0-9a-f]+)/g)].map((m) => m[1] as string);
    assert.ok(dangling.length >= 1, 'the working-tree snapshot exists as a dangling commit');
    for (const sha of dangling) {
      const names = spawnSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', sha], { encoding: 'utf8' }).stdout;
      assert.doesNotMatch(names, /ignored-dir/, 'gitignored paths never enter a snapshot tree');
    }
  });
});

test('delegate self-heals a missing HEAD on a fresh scaffold (git repo, no commits) → delegates instead of skipping', () => {
  // The new-project case: OpenCode runs DURING the build, before the build-completion
  // commit lands, so the repo has no HEAD to sandbox. Old behavior: skip with "No git
  // HEAD" → paid fallback for the whole build. Now: create the initial commit + retry.
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('edit');
    assert.notEqual(
      spawnSync('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).status, 0,
      'precondition: a fresh scaffold with no commit',
    );
    const r = delegate(dir, { role: 'quick-fix', task: 'create foo.txt', runId: 'np-1' });
    assert.equal(r.action, 'delegated', 'self-heals the initial commit, then sandboxes');
    assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8').trim(), 'delegated');
    assert.equal(
      spawnSync('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).status, 0,
      'HEAD now exists so future delegations sandbox normally',
    );
  }, { noInitialCommit: true });
});

test('delegate failed apply is atomic: concurrent main-tree edits survive without partial conflict files', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('conflict');
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'base\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'add foo']);

    const saved = process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO;
    process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO = dir;
    try {
      const r = delegate(dir, { role: 'senior-frontend', task: 'edit foo with a concurrent conflict', runId: 'apply-conflict' });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'failed');
      assert.match(r.error || '', /could not apply delegated diff/);
      assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8'), 'concurrent\n');
      assert.equal(fs.existsSync(path.join(dir, 'new-page.txt')), false);
      assert.equal(fs.existsSync(path.join(dir, 'foo.txt.rej')), false);
      assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', 'apply-conflict')), false);
    } finally {
      if (saved === undefined) delete process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO;
      else process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO = saved;
    }
  });
});

test('delegate rolls back files that git apply --3way partially writes before failing', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('conflict');
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'base\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'add foo']);
    const restorePath = failApplyWithPartialViaPath(dir);
    try {
      const r = delegate(dir, { role: 'senior-frontend', task: 'edit foo and add page', runId: 'partial-apply' });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'failed');
      assert.match(r.error || '', /could not apply delegated diff/);
      assert.equal(fs.readFileSync(path.join(dir, 'foo.txt'), 'utf8'), 'base\n');
      assert.equal(fs.existsSync(path.join(dir, 'new-page.txt')), false);
      assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', 'partial-apply')), false);
    } finally {
      restorePath();
    }
  });
});

test('delegate fails closed on an opencode error event — working tree untouched (→ fallback)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('error');
    const r = delegate(dir, { role: 'frontend', task: 'do it', runId: 'r1' });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /boom from gateway/);
    assert.equal(openCodeRoleAttempted(dir, 'r1', 'frontend'), true);
    assert.equal(fs.existsSync(path.join(dir, 'foo.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', 'r1')), false);
  });
});

test('delegate does not record a role attempt when git worktree creation is sandbox-blocked', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('edit');
    const restorePath = failWorktreeAddViaPath(dir);
    try {
      const r = delegate(dir, { role: 'senior-frontend', task: 'create foo.txt', runId: 'ro-git' });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'failed');
      assert.match(r.error || '', /worktree add failed: .*Permission denied/);
      assert.equal(openCodeRoleAttempted(dir, 'ro-git', 'senior-frontend'), false);
      assert.equal(fs.existsSync(path.join(dir, 'foo.txt')), false);
      assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', 'ro-git')), false);
    } finally {
      restorePath();
    }
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

test('parsePlanDelegationQueue extracts only runnable units from the marked queue block', () => {
  const plan = [
    '# Plan', 'prose',
    '<!-- opencode-delegate:start -->',
    '- id: seed | role: backend | files: src/seed.ts | task: Create dummy seed data',
    '- role: frontend | task: Boilerplate card component',
    '- not a unit line (ignored)',
    '<!-- opencode-delegate:end -->',
    '- role: architect | task: outside the block — must be ignored',
  ].join('\n');
  const q = parsePlanDelegationQueue(plan);
  assert.equal(q.length, 1);
  assert.equal(q[0]?.role, 'backend');
  assert.equal(q[0]?.files, 'src/seed.ts');
  assert.deepEqual(parsePlanDelegationQueue('# plan with no queue'), []);
});

test('delegateFromPlan deterministically delegates every queued bounded unit', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: backend-a | role: backend | files: unit-1.txt | task: make unit A',
      '- id: frontend-b | role: frontend | files: unit-2.txt | task: make unit B',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'plan-1' });
    assert.equal(r.total, 2);
    assert.equal(r.delegated, 2);
    assert.equal(r.units.every((u) => u.action === 'delegated'), true);
    // each unit reports the model that delivered it
    assert.equal(r.units.every((u) => u.model === OPENCODE_FREE_MODELS[0]), true);
    // The Step-0 batch terminal markers are separate from per-role CLI attempts;
    // the spawn gate uses them to keep implementers blocked while the batch is running.
    assert.equal(openCodePlanRoleCompleted(dir, 'plan-1', 'backend'), true);
    assert.equal(openCodePlanRoleCompleted(dir, 'plan-1', 'senior-frontend'), true);
    const memoryDir = ['.traffic', '-one'].join('');
    const runDir = path.join(dir, memoryDir, 'runs', 'plan-1');
    const batch = readOpenCodePlanBatchState(dir, 'plan-1');
    assert.ok(batch && batch.outcome !== 'running');
    assert.equal(openCodePlanBatchComplete(dir, 'plan-1'), true);
    assert.equal(fs.existsSync(path.join(runDir, 'opencode-plan-batch', 'COMPLETE')), true);
    // both units' disjoint diffs landed in the real working tree
    assert.equal(fs.existsSync(path.join(dir, 'unit-1.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'unit-2.txt')), true);
    const queue = JSON.parse(fs.readFileSync(path.join(runDir, 'opencode-queue.json'), 'utf8')) as any;
    assert.equal(queue.version, 1);
    assert.deepEqual(queue.units.map((u: any) => u.role), ['backend', 'frontend']);
    assert.ok(queue.units.every((u: any) => typeof u.id === 'string' && u.id.length > 0));
    const statuses = JSON.parse(fs.readFileSync(path.join(runDir, 'opencode-units.json'), 'utf8')) as any[];
    assert.deepEqual(statuses.map((s) => s.status), ['delegated', 'delegated']);
  });
});

test('delegateFromPlan without opts.runId uses currentRunId from project state', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      version: 1,
      currentRunId: '1782117811109',
    }), 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: frontend-b | role: frontend | files: unit-1.txt | task: make unit B',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');

    const r = delegateFromPlan(dir);

    assert.equal(r.total, 1);
    assert.equal(r.delegated, 1);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'digests', '1782117811109', 'opencode-frontend.md')), true);
    assert.equal(openCodeRoleAttempted(dir, '1782117811109', 'frontend'), true);
    assert.equal(openCodePlanRoleCompleted(dir, '1782117811109', 'senior-frontend'), true);
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
    assert.equal(r.units[0]?.status, 'skipped_no_units');
    const statuses = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'plan-2', 'opencode-units.json'), 'utf8')) as any[];
    assert.equal(statuses[0]?.status, 'skipped_no_units');
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

test('delegateFromPlan ignores stale plan queues in maintenance runs', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = '.traffic' + '-one';
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify({
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      onboardingComplete: true,
      lifecycle: { phase: 'maintenance' },
      currentRunId: 'maint-queue',
    }), 'utf8');
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: stale-ui | role: frontend | files: unit-1.txt | task: stale build unit',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');

    const r = delegateFromPlan(dir);

    assert.equal(r.total, 0);
    assert.equal(r.units[0]?.status, 'skipped_no_units');
    const statuses = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'maint-queue', 'opencode-units.json'), 'utf8')) as any[];
    assert.equal(statuses[0]?.id, '__no_units__');
  });
});

test('maintenance ad-hoc delegation writes a terminal maintenance marker with failureKind', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('error');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify({
      version: 1,
      mode: 'new-project',
      currentRunId: 'maint-1',
      lifecycle: { phase: 'maintenance', source: 'orchestrator', completedAt: '2026-01-01T00:00:00Z' },
    }), 'utf8');

    const r = delegate(dir, { role: 'quick-fix', task: 'try small fix', runId: 'maint-1' });

    assert.equal(r.action, 'failed');
    assert.equal(r.failureKind, 'opencode-error');
    const marker = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'maint-1', 'maintenance.json'), 'utf8')) as any;
    assert.equal(marker.outcome, 'failed');
    assert.equal(marker.fallbackAllowed, true);
    assert.equal(marker.failureKind, 'opencode-error');
  });
});

test('delegate defaults to the head of the hosted free-model chain when host policy allows it', () => {
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

test('snapshotWorkingTree captures UNTRACKED files into the sandbox base', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oc-snap-'));
  try {
    const g = (args: string[]): ReturnType<typeof spawnSync> => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    g(['init', '-q']);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init']);
    // A brand-new (untracked) scaffold file + a gitignored one.
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), 'x', 'utf8');

    const head = (g(['rev-parse', 'HEAD']).stdout as string).trim();
    const { snapshotWorkingTree } = require('../index') as typeof import('../index');
    const sha = snapshotWorkingTree(dir, head);
    assert.ok(sha && sha !== head, 'dirty tree must produce a snapshot commit distinct from HEAD');

    const files = (spawnSync('git', ['ls-tree', '-r', '--name-only', sha as string], { cwd: dir, encoding: 'utf8' }).stdout || '').split('\n');
    assert.ok(files.includes('app.ts'), 'untracked scaffold file is in the snapshot');
    assert.ok(!files.some((f) => f.startsWith('node_modules/')), 'gitignored content stays out');

    // User-visible git state untouched: index empty, HEAD unchanged, no stash.
    assert.equal((g(['diff', '--cached', '--name-only']).stdout as string).trim(), '');
    assert.equal((g(['rev-parse', 'HEAD']).stdout as string).trim(), head);
    assert.equal((g(['stash', 'list']).stdout as string).trim(), '');

    // Clean tree → plain HEAD (no snapshot commit).
    fs.rmSync(path.join(dir, 'app.ts'));
    fs.rmSync(path.join(dir, '.gitignore'));
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    assert.equal(snapshotWorkingTree(dir, head), head);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── install-artifact filtering (#23) ─────────────────────────────────────────

test('delegated diff excludes node_modules and wrong-pm lockfiles (pnpm project)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'pnpm@10.0.0' }), 'utf8');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'pm']);
    stubOpencode('junk');
    const r = delegate(dir, { role: 'frontend', task: 'add helper', runId: 'r-junk' });
    assert.equal(r.action, 'delegated');
    assert.ok(r.touched.includes('helper.txt'));
    assert.ok(!r.touched.some((f) => f.includes('node_modules')), `node_modules leaked: ${r.touched.join(',')}`);
    assert.ok(!r.touched.includes('package-lock.json'), 'wrong-pm lockfile leaked');
    assert.ok(fs.existsSync(path.join(dir, 'helper.txt')));
    assert.ok(!fs.existsSync(path.join(dir, 'package-lock.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'pkg', 'node_modules')));
  });
});

test('delegated diff excludes common build/cache artifacts', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('artifacts');
    const r = delegate(dir, { role: 'frontend', task: 'create app source', runId: 'r-artifacts' });
    assert.equal(r.action, 'delegated');
    assert.deepEqual(r.touched, ['apps/web/src/App.tsx']);
    assert.ok(fs.existsSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx')));
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'web', 'dist')), 'dist must not apply');
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'web', '.turbo')), '.turbo must not apply');
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'web', 'tsconfig.tsbuildinfo')), 'tsbuildinfo must not apply');
  });
});

test('delegated diff fails closed when a role touches outside its assignment scope', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    writeAssignments(dir, 'r-scope', [
      { role: 'senior-frontend', include: ['apps/web/src/**'] },
      { role: 'senior-backend', include: ['packages/api-client/src/**'] },
    ]);
    stubOpencode('scopeleak');
    const r = delegate(dir, { role: 'frontend', task: 'create frontend file only', runId: 'r-scope' });
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /outside frontend's assignment scope/);
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx')), 'valid file must roll back with the invalid patch');
    assert.ok(!fs.existsSync(path.join(dir, 'packages', 'api-client', 'src', 'index.ts')));
    assert.ok(!fs.existsSync(path.join(dir, '.traffic-one', 'digests', 'r-scope')), 'no digest for rejected diff');
  });
});

test('delegate enforces ad-hoc allowedFiles before applying', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('scopeleak');
    const r = delegate(dir, { role: 'frontend', task: 'create only frontend file', runId: 'r-adhoc-scope', allowedFiles: 'apps/web/src/**' });
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /outside the plan files\/area allowlist/);
    assert.ok(!fs.existsSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx')));
    assert.ok(!fs.existsSync(path.join(dir, 'packages', 'api-client', 'src', 'index.ts')));
  });
});

test('delegated diff fails closed when assignments changed while OpenCode was running', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    writeAssignments(dir, 'r-stale', [
      { role: 'senior-frontend', include: ['apps/web/src/**'] },
    ]);
    const saved = process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO;
    process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO = dir;
    try {
      stubOpencode('assignmentchange');
      const r = delegate(dir, { role: 'frontend', task: 'create App', runId: 'r-stale', allowedFiles: 'apps/web/src/**' });
      assert.equal(r.action, 'failed');
      assert.match(r.error || '', /assignment scope changed/);
      assert.ok(!fs.existsSync(path.join(dir, 'apps', 'web', 'src', 'App.tsx')));
    } finally {
      if (saved === undefined) delete process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO;
      else process.env.TRAFFIC_ONE_OPENCODE_TEST_REAL_REPO = saved;
    }
  });
});

test('delegateFromPlan enforces the files/area allowlist before applying', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: frontend-allowlist | role: frontend | files: apps/web/src/** | task: make unit A',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-allowlist' });
    assert.equal(r.total, 1);
    assert.equal(r.delegated, 0);
    assert.equal(r.units[0]?.action, 'failed');
    assert.ok(!fs.existsSync(path.join(dir, 'unit-1.txt')));
    assert.equal(openCodePlanRoleCompleted(dir, 'r-allowlist', 'frontend'), true, 'failed unit still releases the plan-batch gate');
    const log = fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'r-allowlist', 'opencode-attempts', 'frontend.log'), 'utf8');
    assert.match(log, /outside the plan files\/area allowlist/);
  });
});

test('delegateFromPlan rejects unsafe overlapping queue policy before running OpenCode', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: all-ui | role: frontend | files: apps/web/src/** | task: prep UI',
      '- id: card | role: frontend | files: apps/web/src/components/Card.tsx | task: prep card',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-policy' });
    assert.equal(r.total, 2);
    assert.equal(r.delegated, 0);
    assert.equal(r.units.every((u) => u.status === 'rejected_policy'), true);
    assert.equal(fs.existsSync(path.join(dir, 'unit-1.txt')), false);
    const statuses = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'r-policy', 'opencode-units.json'), 'utf8')) as any[];
    assert.equal(statuses.every((s) => s.status === 'rejected_policy'), true);
  });
});

test('delegateFromPlan rejects only unsafe dependency units and still runs safe siblings', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: ui-copy | role: frontend | files: unit-1.txt | task: create the first unit file',
      '- id: deps | role: backend | files: package.json, pnpm-lock.yaml | task: install zod',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-selective-policy' });
    assert.equal(r.total, 2);
    assert.equal(r.delegated, 1);
    assert.equal(r.units.find((u) => u.id === 'ui-copy')?.status, 'delegated');
    assert.equal(r.units.find((u) => u.id === 'deps')?.status, 'rejected_policy');
    assert.equal(fs.existsSync(path.join(dir, 'unit-1.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'unit-2.txt')), false);
    const statuses = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'r-selective-policy', 'opencode-units.json'), 'utf8')) as any[];
    assert.equal(statuses.find((s) => s.id === 'ui-copy')?.status, 'delegated');
    assert.equal(statuses.find((s) => s.id === 'deps')?.status, 'rejected_policy');
  });
});

test('stageExcludePathspecs: generated artifacts and all lockfile install side effects are excluded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocspec-'));
  try {
    const baseSpecs = stageExcludePathspecs(dir);
    assert.ok(baseSpecs.some((s) => s.includes('node_modules')));
    assert.ok(baseSpecs.some((s) => s.includes('dist')));
    assert.ok(baseSpecs.some((s) => s.includes('tsbuildinfo')));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'npm@11.0.0' }), 'utf8');
    const specs = stageExcludePathspecs(dir);
    assert.ok(specs.some((s) => s.includes('pnpm-lock.yaml')));
    assert.ok(specs.some((s) => s.includes('yarn.lock')));
    assert.ok(specs.some((s) => s.includes('package-lock.json')), 'own lockfile is still an install side effect');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── post-apply typecheck verification ────────────────────────────────────────

function stubTsc(dir: string, script: string): void {
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const tsc = path.join(bin, 'tsc');
  fs.writeFileSync(tsc, script, 'utf8');
  fs.chmodSync(tsc, 0o755);
}

function withFakePathBin(dir: string, name: string, script: string, fn: () => void): void {
  const savedPath = process.env.PATH;
  const fakeBin = path.join(dir, 'fake-path-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, name), script, { mode: 0o755 });
  process.env.PATH = `${fakeBin}${path.delimiter}${savedPath || ''}`;
  try {
    fn();
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
}

test('post-apply typecheck failure naming a touched file reverts the delegated diff', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf8');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'ts']);
    stubTsc(dir, '#!/bin/sh\necho "src/foo.ts(1,1): error TS2304: boom"\nexit 1\n');
    stubOpencode('editts');
    const r = delegate(dir, { role: 'frontend', task: 'add foo', runId: 'r-tscfail' });
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /typecheck failed/);
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'foo.ts')), 'diff must be reverted');
  });
});

test('post-apply typecheck pass keeps the delegated diff', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf8');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'ts']);
    stubTsc(dir, '#!/bin/sh\nexit 0\n');
    stubOpencode('editts');
    const r = delegate(dir, { role: 'frontend', task: 'add foo', runId: 'r-tscok' });
    assert.equal(r.action, 'delegated');
    assert.ok(fs.existsSync(path.join(dir, 'src', 'foo.ts')));
  });
});

test('post-apply typecheck skips on pre-existing breakage (errors only in untouched files) and missing tsc', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}', 'utf8');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'ts']);
    // Errors mention an UNRELATED file → not this unit's fault → keep the diff.
    stubTsc(dir, '#!/bin/sh\necho "src/legacy.ts(9,9): error TS2304: old breakage"\nexit 1\n');
    stubOpencode('editts');
    const r = delegate(dir, { role: 'frontend', task: 'add foo', runId: 'r-preexist' });
    assert.equal(r.action, 'delegated');
    // And the pure helper: no tsc on disk → verification skipped entirely.
    assert.equal(postApplyTypecheck(fs.mkdtempSync(path.join(os.tmpdir(), 't1-notsc-')), ['src/foo.ts']), null);
  });
});

test('post-apply verifier prefers nearest package typecheck script over raw tsconfig fallback', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0' }), 'utf8');
    const appDir = path.join(dir, 'apps', 'web');
    fs.mkdirSync(path.join(appDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
      name: '@app/web',
      scripts: { typecheck: 'node verify.js' },
    }), 'utf8');
    fs.writeFileSync(path.join(appDir, 'tsconfig.json'), '{}', 'utf8');
    stubTsc(dir, '#!/bin/sh\necho "apps/web/src/course-card.tsx(1,1): error TS6305: raw tsconfig should not run"\nexit 1\n');
    const marker = path.join(dir, 'pnpm-args.txt');
    withFakePathBin(dir, 'pnpm', `#!/bin/sh\necho "$@" > ${JSON.stringify(marker)}\nexit 0\n`, () => {
      const r = postApplyTypecheck(dir, ['apps/web/src/course-card.tsx']);
      assert.equal(r, null);
    });
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), '--filter @app/web typecheck');
  });
});

test('post-apply verifier reports configured verifyCommand failures against touched files', () => {
  withRepo({ openCode: { enabled: true, verifyCommand: 'node verify.js' } }, (dir) => {
    fs.writeFileSync(path.join(dir, 'verify.js'), 'process.stderr.write("src/foo.ts(1,1): error TS2304: bad\\n"); process.exit(1);\n', 'utf8');
    const r = postApplyTypecheck(dir, ['src/foo.ts']);
    assert.match(r || '', /openCode\.verifyCommand/);
    assert.match(r || '', /src\/foo\.ts/);
  });
});

// ── role shard filter (--roles) ──────────────────────────────────────────────

test('delegateFromPlan honors opts.roles with senior- prefix normalization', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const plan = [
      '# Plan', '',
      '<!-- opencode-delegate:start -->',
      '- id: frontend-a | role: frontend | files: unit-1.txt | task: unit A',
      '- id: tester-b | role: tester | files: b.txt | task: unit B',
      '<!-- opencode-delegate:end -->', '',
    ].join('\n');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), plan, 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-shard', roles: ['senior-frontend'] });
    assert.equal(r.total, 1);
    assert.equal(r.units[0]?.role, 'frontend');
    assert.equal(normalizePlanRole('senior-tester'), 'tester');
    assert.equal(normalizePlanRole('Tester'), 'tester');
  });
});
