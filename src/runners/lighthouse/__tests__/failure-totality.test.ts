// src/runners/lighthouse/__tests__/failure-totality.test.ts
// FOR EVERY ERROR, A LINE. index.mts states that this runner must NEVER exit
// without one final JSON status line, and its watchdog exists to keep that
// promise for a hang — but the failure path guarded the line with
// `if (classifyBlockedStatus(message))`, a PARTIAL function in front of a TOTAL
// contract. Every message it did not recognise exited with EMPTY stdout: three by
// known routes (missing Next build metadata, no URL to audit, a failed build) and
// every future `throw` by default.
//
// `src/modules/page-speed/handler.ts` reads that line out of the tool response and
// has no other channel, so an empty stdout does not read as "the audit failed" —
// it reads as "no Lighthouse result was mentioned", and page speed goes
// UNREPORTED rather than UNVERIFIED. Which is the same shape as the uncaught spawn
// error the sibling suite pins, reached politely.
//
// These rows are written as PROPERTIES over the classifier's domain, on purpose.
// A row listing today's three messages would pass against a classifier that
// answers those three and nothing else, which is the state this file exists to
// forbid — the hole was never those messages, it was the default.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { RUNNER_STATUSES, classifyBlockedStatus, classifyRunnerFailure } from '../lib';

const TEST_TIMEOUT_MS = 60_000;
const tmpDirs: string[] = [];

after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function repoRoot(): string {
  return process.env.TRAFFIC_ONE_PLUGIN_ROOT || process.cwd();
}

/**
 * A deterministic sample of the classifier's DOMAIN, which is `string`.
 *
 * Seeded rather than random: a property row that fails only on some machines is a
 * flake, and the point of the row is that the answer cannot depend on the input at
 * all. The adversarial entries are the shapes that break classifiers in practice —
 * empty, whitespace-only, a stack trace, something long enough to make a regex
 * pathological, text that merely CONTAINS a status name, and the message shapes
 * this runner throws with their interpolations filled in.
 */
function domainSample(): string[] {
  let seed = 0x5eed;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return seed;
  };
  const alphabet = ' \t\n{}"\':;,.-_/\\()[]$abcdefgHIJKLM0123456789ÄöÜ✓漢';
  const random: string[] = [];
  for (let i = 0; i < 400; i += 1) {
    const length = next() % 120;
    let out = '';
    for (let c = 0; c < length; c += 1) out += alphabet[next() % alphabet.length];
    random.push(out);
  }
  return [
    '',
    ' ',
    '\n\n',
    '\u0000',
    'x',
    'undefined',
    'null',
    '[object Object]',
    '{"status":"blocked:sandbox"}',
    'status blocked:timeout was mentioned inside prose',
    'failed:unclassified',
    'Error: something nobody has thought of yet',
    'TypeError: Cannot read properties of null (reading \'audits\')',
    'a'.repeat(200_000),
    '('.repeat(2_000),
    ...random,
  ];
}

/**
 * TOTALITY, as a property: every string gets a status this runner declares.
 *
 * Membership rather than non-nullness, because "always returns something" is too
 * weak to be worth pinning — a classifier returning `undefined`, or a spelling
 * only a cast made possible, would satisfy it and still hand the page-speed hook
 * a status it does not know. And the assertion is on the STATUS SET, so a new arm
 * must be declared in `RUNNER_STATUSES` to be legal, which is what makes the
 * caller-side review of a new status possible at all.
 */
test('every possible error message is assigned a declared status', () => {
  for (const message of domainSample()) {
    const status = classifyRunnerFailure(message);
    assert.ok(
      RUNNER_STATUSES.includes(status),
      `classifyRunnerFailure(${JSON.stringify(message.slice(0, 60))}) answered ${JSON.stringify(status)}, which is not a declared status`,
    );
  }
});

/**
 * The same corpus proves the row above is not vacuous, WITHOUT a mutation.
 *
 * `classifyBlockedStatus` is still partial, deliberately — it answers the narrower
 * question the page-speed hook's sandbox-escalation branch needs, "is this an
 * environment gap" — and it is the function the status line used to be gated on.
 * Running the corpus through it reproduces the pre-change behaviour permanently:
 * the overwhelming majority of the domain was recognised by nothing and therefore
 * printed nothing. If some future widening ever makes this function total, this
 * row fails and says so, because at that point the two functions have collapsed
 * into one and the distinction this file documents is gone.
 */
test('the classifier the line used to be gated on is still partial, which is what the property guards', () => {
  const sample = domainSample();
  const unrecognised = sample.filter((message) => classifyBlockedStatus(message) === null);
  assert.ok(
    unrecognised.length > sample.length / 2,
    'fixture guard: most of the domain must be unrecognised for this to be the before-state',
  );
  // The three the round was called for, by their real wording.
  for (const message of [
    'Next production build metadata is missing at /app/.next/BUILD_ID; run the build before Lighthouse preview.',
    'No URL to audit. Provide --url or allow the runner to start preview.',
    'pnpm run build failed with exit 1\nsyntax error',
  ]) {
    assert.equal(classifyBlockedStatus(message), null, 'fixture guard: this is one of the messages that printed no line');
    assert.equal(classifyRunnerFailure(message), 'failed:project');
  }
});

/**
 * No recognised message changed its status. As a property over the domain rather
 * than as a list: wherever the old classifier had an answer, the total one must
 * give the same answer, so `blocked:*` semantics — including the preview branch
 * ranking above the sandbox branch, which a package manager without its execute
 * bit depends on — survive by construction and not by review.
 */
test('the total classifier never overrides a status the blocked classifier already assigned', () => {
  let agreements = 0;
  for (const message of [
    ...domainSample(),
    'listen EPERM: operation not permitted "127.0.0.1"',
    'fetch failed: ECONNREFUSED',
    'You have hit your usage limit',
    'lighthouse http://x timed out after 120000ms',
    'Preview did not become ready within 90000ms: http://127.0.0.1:4173/',
    'No local Lighthouse binary (node_modules/.bin/lighthouse)',
    'The preview command could not be executed: spawn pnpm ENOENT.',
  ]) {
    const blocked = classifyBlockedStatus(message);
    if (!blocked) continue;
    agreements += 1;
    assert.equal(classifyRunnerFailure(message), blocked, `${blocked} must not be reclassified`);
  }
  assert.ok(agreements >= 7, 'fixture guard: the row must actually exercise the recognised arms');
});

/**
 * Every `new Error(` SITE IN THE RUNNER, found by scanning its source rather than
 * by listing what someone remembered.
 *
 * This is the row that catches the NEXT unhandled message, which is the failure
 * mode of the enumeration this file replaces. Adding a `throw new Error('…')` to
 * the runner fails here until its message either earns a real status or is
 * declared terminal on purpose below — the decision is forced at the moment the
 * throw is written, instead of being discovered by a caller that got no line.
 */
const TERMINAL_BY_DESIGN: readonly { fragment: string; why: string }[] = [
  {
    fragment: 'failed with exit',
    why: 'runCommand reports the build script AND the audit child in one wording; the build half is '
      + 'matched as failed:project by name, and what is left is Lighthouse exiting non-zero, where the '
      + 'page, the CLI and Chrome are all live candidates and a guess would misdirect the repair',
  },
  {
    fragment: 'no JSON report was found',
    why: 'the audit finished and left no artifact: could be the CLI, the flags, or a killed Chrome — '
      + 'unattributable from here, and the message carries the directory that is empty',
  },
  {
    fragment: 'Could not read Lighthouse report',
    why: 'same class as above, one step later — the file exists and does not parse',
  },
];

// Message builders live in cli-args.ts with their own canonical wording and their
// own rows in preview-start-failure.test.ts / lighthouse.test.ts; the scan needs
// to know they are classified, not to re-render them.
const CLASSIFIED_BUILDERS = new Set(['lighthouseMissingMessage', 'previewCommandMissingMessage']);

test('every error site in the runner source is classified, or terminal on purpose', () => {
  const source = fs.readFileSync(path.join(repoRoot(), 'src/runners/lighthouse/index.mts'), 'utf8');
  const total = source.match(/new Error\(/g)?.length ?? 0;
  assert.ok(total >= 8, `fixture guard: the scan must find the runner's throw sites (found ${total})`);

  const sites = /new Error\(\s*(?:(['"`])([\s\S]*?)\1|([A-Za-z_$][\w$]*)\()/g;
  const terminal = new Set<string>();
  let seen = 0;
  for (let match = sites.exec(source); match; match = sites.exec(source)) {
    seen += 1;
    const builder = match[3];
    if (builder) {
      assert.ok(
        CLASSIFIED_BUILDERS.has(builder),
        `${builder}() builds an error message the classifier has never been shown`,
      );
      continue;
    }
    // An interpolation stands in for any value it could hold; the digits matter
    // because one arm keys on an exit code.
    const rendered = String(match[2]).replace(/\$\{[^{}]*\}/g, '7');
    const status = classifyRunnerFailure(rendered);
    assert.ok(RUNNER_STATUSES.includes(status), `${JSON.stringify(rendered.slice(0, 50))} answered ${status}`);
    if (status !== 'failed:unclassified') continue;
    const declared = TERMINAL_BY_DESIGN.find((entry) => rendered.includes(entry.fragment));
    assert.ok(
      declared,
      `this runner throws ${JSON.stringify(rendered.slice(0, 80))} and nothing classifies it. Give it a `
      + 'status, or add it to TERMINAL_BY_DESIGN with the reason no status can be attributed.',
    );
    terminal.add(declared.fragment);
  }
  assert.equal(seen, total, 'the scan must account for every error site, not the ones it could parse');
  for (const entry of TERMINAL_BY_DESIGN) {
    assert.ok(terminal.has(entry.fragment), `TERMINAL_BY_DESIGN entry "${entry.fragment}" matches no site left unclassified`);
  }
});

interface RunnerResult { code: number | null; stdout: string; stderr: string }

/**
 * The runner as its own process — the contract is about what a PROCESS leaves on
 * stdout, and `index.mts` runs `main()` in its module body, so it cannot be asked
 * in-process. Same reason the sibling suite drives its rows through a child.
 */
async function runRunner(dir: string, extraArgs: readonly string[], preload?: string): Promise<RunnerResult> {
  const runner = path.join(repoRoot(), 'src/runners/lighthouse/index.mts');
  const loader = path.join(repoRoot(), 'node_modules/tsx/dist/loader.mjs');
  for (const required of [runner, loader]) {
    assert.ok(fs.existsSync(required), `fixture guard: this row must drive the real runner, not ${required}`);
  }
  const child = spawn(process.execPath, [
    '--import', pathToFileURL(loader).href,
    // node's own preload, so nothing test-only is added to the runner's CLI.
    ...(preload ? ['--import', preload] : []),
    runner,
    '--skip-build',
    '--max-runtime', '40000',
    ...extraArgs,
  ], { cwd: dir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function statusOf(result: RunnerResult): string {
  assert.ok(result.stdout.trim().length > 0, `the runner exited with EMPTY stdout; stderr was:\n${result.stderr}`);
  const line = JSON.parse(result.stdout) as { status?: string };
  return String(line.status);
}

/**
 * A project fault, end to end: an unbuilt Next app. Before the fix this exited 1
 * with the message on stderr and nothing on stdout, which is a run the page-speed
 * hook never hears about.
 *
 * `failed:project` rather than a `blocked:*` arm because the two prefixes answer
 * different questions and the caller acts on the difference: `blocked:*` means the
 * host stopped the measurement and the agent should say page speed is unverified
 * and move on, while this means the host was fine and the repository was not
 * auditable. Filing an unbuilt app under the environment vocabulary would let a
 * missing build read as somebody else's problem, which is the laundering this
 * runner's bounds exist to prevent.
 */
test('an unbuilt Next project reports failed:project instead of exiting silently', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lh-unbuilt-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'unbuilt-next', private: true, dependencies: { next: '15.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'next.config.js'), 'module.exports = {};\n');
  const result = await runRunner(dir, []);
  assert.equal(statusOf(result), 'failed:project');
  assert.match(result.stdout, /BUILD_ID/, 'the line must carry the repair, not just the class');
  assert.equal(result.code, 1);
});

/**
 * The terminal arm, end to end: an audit that finishes and leaves no report. The
 * stub exits 0 and writes nothing, which is the shape of a Lighthouse whose
 * Chrome died — and `failed:unclassified` is the honest answer, because the
 * runner cannot tell the page from the CLI from the host here. It still gets a
 * line, which is the whole point: the caller learns the audit did not produce a
 * result, and the message names the empty directory.
 */
test('an unattributable failure still reports a line, as failed:unclassified', { timeout: TEST_TIMEOUT_MS }, async () => {
  if (process.platform === 'win32') return; // the stub is an executable-bit shebang script
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lh-noreport-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'silent-lighthouse', private: true, devDependencies: { vite: '^5.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {};\n');
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'lighthouse'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  fs.chmodSync(path.join(bin, 'lighthouse'), 0o755);
  const result = await runRunner(dir, ['--url', 'http://127.0.0.1:9/', '--skip-preview']);
  assert.equal(statusOf(result), 'failed:unclassified');
  assert.match(result.stdout, /no JSON report was found/);
  assert.equal(result.code, 1);
});

/**
 * The path that does NOT go through `main`'s rejection: an error thrown from a
 * listener, which node takes straight to the default handler — stack on stderr,
 * nothing on stdout, dead. That is the hole a missing spawn `error` listener fell
 * through, and the reason there is a top-level handler at all: totality that
 * depended on every future listener being careful would be the same partial
 * compensation in a different place.
 *
 * Injected rather than provoked, because there is no error left in this runner
 * that reaches that path — which is the point. The throw is scheduled from a
 * preloaded module while the real runner is mid-audit against a stub that sleeps,
 * so the exception is genuinely uncaught inside the real process.
 */
test('an error thrown outside the promise chain still leaves a line', { timeout: TEST_TIMEOUT_MS }, async () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lh-uncaught-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'uncaught-host', private: true, devDependencies: { vite: '^5.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {};\n');
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  // Holds the runner open long enough for the injected throw to land inside it.
  fs.writeFileSync(path.join(bin, 'lighthouse'), '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 4000);\n');
  fs.chmodSync(path.join(bin, 'lighthouse'), 0o755);
  const inject = path.join(dir, 'inject.mjs');
  fs.writeFileSync(inject, 'setTimeout(() => { throw new Error("injected asynchronous failure"); }, 1200);\n');

  const result = await runRunner(
    dir,
    ['--url', 'http://127.0.0.1:9/', '--skip-preview'],
    pathToFileURL(inject).href,
  );
  assert.doesNotMatch(result.stdout, /no JSON report was found/, 'fixture guard: the injected throw must win the race, not the stub finishing');
  assert.equal(statusOf(result), 'failed:unclassified');
  assert.match(result.stdout, /injected asynchronous failure/, 'the message is all a reader gets for an unanticipated error, so it must survive');
  assert.equal(result.code, 1);
});

/**
 * Totality must not become a second line. The hook takes the LAST JSON object on
 * stdout, so a failure status printed after a completed audit does not add
 * information — it REPLACES a measured verdict with a crash report, which is the
 * one direction worse than silence. The handler above therefore yields to a
 * verdict that is already out.
 *
 * The stub writes the report Lighthouse would have written, so this is a real
 * successful run of the runner, and the throw is scheduled off the verdict write
 * itself rather than off a clock, so the ordering is not a race.
 */
test('a late error never overwrites a verdict that was already printed', { timeout: TEST_TIMEOUT_MS }, async () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lh-late-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'late-error', private: true, devDependencies: { vite: '^5.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {};\n');
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  const report = JSON.stringify({
    categories: {
      performance: { score: 0.9 }, accessibility: { score: 0.95 }, 'best-practices': { score: 0.95 }, seo: { score: 0.95 },
    },
    audits: {
      'first-contentful-paint': { numericValue: 900, displayValue: '0.9 s' },
      'largest-contentful-paint': { numericValue: 1200, displayValue: '1.2 s' },
      'total-blocking-time': { numericValue: 50, displayValue: '50 ms' },
      'cumulative-layout-shift': { numericValue: 0.01, displayValue: '0.01' },
    },
  });
  fs.writeFileSync(path.join(bin, 'lighthouse'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const flag = process.argv.find((a) => a.startsWith('--output-path='));",
    "fs.writeFileSync(`${flag.slice('--output-path='.length)}.report.json`, process.env.T1_STUB_REPORT);",
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'lighthouse'), 0o755);
  const inject = path.join(dir, 'inject.mjs');
  fs.writeFileSync(inject, [
    'const original = process.stdout.write.bind(process.stdout);',
    'process.stdout.write = (chunk, ...rest) => {',
    '  const answer = original(chunk, ...rest);',
    "  if (String(chunk).includes('\"buildMode\"')) setTimeout(() => { throw new Error('late listener failure'); }, 0);",
    '  return answer;',
    '};',
    '',
  ].join('\n'));

  process.env.T1_STUB_REPORT = report;
  let result: RunnerResult;
  try {
    result = await runRunner(dir, ['--url', 'http://127.0.0.1:9/', '--skip-preview'], pathToFileURL(inject).href);
  } finally {
    delete process.env.T1_STUB_REPORT;
  }
  assert.match(result.stderr, /late listener failure/, 'fixture guard: the late error must actually have been raised');
  assert.match(result.stdout, /"buildMode"/, 'fixture guard: the row is about a run that reached its verdict');
  assert.doesNotMatch(result.stdout, /failed:unclassified/, 'a measured audit must not be reported as a crash');
  const objects = result.stdout.split('\n}').filter((part) => part.includes('{'));
  assert.match(String(objects.at(-1)), /"performance"/, 'the LAST object on stdout — the one the hook reads — must still be the audit');
});
