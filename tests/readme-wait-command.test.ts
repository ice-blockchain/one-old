// README.md ↔ the onboarding waiter, mechanically.
//
// Same mechanism, and the same reason, as the doctor case in
// readme-claims.test.ts: the waiter is admitted inside a Traffic One session by
// an EXACT-ARGV grammar (tool-classify.ts's onboardingRunnerInvocation), not by
// a filename, so a documented spelling one word off is denied outright — and a
// README that prints a command the product refuses is worse than no README,
// because the reader spends their retries on it. README.md ships to installs
// verbatim (gen/emit/static.ts), so this is shipped advice.
//
// It is a separate file from readme-claims.test.ts only because the waiter
// section was added under a change grant that covered new test files and not
// that one; the two are meant to read as one mechanism and can be merged.
//
// Placeholders are substituted the way a reader is told to substitute them:
// `/absolute/path/to/traffic-one/dist` is the plugin root the grammar itself
// anchors on (onboardingWaitScriptPath), and `/absolute/path/to/project` is any
// absolute project directory — the grammar requires absoluteness and nothing
// more of it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  WIZARD_BANNER_REPRINT_MS,
} from '../src/runners/onboarding-wait/wait-loop';
import { TECH_CLASSIFY_REQUIRED_TOKEN } from '../src/shared/onboarding-server/tech-classify-setup';
import { onboardingWaitScriptPath, usePluginQuestion } from '../src/shared/onboarding-server/wait-command';
import { isOnboardingWaitCommand } from '../src/shared/tool-classify';

const REPO_ROOT = path.resolve(__dirname, '..');
const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const FLAT = README.replace(/\s+/g, ' ');

const DOCUMENTED_PLUGIN_ROOT = '/absolute/path/to/traffic-one/dist';
const DOCUMENTED_PROJECT = '/absolute/path/to/project';
const PROJECT = '/tmp/traffic-one-readme-project';

function documentedWaiterCommands(): string[] {
  return [...README.matchAll(/node [^\n`]*?onboarding-wait\.cjs[^\n`]*/g)].map((match) => match[0]);
}

function resolveForGate(documented: string): string {
  return documented
    .replace(DOCUMENTED_PLUGIN_ROOT, path.dirname(path.dirname(onboardingWaitScriptPath())))
    .replace(DOCUMENTED_PROJECT, PROJECT);
}

test('every waiter command the README prints is one the gate admits', () => {
  const commands = documentedWaiterCommands();
  assert.ok(
    commands.length >= 4,
    `README no longer prints the waiter recovery commands (found ${commands.length})`,
  );
  for (const documented of commands) {
    const command = resolveForGate(documented);
    assert.equal(
      isOnboardingWaitCommand('Bash', { command }),
      true,
      `README prints a waiter command the gate denies: ${documented}\n  (resolved to: ${command})`,
    );
  }
});

// The section's warnings are claims in their own right: if the grammar started
// accepting these, the README would be telling readers to avoid spellings that
// work, and the rules above would be folklore rather than documentation.
test('the spellings the README warns against are the spellings the gate rejects', () => {
  const script = onboardingWaitScriptPath();
  const admitted = `node ${script} ${PROJECT} --timeout-ms 540000`;
  assert.equal(isOnboardingWaitCommand('Bash', { command: admitted }), true, 'baseline must be admitted');
  const rejected: Record<string, string> = {
    'joined with `=` instead of a separate word': `node ${script} ${PROJECT} --timeout-ms=540000`,
    'flag before the project path': `node ${script} --timeout-ms 540000 ${PROJECT}`,
    'a zero value': `node ${script} ${PROJECT} --timeout-ms 0`,
    'a signed value': `node ${script} ${PROJECT} --timeout-ms -1`,
    'a decimal value': `node ${script} ${PROJECT} --timeout-ms 5.5`,
    'the same flag twice': `node ${script} ${PROJECT} --timeout-ms 540000 --timeout-ms 60000`,
    'a relative project path': `node ${script} project --timeout-ms 540000`,
    'a wait-only flag on an exit-fast mode': `node ${script} --bootstrap-only ${PROJECT} --timeout-ms 540000`,
  };
  for (const [why, command] of Object.entries(rejected)) {
    assert.equal(isOnboardingWaitCommand('Bash', { command }), false, `the gate now admits ${why}: ${command}`);
  }
  // The README documents `--interval-ms` under the same rules as `--timeout-ms`,
  // so the pair must actually behave the same way in the grammar.
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node ${script} ${PROJECT} --interval-ms 5000` }), true);
  assert.equal(isOnboardingWaitCommand('Bash', { command: `node ${script} ${PROJECT} --interval-ms=5000` }), false);
});

test('the documented waiter defaults are the runner\'s defaults', () => {
  const documented = (flag: string): number => {
    const match = FLAT.match(new RegExp(`\`--${flag}-ms <n>\` \\| \`(\\d+)\``));
    assert.ok(match, `README no longer documents a default for --${flag}-ms`);
    return Number(match![1]);
  };
  assert.equal(documented('timeout'), DEFAULT_TIMEOUT_MS, 'README states a stale --timeout-ms default');
  assert.equal(documented('interval'), DEFAULT_INTERVAL_MS, 'README states a stale --interval-ms default');
  // The prose restates both in human units beside the numbers.
  assert.ok(FLAT.includes(`(${DEFAULT_TIMEOUT_MS / 60000} minutes)`), 'the stated timeout in minutes is stale');
  assert.ok(FLAT.includes(`(${DEFAULT_INTERVAL_MS / 1000} seconds)`), 'the stated interval in seconds is stale');
});

// The reason the README tells a reader to raise the HOST timeout as well: the
// shipped recipe the agent follows names one figure, and it has to stay above
// the waiter's own default or the host ends the command first.
test('the host-timeout figure the README quotes is the one the shipped recipe asks for', () => {
  const quoted = FLAT.match(/~(\d+) minute \((\d+) ms\) host timeout/);
  assert.ok(quoted, 'README no longer states the host timeout the agent is asked for');
  const hostTimeoutMs = Number(quoted![2]);
  assert.equal(Number(quoted![1]) * 60_000, hostTimeoutMs, 'the README states two different host timeouts');
  assert.ok(
    usePluginQuestion(PROJECT).includes(`${hostTimeoutMs} ms`),
    `the shipped setup recipe no longer asks the agent for a ${hostTimeoutMs} ms timeout`,
  );
  assert.ok(
    hostTimeoutMs > DEFAULT_TIMEOUT_MS,
    'the host timeout must exceed the waiter default, or the waiter can never report its own outcome',
  );
});

// "Run it again and you get the link back" is the recovery this section leans
// on, and it is conditional. Structural pin, in the shape readme-claims.test.ts
// already uses for the pre-consent banner throttle: the two suppressions the
// README names must both still exist, and the throttle must still be the
// constant the README quotes in seconds.
test('the two cases the README says suppress the re-printed banner are the two the runner has', () => {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'runners', 'onboarding-wait', 'wizard-output.ts'),
    'utf8',
  );
  assert.match(source, /if \(wizardOpened\(/, 'the browser-already-open suppression is gone');
  assert.match(source, /if \(emittedWithin\(cwd, bannerMarkerLabel\(rec\.token\), WIZARD_BANNER_REPRINT_MS\)\)/, 'the reprint throttle is gone');
  assert.ok(
    FLAT.includes(`within the last ${WIZARD_BANNER_REPRINT_MS / 1000} seconds`),
    `README states a reprint throttle other than ${WIZARD_BANNER_REPRINT_MS / 1000}s`,
  );
});

test('the three waiter outcomes the README names are the tokens the runner prints', () => {
  const runner = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'runners', 'onboarding-wait', 'index.ts'),
    'utf8',
  );
  for (const token of ['TRAFFIC_ONE_SETUP_COMPLETE', 'TRAFFIC_ONE_SETUP_PENDING']) {
    assert.ok(runner.includes(`'${token}\\n'`), `the waiter no longer prints ${token}`);
    assert.ok(FLAT.includes(`\`${token}\``), `README no longer documents the ${token} outcome`);
  }
  // The third is emitted through its shared constant rather than a literal.
  assert.ok(runner.includes('TECH_CLASSIFY_REQUIRED_TOKEN'), 'the waiter no longer emits the classify token');
  assert.ok(FLAT.includes(`\`${TECH_CLASSIFY_REQUIRED_TOKEN}\``), 'README no longer documents the classify outcome');
});
