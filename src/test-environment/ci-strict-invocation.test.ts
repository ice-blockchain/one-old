// Every `npm run test:env` invocation committed under .github/workflows must be
// ABLE to pass on a green tree.
//
// It was not: `npm run test:env -- --strict` selects defaultConfig().enabledHosts
// = [claude, codex, cursor], cursor is `contract+manual-e2e`, and with no
// --manual-cert-dir its record loads MISSING -> manualUncertified = 1 ->
// releaseResultFailed(summary, true) -> exit 1, on every commit, with every
// assertion PASS. A job that is red on a green tree is worse than no job.
//
// This reads the ACTUAL command lines out of the workflow files rather than
// restating them, so editing the workflow — adding a manual-certification host
// back to --host=, dropping the flag entirely, adding a second strict
// invocation — fails here instead of on the next push.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertion as delegationAssertion } from './assertions/opencode-delegation.assert';
import { ALL_CASE_IDS } from './config/cases';
import { ALL_HOSTS, defaultConfig } from './config/test-config';
import { casesRunningAssertion, usageIfNoCases } from './core/case-selection';
import { UsageError, applyFlags, excludedHostNotes, parseFlags } from './core/flags';
import { releaseResultFailed } from './core/result-policy';
import {
  loadManualHostCertifications,
  selectedManualCertificationHosts,
} from './manual-host-certification';
import { writeReport } from './reporting/aggregate-report';
import type { Assertion, CaseRunResult } from './core/types';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

interface Invocation { file: string; argv: string[]; }

function workflowInvocations(): Invocation[] {
  const found: Invocation[] = [];
  for (const name of fs.readdirSync(WORKFLOWS).sort()) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const text = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8');
    for (const line of text.split('\n')) {
      // Only `run:` steps — a `#` comment mentioning the command is prose.
      const match = /^\s*run:\s*npm run test:env\b(.*)$/.exec(line);
      if (!match) continue;
      const rest = (match[1] ?? '').trim();
      const argv = rest.replace(/^--\s*/, '').split(/\s+/).filter(Boolean);
      found.push({ file: name, argv });
    }
  }
  return found;
}

// One PASS assertion on a pure-node target: exactly the shape this job's cases
// produce (host-e2e is off without --e2e, so every planned target is
// 'pure-node'), and the best case the job can ever reach. If the exit contract
// fails HERE it can never succeed in CI.
function greenRun(): CaseRunResult[] {
  return [{
    caseId: 'ci-strict-invocation-fixture',
    category: 'run-sim',
    layer: 'run-sim',
    host: 'pure-node',
    runFolder: path.join(os.tmpdir(), 't1-ci-strict-fixture'),
    hostResult: { status: 'COMPLETED', exitCode: 0, durationMs: 1 },
    assertions: [{ id: 'fixture', title: 'everything passed', status: 'PASS', detail: '' }],
    startedAt: '2026-08-04T12:00:00.000Z',
    finishedAt: '2026-08-04T12:00:01.000Z',
  }];
}

test('every committed CI test:env invocation can exit 0 on an all-PASS run', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ci-strict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const invocations = workflowInvocations();
  assert.ok(
    invocations.length > 0,
    'no `run: npm run test:env` step found under .github/workflows — if the job was removed, remove this test with it',
  );

  for (const [index, { file, argv }] of invocations.entries()) {
    const config = applyFlags(defaultConfig(), parseFlags(argv));
    const label = `${file}: npm run test:env -- ${argv.join(' ')}`;

    // The release fingerprint is computed from the freshly built dist at run
    // time (build-and-install.ts), so it is never a value a committed record
    // could have been written against; any non-empty stand-in is faithful here.
    const certifications = loadManualHostCertifications(
      config.manualCertDir,
      config.enabledHosts,
      'sha256:fingerprint-of-the-bytes-this-job-just-built',
      config.strict,
    );
    const uncertifiable = certifications.filter((outcome) => !outcome.certified);
    assert.deepEqual(
      uncertifiable.map((outcome) => `${outcome.host} (${outcome.loadStatus}: ${outcome.errors.join('; ')})`),
      [],
      `${label} selects a host whose release evidence this job cannot produce.\n`
      + `Hosts needing a manual record: [${selectedManualCertificationHosts(config.enabledHosts).join(', ')}].\n`
      + 'Either scope --host= to the hosts CI can drive live, or supply --manual-cert-dir with records '
      + 'bound to the fingerprint of the bytes this job builds — which no committed record can be, since '
      + 'dist/build-provenance.json changes every commit.',
    );

    const summary = writeReport(
      greenRun(),
      config,
      '2026-08-04T12:00:00.000Z',
      path.join(dir, `run-${index}`),
      certifications,
      'sha256:fingerprint-of-the-bytes-this-job-just-built',
    );
    assert.equal(summary.fail, 0, `${label}: fixture run was not all-PASS`);
    assert.equal(
      releaseResultFailed(summary, config.strict),
      false,
      `${label} exits non-zero on a fully green tree`
      + ` (skip=${summary.skip} inconclusive=${summary.inconclusive} unsupported=${summary.unsupported}`
      + ` hostUncertified=${summary.hostUncertified} manualUncertified=${summary.manualUncertified})`,
    );
  }
});

// A committed invocation that narrows `--host=` narrows COVERAGE, and the job
// name ("Full composition (test:env --strict)") does not say so. The run has to
// say so itself: a release manager reading a green check must be able to see
// which hosts were not proven without opening a workflow file.
test('every committed CI test:env invocation names the hosts it does not cover', () => {
  for (const { file, argv } of workflowInvocations()) {
    const config = applyFlags(defaultConfig(), parseFlags(argv));
    const notes = excludedHostNotes(config);
    const covered = config.enabledHosts.length === ALL_HOSTS.length
      && selectedManualCertificationHosts(config.enabledHosts).length === 0;
    if (covered) {
      assert.deepEqual(notes, [], `${file}: nothing is excluded, so nothing should be announced`);
      continue;
    }
    assert.ok(
      notes.length > 0,
      `${file}: npm run test:env -- ${argv.join(' ')} leaves hosts unproven and the run announces nothing`,
    );
    for (const host of ALL_HOSTS.filter((h) => !config.enabledHosts.includes(h))) {
      assert.ok(
        notes.some((note) => note.includes(host)),
        `${file}: ${host} is excluded but not named in the run output: ${notes.join(' | ')}`,
      );
    }
  }
});

// The typo that bought a green run: `--host=cursr` filtered to [], applyFlags
// skips an empty list, and the job then ran the DEFAULT host set and reported
// success — so the invocation that passed was not the one anybody wrote.
// src/build/sync-hosts.ts already refuses this ("an unknown host is a usage
// error, never a silent fall-through to all hosts"); the two parsers now agree.
test('an unknown host, category or flag is a usage error, never a silent fall-through to the defaults', () => {
  for (const argv of [['--host=cursr'], ['--host=claude,cursr'], ['--host'], ['--host=']]) {
    assert.throws(() => parseFlags(argv), UsageError, `parseFlags(${JSON.stringify(argv)}) must not fall through`);
  }
  assert.throws(() => parseFlags(['--category=run-simulation']), UsageError);
  // A misspelled flag is the same defect one level up.
  assert.throws(() => parseFlags(['--hostt=cursor']), UsageError);
  assert.throws(() => parseFlags(['--strictt']), UsageError);
  // The error names the alternatives, so the message is actionable on its own.
  assert.throws(() => parseFlags(['--host=cursr']), (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, /unknown --host value "cursr"/);
    assert.match(err.message, /claude, codex, cursor/);
    return true;
  });
  // Control: every flag the docs and the workflows use still parses.
  assert.deepEqual(parseFlags(['--strict', '--host=claude,codex']).hosts, ['claude', 'codex']);
  assert.deepEqual(parseFlags(['--category=run-sim']).categories, ['run-sim']);
  assert.equal(parseFlags(['--dry-run']).dryRun, true);
});

// `--case=` used to silently filter: empty → [], unknown ids → a list that
// selectRuns then matched against nothing. requireKnown throws first, so an
// unknown id never becomes an empty planned set. run.ts still guards
// planned.length === 0 / results.length === 0 via usageIfNoCases (a real
// `--category=` + host/layer combination can still select nothing).
test('--case= rejects empty and unknown ids, and accepts a real ALL_CASE_IDS entry', () => {
  assert.throws(() => parseFlags(['--case=']), UsageError);
  assert.throws(() => parseFlags(['--case']), UsageError);
  assert.throws(() => parseFlags(['--case=not-a-real-case']), UsageError);
  assert.throws(() => parseFlags(['--case=not-a-real-case']), (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, /unknown --case value "not-a-real-case"/);
    return true;
  });
  const known = ALL_CASE_IDS[0];
  assert.ok(known, 'ALL_CASE_IDS must not be empty');
  assert.deepEqual(parseFlags([`--case=${known}`]).cases, [known]);
});

test('usageIfNoCases is exit 2 on an empty planned set and silent otherwise', () => {
  assert.equal(usageIfNoCases([]), 2);
  assert.equal(usageIfNoCases([{ caseId: 'x', targets: ['pure-node'] }]), null);
});

// Lives here because this is the file that reads committed workflow command
// lines instead of restating them. `plugin:check` is the composite AGENTS.md
// puts in the maintainer chain, and CI used to run its two halves under their
// own names — so the wrapper itself, including the `&&` that makes the second
// half conditional on the first, was executed by nothing. A script CI never
// runs is a script whose chaining nobody checks.
test('the plugin:check composite is executed by CI under its own name, and is not hollow', () => {
  const scripts = new Set<string>();
  for (const name of fs.readdirSync(WORKFLOWS).sort()) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    for (const line of fs.readFileSync(path.join(WORKFLOWS, name), 'utf8').split('\n')) {
      // A `#` line mentioning the command is prose, not an invocation. Non-comment
      // lines cover both `run: npm run x` and the body of a `run: |` block.
      if (/^\s*#/.test(line)) continue;
      for (const match of line.matchAll(/npm run ([a-z][a-z0-9:._-]*)/g)) scripts.add(match[1] as string);
    }
  }
  assert.ok(
    scripts.has('plugin:check'),
    `no workflow invokes \`npm run plugin:check\`; CI runs [${[...scripts].sort().join(', ')}].`
    + ' Invoke the composite or delete it from package.json — do not run its halves and leave it dead.',
  );

  const defined = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as
    { scripts: Record<string, string> }).scripts['plugin:check'];
  assert.ok(defined, 'package.json no longer defines plugin:check, but a workflow still invokes it');
  for (const half of ['gen:check', 'build:verify']) {
    assert.ok(
      defined!.includes(half),
      `plugin:check no longer runs ${half} (it is "${defined}"), so the CI step named after it proves less than it says`,
    );
  }
});

// A coverage floor is only a floor over the run it was keyed to.
// config/cases/delegation-channel.test.ts seeds and measures every case a
// DEFAULT run reaches, which is the right question for `npm test` and says
// nothing about CI: a workflow that narrows `--category=` or `--case=` can
// deselect the measured case and leave that floor green while the job it is
// supposed to protect stops exercising the channel entirely.
//
// So this asks the same question of the command lines actually committed. It
// does not re-seed anything — it compares SELECTION, which is the only thing a
// workflow flag can change — and it asks casesRunningAssertion(), the same
// selector the floor uses, so the two cannot drift about what "reachable" means.
//
// Generalizes as written: any assertion added to CHANNEL_FLOORS is covered on
// every committed invocation without touching this test.
const CHANNEL_FLOORS: { assertion: Pick<Assertion, 'id' | 'appliesTo'>; floor: string }[] = [
  { assertion: delegationAssertion, floor: 'config/cases/delegation-channel.test.ts' },
];

test('every committed CI test:env invocation still reaches the cases the coverage floors measure', () => {
  const invocations = workflowInvocations();
  assert.ok(invocations.length > 0, 'no `run: npm run test:env` step found under .github/workflows');

  for (const { assertion, floor } of CHANNEL_FLOORS) {
    const measured = casesRunningAssertion(assertion, defaultConfig()).map((c) => c.id);
    // Guards the guard: if the default population is empty this test would pass
    // vacuously for every invocation, and the floor itself is what should report
    // that — so fail here naming the floor rather than certifying nothing.
    assert.ok(
      measured.length > 0,
      `no case reaches the \`${assertion.id}\` assertion on a default run, so this test is vacuous.`
      + ` ${floor} is the file that owns that failure; fix it there.`,
    );

    for (const { file, argv } of invocations) {
      const config = applyFlags(defaultConfig(), parseFlags(argv));
      const reached = new Set(casesRunningAssertion(assertion, config).map((c) => c.id));
      const dropped = measured.filter((id) => !reached.has(id));
      assert.deepEqual(
        dropped,
        [],
        `${file}: npm run test:env -- ${argv.join(' ')} does not reach [${dropped.join(', ')}],`
        + ` the case(s) ${floor} seeds and measures for the \`${assertion.id}\` channel.\n`
        + 'That floor is keyed to a DEFAULT run, so it stays green while this job stops exercising the channel.\n'
        + 'FIX: widen the invocation, or move the floor onto the narrowed run — do not delete this assertion.',
      );
    }
  }
});

// The complement: the gate still bites. If a manual-certification host is
// selected without evidence, strict MUST fail — otherwise the fix above would
// have been "make --strict lenient", which is the opposite of what it is for.
test('selecting a manual-certification host with no record still fails strict', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ci-strict-negative-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = applyFlags(defaultConfig(), parseFlags(['--strict']));
  assert.deepEqual(config.enabledHosts, ['claude', 'codex', 'cursor']);
  const certifications = loadManualHostCertifications(
    config.manualCertDir,
    config.enabledHosts,
    'sha256:release',
    config.strict,
  );
  assert.deepEqual(certifications.map((outcome) => outcome.host), ['cursor']);
  assert.equal(certifications[0]?.loadStatus, 'MISSING');

  const summary = writeReport(
    greenRun(),
    config,
    '2026-08-04T12:00:00.000Z',
    path.join(dir, 'run'),
    certifications,
    'sha256:release',
  );
  assert.equal(summary.manualUncertified, 1);
  assert.equal(releaseResultFailed(summary, true), true);
});
