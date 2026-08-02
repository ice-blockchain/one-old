import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { delegate, delegateFromPlan, normalizeOpenCodeI18nScope, normalizePlanI18nUnits, normalizePlanRole, parsePlanDelegationQueue, postApplyI18n, postApplyQuality, postApplySize, postApplyStyling, postApplyTypecheck, resetOpenCodeModelMemo, stageExcludePathspecs } from '../index';
import { compileArchitecture, persistCompiledArchitecture } from '../../../shared/architecture-contract';
import { openCodeQueuePolicyViolations } from '../../../shared/opencode-queue';
import { OPENCODE_FREE_MODELS } from '../../../config/model-tiers';
import { markOpenCodeGatewayOutage, openCodePlanBatchComplete, openCodePlanRoleCompleted, openCodeRoleAttempted, readOpenCodePlanBatchState } from '../../../shared/opencode-roles';
import { ensureRunBootstrap, readActiveRunBootstrap } from '../../../shared/run-bootstrap-policy';
import { reconcileRunSettlement } from '../../../shared/run-settlement';
import { ensureRunAgentClaim } from '../../../shared/state';
import { currentHostModelTarget } from '../../../shared/current-model-tiers';
import { ensureRunModelPolicy } from '../../../shared/run-model-policy';

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

function withCodexProPolicyEnv(
  fn: (target: ReturnType<typeof currentHostModelTarget>) => void,
): void {
  const previousHost = process.env.TRAFFIC_ONE_HOST;
  const previousPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_HOST = 'codex';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    fn(currentHostModelTarget('codex', 'pro', process.env));
  } finally {
    if (previousHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = previousHost;
    if (previousPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = previousPlan;
  }
}

type StubBehavior = 'edit' | 'append' | 'conflict' | 'error' | 'noop' | 'retry' | 'multi' | 'model' | 'chain' | 'stall' | 'stallall' | 'neterr' | 'modelerr' | 'env' | 'commit' | 'junk' | 'artifacts' | 'scopeleak' | 'assignmentchange' | 'editts' | 'prompt' | 'collapsed' | 'twopart';

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
    // The ONLY stub that emits more than one text part, and the whole point of
    // it. Every other stub emits exactly one, so a digest summary built by
    // head-slicing the joined narration and one built from the model's last
    // message are byte-identical under all of them — the behaviour was
    // untestable until a run had a preamble AND a conclusion. Real runs always
    // do: the observed shape was "Let me check the existing setup first." as the
    // summary of a run that ended by reporting what it built.
    twopart: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'Let me check the existing setup first.' } }) + '\\n');
fs.writeFileSync(path.join(dir, 'foo.txt'), 'delegated\\n');
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'created foo.txt with the requested helper' } }) + '\\n');
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
    // captures the composed prompt OUTSIDE the worktree (writing it inside would
    // stage it as a delegated diff), so a test can assert what the model was told.
    prompt: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
if (process.env.T1_PROMPT_CAPTURE) fs.writeFileSync(process.env.T1_PROMPT_CAPTURE, String(process.argv[3] || ''), 'utf8');
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'created src/a.ts' } }) + '\\n');
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\\n');
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
    // gateway behavior when a promo model STALLS (the live `spawnSync … opencode
    // ETIMEDOUT` failure): the chain head hangs silently until the runner's spawn
    // timeout kills it; every other model succeeds. Records -m per invocation and
    // writes a UNIQUE file per success so back-to-back delegations apply cleanly.
    stall: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv;
const dir = a.indexOf('--dir') >= 0 ? a[a.indexOf('--dir') + 1] : process.env.PWD;
const model = a.indexOf('-m') >= 0 ? a[a.indexOf('-m') + 1] : '(none)';
fs.appendFileSync(path.join(__dirname, 'models-seen'), model + '\\n');
if (model === ${JSON.stringify(OPENCODE_FREE_MODELS[0])}) {
  setInterval(() => {}, 1000); // hang with no output until SIGTERM'd (ETIMEDOUT)
} else {
  const counter = path.join(__dirname, 'stall-wins');
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) || 0 : 0) + 1;
  fs.writeFileSync(counter, String(n));
  process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'model ' + model } }) + '\\n');
  fs.writeFileSync(path.join(dir, 'oc-stall-' + n + '.txt'), model + '\\n');
}
`,
    // gateway-wide outage: EVERY model hangs until the spawn timeout kills it.
    // The walk must stop after maxConsecutiveStalls() probes, not burn the unit
    // timeout on the entire chain.
    stallall: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const a = process.argv;
const model = a.indexOf('-m') >= 0 ? a[a.indexOf('-m') + 1] : '(none)';
fs.appendFileSync(path.join(__dirname, 'models-seen'), model + '\\n');
setInterval(() => {}, 1000);
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
    // 7co shape: the free model returns working, type-correct code with the
    // whole component packed onto one line. Typecheck cannot see it, so without
    // the quality check the unit is recorded DELEGATED_OK and the paid role
    // integrates against collapsed source.
    collapsed: `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const i = process.argv.indexOf('--dir');
const dir = i >= 0 ? process.argv[i + 1] : process.env.PWD;
process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'created CourseCard' } }) + '\\n');
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'src', 'CourseCard.tsx'),
  'export function CourseCard({ title, summary }) { const open = useState(false); return <article className="card"><h3>{title}</h3><p>{summary}</p><footer><span>{title}</span></footer></article> }\\n');
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
    // A whole-role delegation writes the ROLE's digest, so it keeps the hint the
    // orchestrator acts on.
    assert.match(fs.readFileSync(digest, 'utf8'), /normalize_to: IMPLEMENTED/);
    const runDir = path.join(dir, ['.traffic', '-one'].join(''), 'runs', '2026-01-01T00-00-00Z');
    // Observed live: a direct (non-plan-queue) delegation carried no unit id and
    // was therefore recorded NOWHERE in the unit ledger — the tester delegated
    // its whole suite to the free model and only the attempt log knew.
    const statuses = JSON.parse(fs.readFileSync(path.join(runDir, 'opencode-units.json'), 'utf8')) as any[];
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].role, 'frontend');
    assert.equal(statuses[0].status, 'delegated');
    assert.equal(statuses[0].source, 'direct');
    assert.equal(statuses[0].model, OPENCODE_FREE_MODELS[0]);
    // ...and the model that actually wrote the files now has provenance.
    const provenance = JSON.parse(fs.readFileSync(path.join(runDir, 'delegated-model-observations.json'), 'utf8')) as any[];
    assert.equal(provenance.length, 1);
    assert.equal(provenance[0].model, OPENCODE_FREE_MODELS[0]);
    assert.equal(provenance[0].action, 'delegated');
    assert.deepEqual(provenance[0].touched, ['foo.txt']);
    // worktree cleaned up
    assert.equal(spawnSync('git', ['-C', dir, 'worktree', 'list'], { encoding: 'utf8' }).stdout.trim().split('\n').length, 1);
  });
});

test('the digest summary is what the model concluded, not how it opened', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('twopart');
    const r = delegate(dir, { role: 'frontend', task: 'create foo.txt', runId: '2026-01-01T00-00-00Z' });
    assert.equal(r.ok, true);
    const body = fs.readFileSync(path.join(dir, '.traffic-one', 'digests', '2026-01-01T00-00-00Z', 'frontend.md'), 'utf8');
    const summary = /^- unit 1 .*$/m.exec(body)?.[0] || '';
    assert.match(summary, /created foo\.txt with the requested helper/);
    // The load-bearing half. Reverted, the summary is the JOIN of every part cut
    // to a head slice, so it starts with the preamble and this fails.
    assert.doesNotMatch(summary, /Let me check/, 'a preamble is not a report of work done');
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

test('two units of the SAME role accumulate into one digest instead of overwriting it', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: frontend-a | role: frontend | files: unit-1.txt | task: make unit A',
      '- id: frontend-b | role: frontend | files: unit-2.txt | task: make unit B',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'plan-acc' });
    assert.equal(r.delegated, 2);
    // Observed live: four frontend units ran and the digest listed only the
    // LAST unit's files — each unit overwrote the previous one at this path.
    const digest = fs.readFileSync(path.join(dir, '.traffic-one', 'digests', 'plan-acc', 'opencode-frontend.md'), 'utf8');
    assert.match(digest, /^delegated_units: 2$/m);
    assert.match(digest, /- unit-1\.txt/);
    assert.match(digest, /- unit-2\.txt/);
    assert.match(digest, /- unit 1 \(.+, 1 file\): unit 1/);
    assert.match(digest, /- unit 2 \(.+, 1 file\): unit 2/);
    // A plan-unit digest is the run's delegation ledger, not the role's verdict,
    // so it carries no never-applied normalize_to instruction.
    assert.doesNotMatch(digest, /normalize_to:/);
    assert.match(digest, /verdict: DELEGATED_OK/);
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

test('delegateFromPlan delegates in maintenance when the architect wrote a fresh run-scoped queue', () => {
  withCodexProPolicyEnv((target) => {
    withRepo({ openCode: { enabled: true } }, (dir) => {
      stubOpencode('multi');
      const memoryDir = '.traffic' + '-one';
      const state = {
        mode: 'existing-codebase',
        stack: 'default',
        frontend: 'react-vite',
        backend: 'supabase',
        onboardingComplete: true,
        lifecycle: { phase: 'maintenance' },
        currentRunId: 'maint-fresh',
        performance: {
          level: 'balanced',
          target: {
            plan: 'pro',
            appliedFingerprint: target.appliedFingerprint,
            configVersion: target.configVersion,
          },
        },
        team: { mode: 'subagents', approved: true },
      };
      fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
      fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify(state), 'utf8');
      fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
        '<!-- opencode-delegate:start -->',
        '- id: revamp-ui | role: frontend | files: unit-1.txt | task: build a revamp unit',
        '<!-- opencode-delegate:end -->',
      ].join('\n'), 'utf8');
      // A run-scoped assignments.json PLUS architect-run evidence (digest) is the
      // architect's freshness proof: together they flip `hasFreshArchitectQueueForRun`
      // true so the maintenance from-plan batch delegates THIS run's queue instead
      // of suppressing it. (The manifest alone doesn't count — an orchestrator can
      // hand-copy it; observed 11c.)
      fs.mkdirSync(path.join(dir, memoryDir, 'runs', 'maint-fresh'), { recursive: true });
      fs.writeFileSync(path.join(dir, memoryDir, 'runs', 'maint-fresh', 'assignments.json'), JSON.stringify({
        version: 1,
        runId: 'maint-fresh',
        createdBy: 'senior-architect',
        assignments: [{ role: 'senior-frontend', scope: { include: ['unit-1.txt'], exclude: [] } }],
      }), 'utf8');
      fs.mkdirSync(path.join(dir, memoryDir, 'digests', 'maint-fresh'), { recursive: true });
      fs.writeFileSync(path.join(dir, memoryDir, 'digests', 'maint-fresh', 'architect.md'),
        '# architect digest — run maint-fresh\n\nverdict: PLAN_READY\n', 'utf8');
      assert.ok(ensureRunModelPolicy(dir, 'maint-fresh', 'codex', state, process.env));

      const r = delegateFromPlan(dir);

      assert.equal(r.total, 1);
      assert.equal(r.delegated, 1);
      assert.notEqual(r.units[0]?.id, '__no_units__');
      const bootstrap = readActiveRunBootstrap(dir, 'maint-fresh', 'senior-frontend');
      assert.ok(bootstrap);
      assert.equal(bootstrap.workUnit.unitId, 'senior-frontend:bounded-maintenance');
      assert.deepEqual(bootstrap.workUnit.outputs, [
        '.traffic-one/digests/maint-fresh/frontend.md',
        'unit-1.txt',
      ]);
      const marker = JSON.parse(fs.readFileSync(
        path.join(dir, memoryDir, 'runs', 'maint-fresh', 'maintenance.json'),
        'utf8',
      )) as any;
      assert.equal(marker.role, 'senior-frontend');
      assert.equal(marker.overallOutcome, 'code-delivered');
      assert.equal(marker.fallbackAllowed, false);
      const settlement = JSON.parse(fs.readFileSync(
        path.join(dir, memoryDir, 'runs', 'maint-fresh', 'settlement-v2.json'),
        'utf8',
      )) as any;
      assert.equal(settlement.status, 'code-delivered');
    });
  });
});

test('maintenance delegation without a parent-published work-unit contract fails closed', () => {
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

    const r = delegate(dir, {
      role: 'quick-fix',
      task: 'try small fix',
      runId: 'maint-1',
      allowedFiles: 'README.md',
    });

    // The delegation still declines — the tool-result contract is unchanged, so
    // the orchestrator falls back to the paid role exactly as before.
    assert.equal(r.action, 'failed');
    // 'preflight-rejected', not 'diff-rejected': there was no diff. The old
    // label sent 16co's orchestrator hunting an allowlist violation that did
    // not exist while the real input to fix was the contract publication.
    assert.equal(r.failureKind, 'preflight-rejected');
    const marker = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'maint-1', 'maintenance.json'), 'utf8')) as any;
    // …but the preflight refused before anything ran, so this is NOT terminal:
    // a terminal `failed` here settled the whole run and deadlocked every later
    // role claim (no ledger transition leaves `failed`).
    assert.equal(marker.outcome, 'preflight-rejected');
    assert.equal(marker.overallOutcome, 'preflight-rejected');
    assert.equal(marker.preflightRejected, true);
    assert.equal(marker.fallbackAllowed, false);
    assert.equal(marker.failureKind, 'preflight-rejected');
    assert.equal(marker.workUnitContractHash, undefined);
    assert.equal(marker.allowlistHash, undefined);
    // The SPECIFIC preflight reason survives (this fixture has no model policy).
    assert.match(marker.error, /no immutable parent model policy/i);
    assert.match(marker.error, /no parent-published WorkUnitContract/);
    // No settlement is minted at all — the run stays drivable.
    assert.equal(fs.existsSync(path.join(dir, memoryDir, 'runs', 'maint-1', 'settlement-v2.json')), false);
    const ledgerFile = path.join(dir, memoryDir, 'runs', 'maint-1', 'run.json');
    if (fs.existsSync(ledgerFile)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) as any;
      assert.notEqual(ledger.status, 'failed');
    }
  });
});

test('a preflight-rejected delegation leaves the run drivable: reconciliation stays non-terminal and role claims still bind', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('error');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    const state = {
      version: 1,
      mode: 'new-project',
      currentRunId: 'maint-drivable',
      materializedStack: 'custom-stack|other|laravel|none',
      lifecycle: { phase: 'maintenance', source: 'orchestrator', completedAt: '2026-01-01T00:00:00Z' },
    };
    fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify(state), 'utf8');

    // Globs cannot authorize a paid fallback → the preflight refuses outright.
    const r = delegate(dir, {
      role: 'senior-backend',
      task: 'batch update endpoint',
      runId: 'maint-drivable',
      allowedFiles: 'routes/**, app/Http/Controllers/**',
    });
    assert.equal(r.ok, false);

    const marker = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'maint-drivable', 'maintenance.json'), 'utf8')) as any;
    assert.equal(marker.overallOutcome, 'preflight-rejected');
    assert.match(marker.error, /exact-file allowlist/i, 'the rejected-allowlist reason reaches the marker');

    // Reconciliation must not derive a terminal `failed` from the marker.
    const settled = reconcileRunSettlement(dir, 'maint-drivable');
    assert.notEqual(settled?.status, 'failed');

    // The decisive regression: the run's ledger still admits role claims, so the
    // paid fallback the orchestrator now owes can actually be staked.
    const claim = ensureRunAgentClaim(dir, state, 'senior-backend', { session_id: 'parent-1' }, { toolName: 'Task' });
    assert.ok(claim, 'a preflight rejection must not block the paid fallback claim');
    assert.equal(claim?.role, 'senior-backend');
  });
});

test('maintenance failure reuses an exact parent-published contract for fallback-pending', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('error');
    const memoryDir = ['.traffic', '-one'].join('');
    const state = {
      version: 1,
      mode: 'existing-codebase',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'python',
      currentRunId: 'maint-bound',
      lifecycle: { phase: 'maintenance', source: 'orchestrator', completedAt: '2026-01-01T00:00:00Z' },
    };
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify(state), 'utf8');
    const bootstrap = ensureRunBootstrap(dir, 'maint-bound', 'quick-fix', state, {
      host: 'codex',
      hostAgentType: null,
      evidenceSource: 'test-parent',
      modelPolicyId: 'test-policy',
      boundedOutputs: ['README.md'],
      boundedAllowlist: ['README.md'],
    });
    assert.ok(bootstrap);

    const r = delegate(dir, {
      role: 'quick-fix',
      task: 'try small fix',
      runId: 'maint-bound',
      allowedFiles: 'README.md',
    });
    assert.equal(r.action, 'failed');

    const marker = JSON.parse(fs.readFileSync(
      path.join(dir, memoryDir, 'runs', 'maint-bound', 'maintenance.json'),
      'utf8',
    )) as any;
    assert.equal(marker.fallbackAllowed, true);
    assert.equal(marker.overallOutcome, 'fallback-pending');
    assert.equal(marker.workUnitContractHash, bootstrap?.workUnit.contractHash);
    assert.match(marker.allowlistHash, /^[a-f0-9]{64}$/);
    const settlement = JSON.parse(fs.readFileSync(
      path.join(dir, memoryDir, 'runs', 'maint-bound', 'settlement-v2.json'),
      'utf8',
    )) as any;
    assert.equal(settlement.status, 'active');
    assert.equal(settlement.reason, 'fallback-pending');
    assert.equal(settlement.fallback.workUnitContractHash, bootstrap?.workUnit.contractHash);
    assert.equal(settlement.fallback.allowlistHash, marker.allowlistHash);
  });
});

test('maintenance preflight publishes the exact quick-fix WorkUnit before OpenCode can fail', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('error');
    const previousHost = process.env.TRAFFIC_ONE_HOST;
    const previousPlan = process.env.TRAFFIC_ONE_USER_PLAN;
    process.env.TRAFFIC_ONE_HOST = 'codex';
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    try {
      const target = currentHostModelTarget('codex', 'pro', process.env);
      const state = {
        version: 1,
        mode: 'existing-codebase',
        stack: 'custom-backend',
        frontend: 'none',
        backend: 'python',
        currentRunId: 'maint-preflight',
        lifecycle: { phase: 'maintenance' },
        performance: {
          level: 'balanced',
          target: {
            plan: 'pro',
            appliedFingerprint: target.appliedFingerprint,
            configVersion: target.configVersion,
          },
        },
        team: { mode: 'subagents', approved: true },
      };
      const memoryDir = ['.traffic', '-one'].join('');
      fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
      fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify(state));
      assert.ok(ensureRunModelPolicy(dir, 'maint-preflight', 'codex', state, process.env));
      assert.equal(readActiveRunBootstrap(dir, 'maint-preflight', 'quick-fix'), null);

      const result = delegate(dir, {
        role: 'quick-fix',
        task: 'try the exact README fix',
        runId: 'maint-preflight',
        allowedFiles: 'README.md',
      });
      assert.equal(result.action, 'failed');
      const bootstrap = readActiveRunBootstrap(dir, 'maint-preflight', 'quick-fix');
      assert.ok(bootstrap);
      assert.equal(bootstrap.evidenceSource, 'opencode-maintenance-preflight');
      assert.deepEqual(bootstrap.workUnit.outputs, [
        '.traffic-one/digests/maint-preflight/quick-fix.md',
        'README.md',
      ]);
      const marker = JSON.parse(fs.readFileSync(
        path.join(dir, memoryDir, 'runs', 'maint-preflight', 'maintenance.json'),
        'utf8',
      )) as any;
      assert.equal(marker.overallOutcome, 'fallback-pending');
      assert.equal(marker.workUnitContractHash, bootstrap.workUnit.contractHash);
      assert.ok(marker.fallbackSourceBaseline);
    } finally {
      if (previousHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
      else process.env.TRAFFIC_ONE_HOST = previousHost;
      if (previousPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
      else process.env.TRAFFIC_ONE_USER_PLAN = previousPlan;
    }
  });
});

test('maintenance frontend failure publishes an exact bounded WorkUnit and enables only its paid fallback', () => {
  withCodexProPolicyEnv((target) => {
    withRepo({ openCode: { enabled: true } }, (dir) => {
      stubOpencode('error');
      const memoryDir = ['.traffic', '-one'].join('');
      const state = {
        version: 1,
        mode: 'existing-codebase',
        stack: 'default',
        frontend: 'react-vite',
        backend: 'supabase',
        currentRunId: 'maint-frontend-fail',
        lifecycle: { phase: 'maintenance' },
        performance: {
          level: 'balanced',
          target: {
            plan: 'pro',
            appliedFingerprint: target.appliedFingerprint,
            configVersion: target.configVersion,
          },
        },
        team: { mode: 'subagents', approved: true },
      };
      fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
      fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify(state));
      assert.ok(ensureRunModelPolicy(dir, 'maint-frontend-fail', 'codex', state, process.env));

      const result = delegate(dir, {
        role: 'frontend',
        task: 'try the exact README frontend fix',
        runId: 'maint-frontend-fail',
        allowedFiles: 'README.md',
      });
      assert.equal(result.action, 'failed');
      const bootstrap = readActiveRunBootstrap(dir, 'maint-frontend-fail', 'senior-frontend');
      assert.ok(bootstrap);
      assert.equal(bootstrap.workUnit.unitId, 'senior-frontend:bounded-maintenance');
      assert.deepEqual(bootstrap.workUnit.outputs, [
        '.traffic-one/digests/maint-frontend-fail/frontend.md',
        'README.md',
      ]);
      const marker = JSON.parse(fs.readFileSync(
        path.join(dir, memoryDir, 'runs', 'maint-frontend-fail', 'maintenance.json'),
        'utf8',
      )) as any;
      assert.equal(marker.role, 'senior-frontend');
      assert.equal(marker.overallOutcome, 'fallback-pending');
      assert.equal(marker.fallbackAllowed, true);
      assert.equal(marker.workUnitContractHash, bootstrap.workUnit.contractHash);
      assert.ok(marker.fallbackSourceBaseline);
    });
  });
});

test('maintenance frontend delegation without a parent model policy fails before OpenCode', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('edit');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, '.one.json'), JSON.stringify({
      version: 1,
      mode: 'existing-codebase',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      currentRunId: 'maint-frontend-no-policy',
      lifecycle: { phase: 'maintenance' },
    }));

    const result = delegate(dir, {
      role: 'frontend',
      task: 'must not reach OpenCode',
      runId: 'maint-frontend-no-policy',
      allowedFiles: 'foo.txt',
    });
    assert.equal(result.action, 'failed');
    assert.equal(result.failureKind, 'preflight-rejected');
    assert.match(result.error || '', /no immutable parent model policy/i);
    assert.equal(fs.existsSync(path.join(dir, 'foo.txt')), false);
    assert.equal(readActiveRunBootstrap(dir, 'maint-frontend-no-policy', 'senior-frontend'), null);
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

test('delegate advances the free chain past a STALLED model (spawn timeout) and memoizes the skip', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    const bin = stubOpencode('stall'); // chain[0] hangs until the spawn timeout; the rest succeed
    const savedTimeout = process.env.T1_OC_UNIT_TIMEOUT_MS;
    process.env.T1_OC_UNIT_TIMEOUT_MS = '1500';
    try {
      const r = delegate(dir, { role: 'frontend', task: 'create a file', runId: 'stall-1' });
      assert.equal(r.ok, true);
      assert.equal(r.action, 'delegated');
      assert.equal(r.model, OPENCODE_FREE_MODELS[1]);
      assert.deepEqual(modelsSeen(bin), [OPENCODE_FREE_MODELS[0], OPENCODE_FREE_MODELS[1]]);
      // the stalling id is memoized away: the next delegation in this process
      // starts at the survivor instead of re-burning the unit timeout
      const r2 = delegate(dir, { role: 'frontend', task: 'create another file', runId: 'stall-2' });
      assert.equal(r2.ok, true);
      assert.equal(r2.model, OPENCODE_FREE_MODELS[1]);
      assert.deepEqual(modelsSeen(bin), [OPENCODE_FREE_MODELS[0], OPENCODE_FREE_MODELS[1], OPENCODE_FREE_MODELS[1]]);
    } finally {
      if (savedTimeout === undefined) delete process.env.T1_OC_UNIT_TIMEOUT_MS; else process.env.T1_OC_UNIT_TIMEOUT_MS = savedTimeout;
    }
  });
});

test('delegate stops after two back-to-back stalls (gateway-wide outage) with a provider-timeout failure', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    const bin = stubOpencode('stallall'); // every model hangs
    const savedTimeout = process.env.T1_OC_UNIT_TIMEOUT_MS;
    process.env.T1_OC_UNIT_TIMEOUT_MS = '1200';
    try {
      const r = delegate(dir, { role: 'frontend', task: 'do it', runId: 'stall-all-1' });
      assert.equal(r.ok, false);
      assert.equal(r.action, 'failed');
      assert.equal(r.failureKind, 'provider-timeout');
      assert.match(r.error || '', /stalled/);
      // exactly TWO probes: the walk stops instead of burning the unit timeout
      // on every remaining chain entry before the paid fallback
      assert.deepEqual(modelsSeen(bin), [OPENCODE_FREE_MODELS[0], OPENCODE_FREE_MODELS[1]]);
    } finally {
      if (savedTimeout === undefined) delete process.env.T1_OC_UNIT_TIMEOUT_MS; else process.env.T1_OC_UNIT_TIMEOUT_MS = savedTimeout;
    }
  });
});

test('gateway breaker short-circuits later units in the same run without re-probing', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    const bin = stubOpencode('stallall'); // every model hangs
    const savedTimeout = process.env.T1_OC_UNIT_TIMEOUT_MS;
    const savedBreaker = process.env.T1_OC_GATEWAY_BREAKER_MS;
    process.env.T1_OC_UNIT_TIMEOUT_MS = '1200';
    process.env.T1_OC_GATEWAY_BREAKER_MS = '600000';
    try {
      const r = delegate(dir, { role: 'frontend', task: 'do it', runId: 'brk-1' });
      assert.equal(r.action, 'failed');
      assert.equal(r.failureKind, 'provider-timeout');
      // the outage detection tripped the run-scoped breaker on disk
      assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'brk-1', 'opencode-gateway-down')), true);
      const probed = modelsSeen(bin).length;
      // a later unit in the SAME run fast-fails without a single new probe
      const r2 = delegate(dir, { role: 'tester', task: 'another unit', runId: 'brk-1' });
      assert.equal(r2.ok, false);
      assert.equal(r2.action, 'failed');
      assert.equal(r2.failureKind, 'provider-timeout');
      assert.match(r2.error || '', /breaker/);
      assert.equal(modelsSeen(bin).length, probed, 'breaker short-circuit must not probe any model');
      // the short-circuit still marks the role attempted, so the spawn gate
      // lets the paid fallback through without a deny round-trip
      assert.equal(openCodeRoleAttempted(dir, 'brk-1', 'tester'), true);
    } finally {
      if (savedTimeout === undefined) delete process.env.T1_OC_UNIT_TIMEOUT_MS; else process.env.T1_OC_UNIT_TIMEOUT_MS = savedTimeout;
      if (savedBreaker === undefined) delete process.env.T1_OC_GATEWAY_BREAKER_MS; else process.env.T1_OC_GATEWAY_BREAKER_MS = savedBreaker;
    }
  });
});

test('gateway breaker TTL expiry re-probes the chain (a recovered gateway is not wedged out)', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    const bin = stubOpencode('stallall');
    const savedTimeout = process.env.T1_OC_UNIT_TIMEOUT_MS;
    const savedBreaker = process.env.T1_OC_GATEWAY_BREAKER_MS;
    process.env.T1_OC_UNIT_TIMEOUT_MS = '1200';
    process.env.T1_OC_GATEWAY_BREAKER_MS = '1'; // expires before the next delegation
    try {
      delegate(dir, { role: 'frontend', task: 'do it', runId: 'brk-ttl' });
      const probed = modelsSeen(bin).length;
      const r2 = delegate(dir, { role: 'frontend', task: 'do it again', runId: 'brk-ttl' });
      assert.equal(r2.ok, false);
      assert.ok(modelsSeen(bin).length > probed, 'an expired breaker must probe the gateway again');
    } finally {
      if (savedTimeout === undefined) delete process.env.T1_OC_UNIT_TIMEOUT_MS; else process.env.T1_OC_UNIT_TIMEOUT_MS = savedTimeout;
      if (savedBreaker === undefined) delete process.env.T1_OC_GATEWAY_BREAKER_MS; else process.env.T1_OC_GATEWAY_BREAKER_MS = savedBreaker;
    }
  });
});

test('gateway breaker never skips an explicitly pinned model (user choice always probes)', () => {
  withRepo({ openCode: { enabled: true, model: 'opencode/custom-x' } }, (dir) => {
    stubOpencode('model');
    // Another delegation in this run already tripped the breaker.
    markOpenCodeGatewayOutage(dir, 'brk-pin');
    const r = delegate(dir, { role: 'frontend', task: 'echo model', runId: 'brk-pin' });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'delegated');
    assert.equal(fs.readFileSync(path.join(dir, 'model.txt'), 'utf8').trim(), 'opencode/custom-x');
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

test('delegate rejects a generated/internal allowlist entry before spending a model run', () => {
  // 1cu-cursor: `.traffic-one/digests/<run>/backend.md` in `allowedFiles` was
  // only caught by the post-run diff validator, which discards the WHOLE diff —
  // four delegations, zero files. The runner writes the digest itself.
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const r = delegate(dir, {
      role: 'backend',
      runId: 'r-unsafe',
      task: 'implement the api client',
      allowedFiles: 'packages/api-client/src/AuthAPIService.ts,.traffic-one/digests/r-unsafe/backend.md',
    });
    assert.equal(r.action, 'failed');
    assert.match(r.error || '', /generated\/internal path/);
    assert.match(r.error || '', /digests\/r-unsafe\/backend\.md/);
    // no CLI attempt was made at all
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'r-unsafe', 'opencode-attempts', 'backend')), false);
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

test('delegateFromPlan skips a unit whose declared dependency failed', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: deps | role: backend | files: package.json, pnpm-lock.yaml | task: install zod',
      '- id: helper | role: backend | files: unit-2.txt | depends: deps | task: create the second unit file on top of zod',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-dep-skip' });
    assert.equal(r.delegated, 0);
    assert.equal(r.units.find((u) => u.id === 'deps')?.status, 'rejected_policy');
    const dependent = r.units.find((u) => u.id === 'helper');
    assert.equal(dependent?.status, 'skipped');
    assert.match(String(dependent?.error), /dependency `deps` did not land/);
    assert.equal(fs.existsSync(path.join(dir, 'unit-2.txt')), false,
      'the dependent never runs, so it cannot burn a delegation rebuilding its own prerequisites');
    const statuses = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'r-dep-skip', 'opencode-units.json'), 'utf8')) as any[];
    assert.equal(statuses.find((s) => s.id === 'helper')?.status, 'skipped');
    assert.equal(statuses.find((s) => s.id === 'helper')?.attempts?.[0]?.action, 'skipped-dependency-failed',
      'the discriminating action survives in the attempt log');
  });
});

// 16co, the whole point of the kind-derived edge: `news-fixtures` (kind feature)
// lost its diff to the 400-line cap, and `news-article-presentation` (kind page)
// was STILL sent to the model — 565s, then `TS2305 … has no exported member
// 'getNewsBySlug'` against exports that had just been rolled back. Their
// allowlists are disjoint, so the overlap rule never demanded a `depends:` edge
// and the plan declared none.
test('delegateFromPlan skips a page unit whose same-role feature producer failed, with no declared edge', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: news-fixtures | role: frontend | kind: feature | files: src/features/news/index.tsx | task: Add the typed News fixtures and pure selectors.',
      '- id: news-article | role: frontend | kind: page | files: unit-1.txt | task: Build the article presentation against the declared News selectors.',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-producer-skip' });
    assert.equal(r.delegated, 0);
    assert.equal(r.units.find((u) => u.id === 'news-fixtures')?.status, 'rejected_policy');
    const consumer = r.units.find((u) => u.id === 'news-article');
    assert.equal(consumer?.status, 'skipped');
    assert.match(String(consumer?.error), /producer `news-fixtures` did not land/);
    assert.match(String(consumer?.error), /declared no `depends:` edge/);
    assert.equal(fs.existsSync(path.join(dir, 'unit-1.txt')), false,
      'the doomed consumer never reaches the model — this is the 565s 16co burned');
    const statuses = JSON.parse(fs.readFileSync(path.join(dir, memoryDir, 'runs', 'r-producer-skip', 'opencode-units.json'), 'utf8')) as any[];
    assert.equal(statuses.find((s) => s.id === 'news-article')?.status, 'skipped');
    assert.equal(statuses.find((s) => s.id === 'news-article')?.attempts?.[0]?.action, 'skipped-producer-failed',
      'the INFERRED skip is distinguishable from a declared-dependency skip in the ledger');
  });
});

// Negative row: the inferred edge must be inert in a healthy batch. A producer
// that LANDS leaves its consumer delegated exactly as before — the inference can
// never cost a delegation that would have succeeded.
test('a landed feature producer leaves its same-role page unit delegated', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: news-fixtures | role: frontend | kind: feature | files: unit-1.txt | task: Add the typed News fixtures and pure selectors.',
      '- id: news-article | role: frontend | kind: page | files: unit-2.txt | task: Build the article presentation against the declared News selectors.',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-producer-ok' });
    assert.equal(r.delegated, 2);
    assert.equal(r.units.find((u) => u.id === 'news-article')?.status, 'delegated');
    assert.equal(fs.existsSync(path.join(dir, 'unit-2.txt')), true);
  });
});

// Negative rows: the edge is strictly backwards-looking and strictly same-role.
test('the inferred producer edge never points forward and never crosses roles', () => {
  const memoryDir = ['.traffic', '-one'].join('');
  // A consumer queued BEFORE the producer has no prerequisite to lose.
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: news-article | role: frontend | kind: page | files: unit-1.txt | task: Build the article presentation.',
      '- id: news-fixtures | role: frontend | kind: feature | files: src/features/news/index.tsx | task: Add the typed News fixtures and pure selectors.',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-producer-order' });
    assert.equal(r.units.find((u) => u.id === 'news-fixtures')?.status, 'rejected_policy');
    assert.equal(r.units.find((u) => u.id === 'news-article')?.status, 'delegated');
  });
  // A different role's failed feature is a different package; the plan gate
  // orders cross-role work, and inferring here would strand whole shards.
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: api-feature | role: backend | kind: feature | files: src/features/api/index.tsx | task: Add the typed API fixtures and pure selectors.',
      '- id: news-article | role: frontend | kind: page | files: unit-1.txt | task: Build the article presentation.',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-producer-role' });
    assert.equal(r.units.find((u) => u.id === 'api-feature')?.status, 'rejected_policy');
    assert.equal(r.units.find((u) => u.id === 'news-article')?.status, 'delegated');
  });
});

test('the delegated model is told its edit boundary before it works', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('prompt');
    const capture = path.join(os.tmpdir(), `t1-prompt-${process.pid}-${Date.now()}.txt`);
    process.env.T1_PROMPT_CAPTURE = capture;
    try {
      const r = delegate(dir, { role: 'senior-frontend', task: 'build the card', allowedFiles: 'src/a.ts' });
      assert.equal(r.ok, true);
      const prompt = fs.readFileSync(capture, 'utf8');
      assert.match(prompt, /^build the card/, 'the task still comes first');
      assert.match(prompt, /Create or modify ONLY: src\/a\.ts/);
      assert.match(prompt, /NEVER touch: `\.traffic-one\/\*\*`/);
      assert.match(prompt, /package\.json/);
      assert.match(prompt, /re-export from a barrel\/index file/);
      assert.match(prompt, /overrides any AGENTS\.md/);
    } finally {
      delete process.env.T1_PROMPT_CAPTURE;
      fs.rmSync(capture, { force: true });
    }
  });
});

test('the edit boundary omits the allowlist line when no allowlist was given', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('prompt');
    const capture = path.join(os.tmpdir(), `t1-prompt-none-${process.pid}-${Date.now()}.txt`);
    process.env.T1_PROMPT_CAPTURE = capture;
    try {
      delegate(dir, { role: 'senior-frontend', task: 'build the card' });
      const prompt = fs.readFileSync(capture, 'utf8');
      assert.ok(!/Create or modify ONLY:/.test(prompt), 'no empty allowlist line');
      assert.match(prompt, /NEVER touch/, 'the forbidden-path clause is unconditional');
    } finally {
      delete process.env.T1_PROMPT_CAPTURE;
      fs.rmSync(capture, { force: true });
    }
  });
});

test('delegateFromPlan rejects a unit whose files belong to another role BEFORE delegating', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    const runId = 'r-scope-clash';
    fs.mkdirSync(path.join(dir, memoryDir, 'runs', runId), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'runs', runId, 'assignments.json'), JSON.stringify({
      version: 1,
      runId,
      createdBy: 'senior-architect',
      assignments: [
        { role: 'senior-frontend', agentKey: 'senior-frontend', summary: 'ui', scope: { include: ['unit-1.txt'], exclude: [] } },
        { role: 'senior-backend', agentKey: 'senior-backend', summary: 'server', scope: { include: ['unit-2.txt'], exclude: [] } },
      ],
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: ui-copy | role: frontend | files: unit-1.txt | task: create the first unit file',
      '- id: cross-role | role: frontend | files: unit-2.txt | task: create the second unit file',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');

    const r = delegateFromPlan(dir, { runId });
    assert.equal(r.units.find((u) => u.id === 'ui-copy')?.status, 'delegated',
      'a unit inside its own role scope still runs');
    const clash = r.units.find((u) => u.id === 'cross-role');
    assert.equal(clash?.status, 'rejected_policy');
    assert.match(String(clash?.error), /outside frontend's assignment scope: unit-2\.txt/);
    assert.equal(fs.existsSync(path.join(dir, 'unit-2.txt')), false,
      'the contradiction is caught without spending a delegation');
  });
});

test('delegateFromPlan skips across role shards using the persisted ledger', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    const runId = 'r-dep-shard';
    fs.mkdirSync(path.join(dir, memoryDir, 'runs', runId), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: schemas | role: backend | files: unit-1.txt | task: author the shared schemas',
      '- id: fixtures | role: tester | files: unit-2.txt | depends: schemas | task: typed fixtures over the shared schemas',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    // The backend shard already ran in its own runner process and was rejected.
    fs.writeFileSync(path.join(dir, memoryDir, 'runs', runId, 'opencode-units.json'), JSON.stringify([{
      id: 'schemas',
      role: 'senior-backend',
      status: 'rejected_policy',
      action: 'failed',
      error: 'delegated diff touched file(s) outside the plan files/area allowlist',
      touched: [],
      updatedAt: new Date().toISOString(),
      attempts: [],
    }], null, 2), 'utf8');

    const r = delegateFromPlan(dir, { runId, roles: ['tester'] });
    assert.equal(r.units.find((u) => u.id === 'fixtures')?.status, 'skipped',
      'a dependency that failed in an earlier shard must still block');
    assert.equal(fs.existsSync(path.join(dir, 'unit-2.txt')), false);
  });
});

test('delegateFromPlan still runs a dependent whose dependency succeeded or was never recorded', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('multi');
    const memoryDir = ['.traffic', '-one'].join('');
    fs.mkdirSync(path.join(dir, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(dir, memoryDir, 'plan.md'), [
      '<!-- opencode-delegate:start -->',
      '- id: ui-copy | role: frontend | files: unit-1.txt | task: create the first unit file',
      '- id: ui-more | role: frontend | files: unit-2.txt | depends: ui-copy | task: create the second unit file',
      '<!-- opencode-delegate:end -->',
    ].join('\n'), 'utf8');
    const r = delegateFromPlan(dir, { runId: 'r-dep-ok' });
    assert.equal(r.delegated, 2, 'a landed dependency must never block its dependent');
    assert.equal(r.units.find((u) => u.id === 'ui-more')?.status, 'delegated');
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

test('a delegated unit that lands collapsed source is rejected and reverted, not DELEGATED_OK', () => {
  withRepo({ openCode: { enabled: true } }, (dir) => {
    stubOpencode('collapsed');
    const result = delegate(dir, { role: 'frontend', task: 'add the course card', runId: 'r-collapsed' });

    // 7co: this exact shape typechecks, so only a quality check can catch it.
    assert.equal(result.action, 'failed');
    assert.match(String(result.error), /collapsed source/);
    assert.match(String(result.error), /src\/CourseCard\.tsx:1/);
    // Reverted: the paid implementer must inherit a clean tree, not the
    // collapsed file it would otherwise have to notice and rewrite.
    assert.equal(fs.existsSync(path.join(dir, 'src', 'CourseCard.tsx')), false);
  });
});

test('postApplyQuality reads landed files and spares strings, types, and non-source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocq-'));
  const write = (rel: string, body: string): string => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf8');
    return rel;
  };

  const collapsed = write('src/Nav.tsx',
    'export function Nav(){const [o,setO]=useState(false);return <header><nav><a href="/">H</a></nav><button>{o}</button></header>}\n');
  assert.match(String(postApplyQuality(dir, [collapsed])), /src\/Nav\.tsx:1/);

  // Formatted source, a long Tailwind className, and a one-line type body are
  // all clean — the same corpora the write-time rule was calibrated against.
  const formatted = write('src/Card.tsx', [
    'export function Card({ title }: Props) {',
    '  return (',
    '    <article className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">',
    '      <h3>{title}</h3>',
    '    </article>',
    '  )',
    '}',
  ].join('\n'));
  const types = write('src/types.ts',
    'export interface Unit { id?: string; role: string; task: string; action: string; status?: string; touched: string[]; model?: string }\n');
  assert.equal(postApplyQuality(dir, [formatted, types]), null);

  // Generated, test, and non-source paths are out of scope; a deleted file in
  // the touched list must not throw.
  const generated = write('src/database.types.ts', 'export type A={a:string};export type B={b:string};export function f(){return 1;}\n');
  const spec = write('src/Card.test.tsx',
    'it("x", () => { const a = 1; render(<A/>); expect(<B><C/></B>).toBeTruthy(); expect(a).toBe(1); });\n');
  const readme = write('README.md', 'x'.repeat(400));
  assert.equal(postApplyQuality(dir, [generated, spec, readme, 'src/deleted.tsx']), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

// Existing-* modes: whole-file post-apply architecture judgments (collapse,
// module size, styling-system coherence) stand down — an existing repo's own
// pre-collapsed, oversized, or atomic-CSS-styled files must not make every
// delegated maintenance diff un-landable. Typecheck and catalog validation
// keep applying.
test('postApply quality/size/styling stand down on an existing codebase', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocq-existing-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const collapsed = 'src/Nav.tsx';
    fs.writeFileSync(path.join(dir, collapsed),
      'export function Nav(){const [o,setO]=useState(false);return <header><nav><a href="/">H</a></nav><button>{o}</button></header>}\n');
    const tailwindish = 'src/Card.tsx';
    fs.writeFileSync(path.join(dir, tailwindish), [
      'export function Card() {',
      '  return (',
      '    <article className="flex items-center justify-between">',
      '      <h3 className="rounded-lg border px-4">x</h3>',
      '      <p className="bg-white py-3 shadow-sm gap-4">y</p>',
      '    </article>',
      '  )',
      '}',
    ].join('\n'));
    const oversized = 'src/legacy.ts';
    fs.writeFileSync(path.join(dir, oversized),
      Array.from({ length: 450 }, (_, i) => `export const v${i} = ${i};`).join('\n'));

    const writeMode = (mode: string): void => {
      fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
        mode, stack: 'minimal', backend: 'other', frontend: 'none', onboardingComplete: true,
      }), 'utf8');
    };
    writeMode('existing-codebase');
    // No git HEAD to attribute authorship → fail toward the stand-down.
    assert.equal(postApplyQuality(dir, [collapsed]), null);
    assert.equal(postApplyStyling(dir, [tailwindish]), null);
    assert.equal(postApplySize(dir, [oversized]), null);

    // With a HEAD, only files that existed there are the repo owner's: a file
    // the delegated diff CREATED is wholly run-authored and judged normally
    // even on an existing codebase (the 7co/8co delegated channel never
    // passes the write gate).
    const git = (...args: string[]): void => {
      const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`);
    };
    git('init', '-q');
    git('add', collapsed, tailwindish, oversized);
    git('commit', '-q', '-m', 'legacy');
    assert.equal(postApplyQuality(dir, [collapsed]), null);
    assert.equal(postApplyStyling(dir, [tailwindish]), null);
    const created = 'src/FreshCard.tsx';
    fs.writeFileSync(path.join(dir, created),
      'export function FreshCard(){const [o,setO]=useState(false);return <header><nav><a href="/">H</a></nav><button>{o}</button></header>}\n');
    assert.match(String(postApplyQuality(dir, [collapsed, created])), /src\/FreshCard\.tsx:1/);

    // The same bytes on a new project keep the rollback everywhere.
    writeMode('new-project');
    assert.match(String(postApplyQuality(dir, [collapsed])), /src\/Nav\.tsx:1/);
    assert.match(String(postApplyStyling(dir, [tailwindish])), /no tailwindcss dependency/);
    assert.match(String(postApplySize(dir, [oversized])), /logical lines/);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An i18n runtime dependency with a catalog layout the detector cannot parse
// used to reject EVERY delegated frontend diff on such repos. "Cannot judge"
// means advise on an existing codebase, and keeps blocking on a new project.
test('postApplyI18n: undetectable catalog contract advises instead of blocking on an existing codebase', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oci18n-existing-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'legacy',
      dependencies: { react: '18.0.0', 'react-i18next': '13.0.0', i18next: '23.0.0' },
    }));
    const rel = 'src/Panel.tsx';
    fs.writeFileSync(path.join(dir, rel), 'export const panelWidth = 320;\n');
    const writeMode = (mode: string): void => {
      fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
        mode, stack: 'custom-frontend', frontend: 'react-vite', backend: 'none', onboardingComplete: true,
      }), 'utf8');
    };
    writeMode('new-project');
    assert.match(String(postApplyI18n(dir, [rel])), /no existing catalog contract/);
    writeMode('existing-codebase');
    assert.equal(postApplyI18n(dir, [rel]), null);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('postApplyQuality formats a collapsed landed file in place when the project prettier is reachable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocq-fmt-'));
  try {
    const rel = 'src/Nav.tsx';
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel),
      'export function Nav(){const [o,setO]=useState(false);return <header><nav><a href="/">H</a></nav><button>{o}</button></header>}\n');
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    // Stand-in for the project's own prettier: `--write <file>` rewrites the
    // file with formatted (non-collapsed) source; stdin mode prints it.
    fs.writeFileSync(path.join(binDir, 'prettier'), [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const clean = 'export function Nav() {\\n  return null;\\n}\\n';",
      'const args = process.argv.slice(2);',
      "const writeAt = args.indexOf('--write');",
      'if (writeAt >= 0) fs.writeFileSync(args[writeAt + 1], clean);',
      'else process.stdout.write(clean);',
      '',
    ].join('\n'), { mode: 0o755 });
    assert.equal(postApplyQuality(dir, [rel]), null);
    assert.match(fs.readFileSync(path.join(dir, rel), 'utf8'), /return null;/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('postApplyStyling rejects Tailwind utilities without a toolchain and passes with one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocs-'));
  const write = (rel: string, body: string): string => {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, 'utf8');
    return rel;
  };
  const card = write('src/CourseCard.tsx', [
    'export function CourseCard() {',
    '  return (',
    '    <article className="flex flex-col gap-3 rounded-xl bg-white p-6 shadow-sm">',
    '      <h2 className="text-lg font-semibold">Course</h2>',
    '    </article>',
    '  )',
    '}',
  ].join('\n'));
  // No tailwindcss anywhere: the delegated output styles with an absent system.
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: {} }));
  assert.match(String(postApplyStyling(dir, [card])), /Tailwind utilities/);

  // Declaring the dependency legitimizes the same markup.
  write('package.json', JSON.stringify({ name: 'fixture', devDependencies: { tailwindcss: '4.0.0' } }));
  assert.equal(postApplyStyling(dir, [card]), null);

  // Plain hand-written class names never trip it, with or without Tailwind.
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: {} }));
  const plain = write('src/Plain.tsx', [
    'export function Plain() {',
    '  return (',
    '    <article className="card card-elevated">',
    '      <h2 className="card-title">Course</h2>',
    '    </article>',
    '  )',
    '}',
  ].join('\n'));
  assert.equal(postApplyStyling(dir, [plain]), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Step-0 honours a contract that pins Tailwind before the manifest exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocpin-'));
  try {
    const card = 'src/CourseCard.tsx';
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, card), [
      'export function CourseCard() {',
      '  return (',
      '    <article className="flex flex-col gap-3 rounded-xl bg-white p-6 shadow-sm">',
      '      <h2 className="text-lg font-semibold">Course</h2>',
      '    </article>',
      '  )',
      '}',
    ].join('\n'), 'utf8');

    // The greenfield Step-0 tree: no manifest anywhere, so the filesystem probe
    // can only say "no Tailwind" — and a unit's allowlist may never add one.
    assert.match(String(postApplyStyling(dir, [card])), /Tailwind utilities/);

    // Compile the vite-react contract, whose scaffold outputs include the
    // Tailwind home. The stack pins Tailwind, so the same markup is correct.
    const architecture = compileArchitecture(dir, 'R', {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    });
    assert.ok(
      (architecture.scaffoldOutputs || []).some((output) => output.path.includes('tailwind-config')),
      'fixture guard: the vite-react contract must scaffold a Tailwind home',
    );
    // Step-0 runs after the architect phase, so the compiled contract is on disk
    // by then — that is where the pinned-stack answer comes from.
    persistCompiledArchitecture(dir, architecture);
    assert.equal(
      postApplyStyling(dir, [card], 'R'),
      null,
      'a pinned Tailwind stack must not reject Tailwind-composed output at Step-0',
    );

    // A run id with no compiled contract falls back to the filesystem answer, so
    // the original 8co defect stays caught.
    assert.match(String(postApplyStyling(dir, [card], 'MISSING')), /Tailwind utilities/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OpenCode expands frontend scope with compiled locale catalogs and serializes shared catalogs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oci18n-'));
  try {
    const architecture = compileArchitecture(dir, 'R', {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home', path: '/', moduleId: 'home-page' }],
      modules: [
        { id: 'home-page', name: 'Home', kind: 'page' },
        { id: 'shared-card', name: 'Shared Card', kind: 'component' },
      ],
      i18n: { sourceLocale: 'en', locales: ['en', 'ro'] },
    });
    persistCompiledArchitecture(dir, architecture);
    const home = architecture.modules.find((module) => module.id === 'home-page')!.output;
    const card = architecture.modules.find((module) => module.id === 'shared-card')!.output;
    const scope = normalizeOpenCodeI18nScope(dir, 'R', 'frontend', home);
    assert.deepEqual(scope.injectedCatalogs.sort(), [
      'packages/i18n/src/locales/en/home.json',
      'packages/i18n/src/locales/ro/home.json',
    ]);
    assert.match(scope.prompt, /Every static React child string uses/);
    assert.match(scope.prompt, /declared locales: en, ro/);
    assert.match(scope.prompt, /Never render `\{t\(\.\.\.\)\}` as a React child/i);

    const normalized = normalizePlanI18nUnits(dir, 'R', [
      { id: 'card-a', role: 'frontend', files: card, task: 'create shared card' },
      { id: 'card-b', role: 'frontend', files: card, task: 'refine shared card' },
    ]);
    assert.equal(normalized.errors.size, 0);
    assert.ok(normalized.units[0]!.files.includes('locales/en/common.json'));
    assert.deepEqual(normalized.units[1]!.dependsOn, ['card-a']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('catalog-OWNING units register in serialization: declared same-namespace catalogs get depends edges and pass the overlap policy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oci18nown-'));
  try {
    const architecture = compileArchitecture(dir, 'R', {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home', path: '/', moduleId: 'home-page' }],
      modules: [{ id: 'home-page', name: 'Home', kind: 'page' }],
      i18n: { sourceLocale: 'en', locales: ['en', 'ro'] },
    });
    persistCompiledArchitecture(dir, architecture);
    const common = architecture.i18n!.catalogs.filter((catalog) => catalog.namespaces.includes('common'));
    const enCommon = common.find((catalog) => catalog.locales.includes('en'))!.path;
    const roCommon = common.find((catalog) => catalog.locales.includes('ro'))!.path;

    // 13cl: units DECLARING their catalogs explicitly never registered in
    // lastUnitByCatalog (only injected paths did), so no depends edge was
    // added and the overlap policy rejected the whole queue.
    const normalized = normalizePlanI18nUnits(dir, 'R', [
      { id: 'i18n-en', role: 'frontend', files: enCommon, task: 'seed english strings' },
      { id: 'i18n-ro', role: 'frontend', files: roCommon, task: 'seed romanian strings' },
    ]);
    assert.equal(normalized.errors.size, 0);
    assert.deepEqual(normalized.units[1]!.dependsOn, ['i18n-en']);
    assert.deepEqual(openCodeQueuePolicyViolations(normalized.units), []);

    // Id-less units serialize under the same computed fallback id the errors
    // map uses — the `if (unit.id)` hole skipped their registration entirely.
    const anonymous = normalizePlanI18nUnits(dir, 'R', [
      { role: 'frontend', files: enCommon, task: 'seed english strings' },
      { role: 'frontend', files: roCommon, task: 'seed romanian strings' },
    ]);
    assert.deepEqual(anonymous.units[1]!.dependsOn, ['position-1']);

    // 14cl counter-evidence: only ONE unit touches catalogs → serialization
    // must not invent any edge (that queue delegated 5/5 in the field).
    const home = architecture.modules.find((module) => module.id === 'home-page')!.output;
    const singleOwner = normalizePlanI18nUnits(dir, 'R', [
      { id: 'home-ui', role: 'frontend', files: home, task: 'compose the home page' },
      { id: 'seed', role: 'backend', files: 'supabase/seed.sql', task: 'seed demo rows' },
      { id: 'docs', role: 'docs', files: 'README.md', task: 'draft the readme' },
    ]);
    assert.equal(singleOwner.errors.size, 0);
    for (const unit of singleOwner.units) assert.deepEqual(unit.dependsOn, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('postApplyI18n rejects rendered t()/hardcoded copy and accepts Trans with locale parity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oci18n-verify-'));
  try {
    const architecture = compileArchitecture(dir, 'R', {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { framework: 'none' },
    }, {
      schemaVersion: 1,
      routes: [{ id: 'home', path: '/', moduleId: 'home-page' }],
      modules: [{ id: 'home-page', name: 'Home', kind: 'page' }],
      i18n: { sourceLocale: 'en', locales: ['en', 'ro'] },
    });
    persistCompiledArchitecture(dir, architecture);
    const home = architecture.modules[0]!.output;
    fs.mkdirSync(path.dirname(path.join(dir, home)), { recursive: true });
    fs.writeFileSync(path.join(dir, home), [
      "import { useTranslation } from 'react-i18next';",
      'export default function Home() {',
      "  const { t } = useTranslation('home');",
      '  return <main><h1>Welcome</h1><button>{t("save")}</button></main>;',
      '}',
    ].join('\n'));
    assert.match(String(postApplyI18n(dir, [home], 'R', 'frontend')), /i18n contract|STRUCT_/i);

    fs.writeFileSync(path.join(dir, home), [
      "import { Trans } from 'react-i18next';",
      'export default function Home() {',
      '  return <main><h1><Trans ns="home" i18nKey="welcome">Welcome</Trans></h1></main>;',
      '}',
    ].join('\n'));
    const catalogs = architecture.i18n!.catalogs.filter((catalog) => catalog.namespaces.includes('home'));
    for (const catalog of catalogs) {
      fs.mkdirSync(path.dirname(path.join(dir, catalog.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, catalog.path), JSON.stringify({
        welcome: catalog.locales.includes('ro') ? 'Bun venit' : 'Welcome',
      }));
    }
    assert.equal(postApplyI18n(
      dir,
      [home, ...catalogs.map((catalog) => catalog.path)],
      'R',
      'frontend',
    ), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ad-hoc OpenCode reuses detected catalogs and fails closed when runtime catalogs are unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oci18n-adhoc-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      dependencies: {
        react: '19.0.0',
        vite: '7.0.0',
        i18next: '25.0.0',
        'react-i18next': '16.0.0',
      },
    }));
    const source = 'apps/web/src/Home.tsx';
    const en = 'apps/web/src/i18n/locales/en/common.json';
    const ro = 'apps/web/src/i18n/locales/ro/common.json';
    for (const [relative, body] of [
      [source, 'export const Home = () => <h1><Trans ns="common" i18nKey="welcome">Welcome</Trans></h1>;'],
      [en, JSON.stringify({ welcome: 'Welcome' })],
      [ro, JSON.stringify({ welcome: 'Bun venit' })],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
      fs.writeFileSync(path.join(dir, relative), body);
    }

    const scope = normalizeOpenCodeI18nScope(dir, '', 'frontend', source);
    assert.equal(scope.error, null);
    assert.deepEqual(scope.injectedCatalogs, [en, ro]);
    assert.match(scope.prompt, /declared locales: en, ro/);
    assert.equal(postApplyI18n(dir, [source, en, ro], '', 'frontend'), null);

    // A key the in-change <Trans>fallback</Trans> references and a locale is
    // missing is deterministic to fix: runtime seeds the source-locale fallback
    // and a marked TODO into the other locales instead of rolling back.
    fs.writeFileSync(path.join(dir, ro), JSON.stringify({}));
    assert.equal(postApplyI18n(dir, [source, ro], '', 'frontend'), null);
    const seededRo = JSON.parse(fs.readFileSync(path.join(dir, ro), 'utf8')) as Record<string, string>;
    assert.equal(seededRo.welcome, 'TODO(en copy): Welcome');

    // A parity gap with NO in-change fallback to seed from stays a rollback:
    // the reference-free source cannot authorize inventing catalog content.
    fs.writeFileSync(path.join(dir, ro), JSON.stringify({}));
    const plain = 'apps/web/src/Plain.tsx';
    fs.writeFileSync(path.join(dir, plain), 'export const Plain = () => null;');
    assert.match(String(postApplyI18n(dir, [plain, ro], '', 'frontend')), /STRUCT_I18N_CATALOG/);

    fs.rmSync(path.join(dir, 'apps'), { recursive: true, force: true });
    const closed = normalizeOpenCodeI18nScope(dir, '', 'frontend', 'src/Home.tsx');
    assert.match(closed.error || '', /fails closed/);
    assert.deepEqual(closed.injectedCatalogs, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Step-0 rejects a module the structural write gate would refuse to edit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ocsize-'));
  try {
    const rel = 'src/features/demo-catalog/index.ts';
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    // 9co: Step-0 accepted an oversized data module and the write gate then
    // refused every edit to it, leaving its owner unable to fix a 5-character
    // type error.
    const oversized = `export const rows = [\n${Array.from({ length: 500 }, (_, i) => `  { id: ${i} },`).join('\n')}\n];\n`
      + Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(dir, rel), oversized, 'utf8');
    assert.match(String(postApplySize(dir, [rel])), /logical lines, over the 400 limit/);

    const small = 'src/features/ok/index.ts';
    fs.mkdirSync(path.join(dir, path.dirname(small)), { recursive: true });
    fs.writeFileSync(path.join(dir, small), 'export const a = 1;\n', 'utf8');
    assert.equal(postApplySize(dir, [small]), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
