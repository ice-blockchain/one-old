// src/runners/lighthouse/__tests__/preview-start-failure.test.ts
// A preview command the operating system REFUSES must reach this runner's own
// blocked-status channel, never end the runner.
//
// `startPreview` names the package manager BARE — `pnpm`, `npm`, `yarn`, `bun`,
// whichever `detectPackageManager` read off the lockfile — and attached no
// `error` listener, so a host that has not installed that one took an uncaught
// `spawn pnpm ENOENT` and died mid-run. Measured before the fix, with the package
// manager off PATH: exit 1, node's uncaught-exception trace on stderr, and stdout
// EMPTY. That last part is what makes it worse here than the same defect in the
// QA lane: this runner's stated contract (index.mts:296) is that it NEVER exits
// without one final JSON status line, and `src/modules/page-speed/handler.ts`
// parses exactly that line out of stdout — so the caller was told nothing, not
// even that the audit had failed.
//
// The channel is this runner's own `blocked:*` status, not the QA evidence
// runner's result kinds: the two share no result type, and one word meaning two
// things across two runners is worse than two honest spellings. The new arm is
// `blocked:preview-command-missing`, built the way `blocked:lighthouse-missing`
// is — a canonical message plus a `classifyBlockedStatus` branch — because both
// say the same kind of thing, that a binary this run needs is not usable on this
// host.
//
// The two failures that must stay distinguishable are the two whose repairs
// differ: a preview that NEVER STARTED wants a package manager installed (or
// `--url … --skip-preview`), and one that NEVER BECAME READY wants a longer
// `--timeout` or a look at the app. Both rows are here.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { classifyBlockedStatus, previewCommandMissingMessage } from '../lib';

const TEST_TIMEOUT_MS = 60_000;
const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/**
 * A vite app whose package manager this host will not run.
 *
 * Vite is the cheapest reachable shape: `ensurePreviewBuildArtifacts` demands
 * build output for `next` and `static` and nothing for `vite`, so the preview
 * spawn is the first thing the runner does once `--skip-build` removes the build.
 */
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lh-refused-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'refused-preview',
    private: true,
    packageManager: 'pnpm@9.0.0',
    devDependencies: { vite: '^5.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {};\n');
  return dir;
}

interface RunnerResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

/**
 * The runner as its OWN PROCESS, which is the only honest way to ask this.
 *
 * `index.mts` calls `main()` in its module body, so importing it runs it; and the
 * question is what an uncaught exception does to a process, which cannot be asked
 * from inside the process asking it. The same reason
 * qa-evidence/__tests__/server-teardown.test.ts drives its interrupt row through
 * a real child.
 *
 * PATH is emptied rather than edited: that is the same ENOENT a host without this
 * package manager produces, and it cannot depend on what happens to be installed
 * on the machine running the suite.
 */
async function runRunner(dir: string, extraArgs: readonly string[] = []): Promise<RunnerResult> {
  const repoRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT || process.cwd();
  const runner = path.join(repoRoot, 'src/runners/lighthouse/index.mts');
  // Absolute, because a bare `--import tsx` resolves against the CHILD's cwd, and
  // the child's cwd has to be the fixture — the runner finds its project root by
  // walking up from `process.cwd()`.
  const loader = path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs');
  for (const required of [runner, loader]) {
    assert.ok(fs.existsSync(required), `fixture guard: this row must drive the real runner, not ${required}`);
  }
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(loader).href,
    runner,
    '--skip-build',
    // Small on purpose: a row that ends by exhausting this instead of by noticing
    // the refusal should be slow enough to be obvious and short enough to finish.
    '--timeout', '4000',
    '--max-runtime', '40000',
    ...extraArgs,
  ], {
    cwd: dir,
    env: { ...process.env, PATH: path.join(dir, 'no-such-bin') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * THE DEFECT, from the caller's side: the status line exists.
 *
 * Asserted on STDOUT rather than on an exception, because stdout is what the
 * page-speed hook reads. An unhandled `'error'` event leaves it empty — that is
 * the measured before-state — so this row fails on the exact symptom a caller
 * suffers rather than on a proxy for it.
 */
test('a preview command this host cannot run reports a blocked status instead of crashing', { timeout: TEST_TIMEOUT_MS }, async () => {
  const result = await runRunner(project());
  assert.doesNotMatch(
    result.stderr,
    /Unhandled 'error' event|ERR_UNHANDLED/,
    'the refusal must be handled, not fatal',
  );
  assert.ok(result.stdout.trim().length > 0, 'the runner must never exit without its final JSON status line');
  const line = JSON.parse(result.stdout) as { status?: string; error?: string };
  assert.equal(line.status, 'blocked:preview-command-missing');
  assert.match(String(line.error), /spawn pnpm ENOENT/, "node's own errno must survive into the report");
  assert.match(String(line.error), /--skip-preview/, 'and the reader must be given the way around it');
  assert.equal(result.code, 1, 'a blocked run is still a failed run');
});

/**
 * The refusal is not paid for at the readiness budget.
 *
 * The reason `startPreview` publishes its refusal through the readiness wait
 * instead of racing it: `delay` in that loop is a REF'D timer, so a race would
 * print this status line and then keep the process alive polling a port nothing
 * will ever bind — 4 s here, and up to 90 s for a Next preview on its own
 * default. Measured at 0.6 s wall clock for the whole runner against the 4 s
 * budget below.
 */
test('a refused preview gives up inside a poll, not at the readiness budget', { timeout: TEST_TIMEOUT_MS }, async () => {
  const startedAtMs = Date.now();
  const result = await runRunner(project());
  const elapsedMs = Date.now() - startedAtMs;
  assert.match(result.stdout, /blocked:preview-command-missing/, 'fixture guard: this row must measure the refusal path');
  assert.ok(elapsedMs < 3_500, `the runner must not hold its process open to the readiness budget (${elapsedMs}ms of 4000ms)`);
});

/**
 * The OTHER failure, kept apart. A preview that never became READY keeps its own
 * message and classifies as `blocked:timeout`, which is a different repair — more
 * time, or a look at the app — from a command that was never executed. Nothing
 * else pins the pair, and a single spelling for both is the blur this file exists
 * to prevent.
 */
test('a preview that never becomes ready is still a timeout, and never a refusal', () => {
  assert.equal(
    classifyBlockedStatus('Preview did not become ready within 90000ms: http://127.0.0.1:4173/'),
    'blocked:timeout',
  );
  assert.notEqual(
    classifyBlockedStatus(previewCommandMissingMessage('pnpm', 'spawn pnpm ENOENT')),
    'blocked:timeout',
    'a command that never ran must never be reported as a server that was given time',
  );
});

/**
 * The canonical message, and the CLASSIFIER ORDERING it depends on.
 *
 * The second everyday refusal is a package manager present without its execute
 * bit, whose spawn error is `spawn ./pnpm EACCES` — and the sandbox branch of
 * `classifyBlockedStatus` matches the bare word EACCES. Under that branch this
 * message would be reported as the host denying a port bind, sending the reader
 * to a Codex escalation recipe for what is a chmod. The preview branch is
 * deliberately above it; this row is what fails if they are ever reordered.
 */
test('the preview refusal outranks the sandbox pattern its errno would otherwise match', () => {
  const enoent = previewCommandMissingMessage('pnpm', 'spawn pnpm ENOENT');
  assert.equal(classifyBlockedStatus(enoent), 'blocked:preview-command-missing');
  const eacces = previewCommandMissingMessage('yarn', 'spawn /app/node_modules/.bin/yarn EACCES');
  assert.match(eacces, /EACCES/, 'fixture guard: the row is only about a message carrying that errno');
  assert.equal(
    classifyBlockedStatus(eacces),
    'blocked:preview-command-missing',
    'an unexecutable package manager is not the sandbox denying a bind',
  );
  // The messages the ordering must not have broken.
  assert.equal(classifyBlockedStatus('listen EPERM: operation not permitted "127.0.0.1"'), 'blocked:sandbox');
  assert.equal(classifyBlockedStatus('No local Lighthouse binary (node_modules/.bin/lighthouse)'), 'blocked:lighthouse-missing');
});

/**
 * The message names the repair, for both causes and for each package manager the
 * runner can detect — a refusal that named only the errno would leave a reader
 * with `spawn bun ENOENT` and no next step.
 */
test('the refusal message names the package manager, both causes, and the way around it', () => {
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    const message = previewCommandMissingMessage(manager, 'spawn x ENOENT');
    assert.match(message, new RegExp(`\`${manager}\``), 'the manager that failed must be named');
    assert.match(message, /not installed, not on PATH, or not executable/);
    assert.match(message, /not a readiness timeout/, 'and it must say what it is not');
    assert.match(message, /--url <url> --skip-preview/);
  }
});
