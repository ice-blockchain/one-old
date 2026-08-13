// src/runners/qa-evidence/__tests__/incomplete-scan-disclosure.test.ts
//
// A diff that could not see everything is EVIDENCE WITH A HOLE IN IT, and this
// runner used to answer that with a total refusal.
//
// The defect, measured on `npm run test:env -- --strict`: two scenarios
// (`sim-existing-supabase-web`, `sim-existing-react-vite-web`) lost 6 and 7
// checks respectively, every one of them to
//
//     qa-evidence: cannot load run — source this project tracks is hidden from
//     the diff by a skipped directory name: dist/assets/app-ca5e0bbf.js
//
// exit code 2, and NOTHING in `.traffic-one/reports/qa/<run>/`. Verified in the
// simulation's own project directory: `git ls-files --cached -- dist` is EMPTY
// (so "source this project tracks" was not even true — the probe also lists
// `--others`, untracked-and-un-ignored), the project's `.gitignore` holds only
// Traffic One's generated block because `ensureProjectGitignore` deliberately
// withholds build-output opinions from a repository with history, and the
// contract's own `scanComplete` was `true`. In other words the run was refused
// over a file its own `npm run build` had written minutes earlier.
//
// The fix is NOT to narrow the detector. `nameSkippedProjectSource` must keep
// listing `--others`, because the exploit it defends against — authored source
// under a directory named `generated`, invisible to both sides of the diff by a
// compile-time name set — requires no commit at all, and
// skip-authority-closure.test.ts plants its files without ever running `git add`.
// The fix is to the CONSEQUENCE: plan-guard already survives this class
// (STRUCT_SCAN_INCOMPLETE plus a pinned contract instead of a deny), and only
// this runner escalated it to a refusal. So it proceeds and DISCLOSES, and the
// disclosure is enforced rather than trusted — see the third test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compileArchitecture } from '../../../shared/architecture-contract';
import { qaReportV2Path, readQaReportV2 } from '../../../shared/qa-report-v2';
import {
  compileVerificationContract,
  currentVerificationSourceHash,
  readVerificationContract,
} from '../../../shared/verification-contract';
import { main } from '../index';
import { loadRun, loadStackRun } from '../run-context';
import { type RunnerArgs } from '../types';

const WEB_STATE = {
  mode: 'existing-codebase',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

const CHANGED = 'apps/web/src/lib/Mapper.ts';

/** The build output the simulation's own Vite run produced, byte-shape and all. */
const VITE_BUNDLE = 'dist/assets/app-ca5e0bbf.js';

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

/**
 * An EXISTING web project with history and a complete contract.
 *
 * The order matters and is the simulation's order: everything is committed
 * first, so the baseline is `git-head`; the one changed file is written after,
 * so it is the whole live diff; and the build output arrives last, which is when
 * the run's build step would have written it. A fixture that created `dist/`
 * before compiling would have tested a contract with `scanComplete: false`,
 * which is a different (and already floor-compensated) situation.
 */
function existingWebProject(root: string): void {
  fs.mkdirSync(path.join(root, 'apps/web/src/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'web',
    dependencies: { react: '19.0.0', vite: '7.0.0' },
    scripts: { build: 'node -e ""', test: 'node -e ""', 'format:check': 'node -e ""' },
  }));
  // Only Traffic One's own block, exactly as `ensureProjectGitignore` leaves an
  // existing repository: no `dist/` line. This is the fixture's whole premise.
  fs.writeFileSync(path.join(root, '.gitignore'), '.traffic-one/runs/\n.traffic-one/reports/\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'qa@example.test');
  git(root, 'config', 'user.name', 'QA Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
}

/** Returns the source hash while the scan is still CLEAN — see the identity assertion below. */
function compileContract(root: string): string {
  const architecture = compileArchitecture(root, 'R', WEB_STATE, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
  });
  fs.writeFileSync(
    path.join(root, CHANGED),
    'export const map = (value: string): string => value;\n',
  );
  const contract = compileVerificationContract(root, 'R', WEB_STATE, architecture, {
    changedPaths: [CHANGED],
  });
  assert.equal(contract.scanComplete, true, 'fixture guard: the CONTRACT must be complete');
  assert.equal(contract.browserRequired, false, 'fixture guard: the stack command owns this verdict');
  const clean = currentVerificationSourceHash(root, contract);
  assert.equal(
    clean.complete,
    true,
    'fixture guard: the live scan must start out complete, so the disclosure below is attributable',
  );
  return clean.hash;
}

/** The build output, un-ignored and never `git add`ed — the measured condition. */
function planBuildOutput(root: string, rel = VITE_BUNDLE): void {
  const top = rel.split('/')[0]!;
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'export const A=1;\n');
  // A sibling with a non-authored extension: it must NOT be named, because a
  // build writes hundreds of those and naming them is how a disclosure becomes
  // noise (see AUTHORED_SOURCE_EXTENSIONS).
  fs.writeFileSync(path.join(root, top, 'index.html'), '<!doctype html>\n');
  assert.equal(
    execFileSync('git', ['-C', root, 'ls-files', '--cached', '--', top], { encoding: 'utf8' }),
    '',
    'fixture guard: the offending file must be UNTRACKED — a `--cached`-only probe would not see it',
  );
  assert.match(
    execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '--', top], { encoding: 'utf8' }),
    new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'fixture guard: and it must be un-ignored, which is what makes git report it',
  );
}

function withProject(fn: (root: string) => Promise<void> | void): Promise<void> | void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-incomplete-scan-'));
  let settled = false;
  try {
    const result = fn(root);
    if (result instanceof Promise) {
      settled = true;
      return result.finally(() => fs.rmSync(root, { recursive: true, force: true }));
    }
    return undefined;
  } finally {
    if (!settled) fs.rmSync(root, { recursive: true, force: true });
  }
}

function onDiskReport(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(qaReportV2Path(root, 'R'), 'utf8')) as Record<string, unknown>;
}

async function capturedRun(argv: readonly string[], root: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = '';
  let stderr = '';
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  // FORWARDED, not swallowed: node:test's reporter flushes through these same
  // descriptors, and a helper that returns `true` without calling through eats
  // whatever record it happens to be writing — the trap
  // inconclusive-evidence.test.ts measured at eight silently vanished tests.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdout += String(chunk);
    return (outWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    stderr += String(chunk);
    return (errWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv, root);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

// THE REPRODUCTION. This exited 2 with an empty QA directory before the change.
test('a build output no rule ignores lets the stack run settle, with the gap disclosed', async () => {
  await withProject(async (root) => {
    existingWebProject(root);
    compileContract(root);
    planBuildOutput(root);

    const run = await capturedRun(['stack', '--project-root', root, '--run-id', 'R'], root);

    assert.equal(run.code, 0, `the run must settle, not refuse: ${run.stderr}`);
    assert.doesNotMatch(
      run.stderr,
      /cannot load run/,
      'the refusal is the defect; a build output the run itself wrote must not cost the whole run',
    );

    // 1. The DURABLE artifact, re-read from disk rather than trusted from the
    //    return value: this is what settlement, the tester completion gate and a
    //    human all open.
    const disk = onDiskReport(root);
    assert.equal(disk.status, 'passed');
    assert.match(
      String(disk.settledWithIncompleteScan),
      /hidden from the diff by a skipped directory name: dist\/assets\/app-ca5e0bbf\.js/,
      'the artifact must name what the diff could not see',
    );
    // The corrected subject. `git ls-files --cached -- dist` is empty in this
    // fixture (asserted above), so "source this project tracks" was false.
    assert.doesNotMatch(String(disk.settledWithIncompleteScan), /this project tracks/);

    // 2. The validator accepts it, and says so out loud on the advisory channel.
    const validated = readQaReportV2(root, 'R');
    assert.equal(validated.ok, true, validated.ok ? '' : `${validated.code}: ${validated.message}`);
    assert.ok(
      validated.ok && validated.advisories.some((entry) => (
        entry.includes('settled on an incomplete diff') && entry.includes(VITE_BUNDLE)
      )),
      `the advisory channel must carry the disclosure, got ${JSON.stringify(validated.ok ? validated.advisories : [])}`,
    );

    // 3. The two human-facing channels the runner writes itself.
    assert.match(run.stderr, /proceeding on an incomplete diff/);
    assert.match(
      run.stdout,
      /settledWithIncompleteScan/,
      'the caller parses stdout; a qualification only a log line carries is one a script cannot see',
    );

    // 4. Attribution: the checks are ordinary and green, so nothing above passed
    //    because the run had also degraded somewhere else.
    assert.deepEqual(
      (disk.checks as Array<Record<string, unknown>>).map((check) => `${check.id}=${check.status}`),
      ['stack-build=passed', 'stack-format=passed', 'stack-test=passed'],
    );
  });
});

// The other loader, and the other three commands. `loadRun` serves `browser`,
// `lighthouse` and `manifest`; `manifest` is the one that needs no Playwright,
// so it is the one that can drive `loadRun` end to end here.
test('the build-manifest loader degrades too, and the manifest command discloses it', async () => {
  await withProject(async (root) => {
    existingWebProject(root);
    const cleanHash = compileContract(root);
    planBuildOutput(root);

    const run = await capturedRun(
      ['manifest', '--project-root', root, '--run-id', 'R', '--build-dir', 'dist'],
      root,
    );
    assert.equal(run.code, 0, `a pure reader must not refuse to print: ${run.stderr}`);
    const printed = JSON.parse(run.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    assert.equal(printed.ok, true);
    assert.match(String(printed.settledWithIncompleteScan), new RegExp(VITE_BUNDLE));
    assert.match(run.stderr, /proceeding on an incomplete diff/);

    // Both loaders, asked directly, so the property is pinned at the seam and
    // not only through one command's plumbing.
    const contract = readVerificationContract(root, 'R');
    assert.ok(contract);
    const args = { projectRoot: root, runId: 'R', buildDir: 'dist' } as RunnerArgs;
    const loadedStack = loadStackRun(args);
    const loaded = loadRun(args);
    assert.equal(loadedStack.ok, true, loadedStack.ok ? '' : loadedStack.reason);
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.reason);
    assert.match(String(loadedStack.ok && loadedStack.run.scanQualification), new RegExp(VITE_BUNDLE));
    assert.match(String(loaded.ok && loaded.run.scanQualification), new RegExp(VITE_BUNDLE));

    // The identity is UNCHANGED by the disclosure: the hash a qualified run
    // publishes is the one the same project produced while its scan was clean.
    // That is what makes this a disclosure rather than a second build identity
    // nobody downstream could reconcile.
    assert.equal(loaded.ok && loaded.run.sourceHash, cleanHash);
    assert.equal(loadedStack.ok && loadedStack.run.sourceHash, cleanHash);

    // And the OBVIOUS repair is still a moved skip authority, not a quiet fix:
    // adding `dist/` to `.gitignore` after baseline capture trades this
    // disclosure for `ignore rules changed since baseline capture`, which is
    // fatal and stays fatal. Asserted because it is the first thing a reader
    // will try after reading the advisory, and they should learn it here rather
    // than from a run that suddenly refuses again for a new reason.
    fs.appendFileSync(path.join(root, '.gitignore'), 'dist/\n');
    const moved = currentVerificationSourceHash(root, contract);
    assert.equal(moved.complete, false);
    assert.equal(moved.qualification, undefined, 'a moved ignore authority is NOT the disclosable class');
    assert.match(String(moved.reason), /ignore rules changed since baseline capture/);
  });
});

// REQUIREMENT: degrading must never let a run report clean, unqualified
// evidence. The disclosure is not a courtesy the producer may drop — a report
// that took the qualified path and omits it is refused, so "proceed" cannot
// silently detach from "and disclose".
test('a report that proceeded on an incomplete diff and hides it is refused', async () => {
  await withProject(async (root) => {
    existingWebProject(root);
    compileContract(root);
    planBuildOutput(root);
    assert.equal(await main(['stack', '--project-root', root, '--run-id', 'R'], root), 0);
    assert.equal(readQaReportV2(root, 'R').ok, true, 'fixture guard: this report is ACCEPTED as published');

    // Same bytes, minus the disclosure. Nothing else changes — not the status,
    // not the checks, not the source hash.
    const report = onDiskReport(root);
    assert.ok(report.settledWithIncompleteScan, 'fixture guard: there must be a disclosure to strip');
    delete report.settledWithIncompleteScan;
    fs.writeFileSync(qaReportV2Path(root, 'R'), JSON.stringify(report));

    const validated = readQaReportV2(root, 'R');
    assert.equal(validated.ok, false, 'an unqualified report over a qualified scan claims evidence it lacks');
    assert.equal(validated.ok === false ? validated.code : '', 'scan-incomplete');
    assert.match(
      validated.ok === false ? validated.message : '',
      /only on a report that says so/,
    );

    // Refused on EVERY read, not once. `scan-incomplete` is deliberately absent
    // from `GATE_ID_FOR_FAILURE` (gates.ts states the rule: a refusal persists
    // when the artifact would otherwise be left claiming something the validator
    // refused), so nothing rewrites the sidecar here — and nothing needs to,
    // because the verdict is recomputed from the LIVE worktree by every reader
    // rather than remembered. Asserted twice for exactly that reason: a
    // refusal that held only until the next read would be no guarantee at all.
    assert.equal(onDiskReport(root).status, 'passed', 'the sidecar keeps its own word; the live check overrides it');
    const again = readQaReportV2(root, 'R');
    assert.equal(again.ok, false);
    assert.equal(again.ok === false ? again.code : '', 'scan-incomplete');
  });
});

// REQUIREMENT: the exploit defence must survive. The mutation here is the
// exploit itself — authored source, not build output, under a derived-sounding
// directory name — and the run must still name it. Degrading the CONSEQUENCE
// must not have degraded the DETECTION.
test('authored source hidden under a derived-sounding name is still named, on a run that settles', async () => {
  await withProject(async (root) => {
    existingWebProject(root);
    compileContract(root);
    // Not a bundle: a hand-written module a reviewer would want to have seen,
    // parked under `generated/` and therefore invisible to both sides of the
    // diff. No `git add`, because the exploit never needed one.
    fs.mkdirSync(path.join(root, 'apps/web/generated'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps/web/generated/Panel.tsx'),
      'export function Panel(){ return <div><b>x</b></div>; }\n',
    );

    const run = await capturedRun(['stack', '--project-root', root, '--run-id', 'R'], root);
    assert.equal(run.code, 0, run.stderr);
    const disk = onDiskReport(root);
    assert.match(
      String(disk.settledWithIncompleteScan),
      /apps\/web\/generated\/Panel\.tsx/,
      'the smuggled source must be named in the durable artifact — this is the defence',
    );
    const validated = readQaReportV2(root, 'R');
    assert.ok(
      validated.ok && validated.advisories.some((entry) => entry.includes('apps/web/generated/Panel.tsx')),
      'and a human must be told, on the channel that reaches them',
    );

    // The detector's own answer is untouched: the diff still reports itself
    // INCOMPLETE. Nothing here relaxed `complete`; only what a consumer does
    // with it changed.
    const contract = readVerificationContract(root, 'R');
    assert.ok(contract);
    const source = currentVerificationSourceHash(root, contract);
    assert.equal(source.complete, false, 'the scan must still describe itself as partial');
    assert.match(String(source.qualification), /apps\/web\/generated\/Panel\.tsx/);
  });
});

// The degradation is NARROW, and this is the assertion that keeps it narrow. A
// symbolic link the scan refused to follow is a scan that cannot say what it
// looked at, which is a different fact from one that can name exactly what it
// stepped over. It must still refuse, and it must still refuse at the loader.
test('an incompleteness that is not the name disclosure still refuses the whole run', async () => {
  await withProject(async (root) => {
    existingWebProject(root);
    compileContract(root);
    fs.mkdirSync(path.join(root, 'outside-tree'), { recursive: true });
    fs.symlinkSync(path.join(root, 'outside-tree'), path.join(root, 'apps/web/src/linked'), 'dir');

    const run = await capturedRun(['stack', '--project-root', root, '--run-id', 'R'], root);
    assert.equal(run.code, 2, 'an unreadable scan is still a refusal');
    assert.match(run.stderr, /cannot load run — symbolic link makes verification scan incomplete/);
    assert.equal(
      fs.existsSync(qaReportV2Path(root, 'R')),
      false,
      'and it publishes nothing, exactly as before',
    );
  });
});

// THE THIRD LOADER. `loadNativeRun` is not reached by any test above, and the
// ruling in the lane report is that it takes the same treatment for the same
// reason: the condition is a property of the DIFF, not of the command, so a
// project state that admits a `stack` run and refuses a `native` one would be
// the same asymmetry this whole change is about, one level down. The population
// is real — the extension set is JS/TS, and a React Native tree carries
// `android/app/build/generated/**/*.js` — so this is not a hypothetical arm.
//
// The verdict asserted here is `blocked-environment`, which is a REFUSAL, and
// deliberately so: the run must reach its OWN verdict about the simulator
// instead of being turned away at the loader over a build artifact. Those are
// different answers with different fixes, and only one of them is true.
test('the native loader degrades too, and the native report carries the disclosure', async () => {
  await withProject(async (root) => {
    fs.writeFileSync(path.join(root, 'Package.swift'), '// swift-tools-version:6.2\n');
    fs.mkdirSync(path.join(root, 'Features'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.traffic-one/runs/\n.traffic-one/reports/\n');
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'qa@example.test');
    git(root, 'config', 'user.name', 'QA Test');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'baseline');

    const state = {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'none',
      backend: 'none',
      mobile: { framework: 'swift-native' },
    };
    const architecture = compileArchitecture(root, 'R', state, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'home-screen', name: 'Home Screen', kind: 'page' }],
    });
    fs.writeFileSync(path.join(root, 'Features/HomeView.swift'), 'struct HomeView {}\n');
    const contract = compileVerificationContract(root, 'R', state, architecture, {
      changedPaths: ['Features/HomeView.swift'],
    });
    assert.equal(contract.nativeAdapter, 'xcode-simulator', 'fixture guard: the native path must be selected');
    assert.equal(
      currentVerificationSourceHash(root, contract).complete,
      true,
      'fixture guard: the scan must start clean',
    );

    // A JS build helper under `build/` — the same class of file, on a project
    // whose own source is Swift.
    planBuildOutput(root, 'build/generated/postinstall.js');

    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-disclosure-bin-'));
    fs.writeFileSync(path.join(bin, 'xcodebuild'), `#!${process.execPath}\n`
      + "process.stderr.write('Unable to find a destination matching the provided destination specifier');\n"
      + 'process.exit(70);\n');
    fs.chmodSync(path.join(bin, 'xcodebuild'), 0o755);
    // PREPENDED, not substituted. The loaders shell out to `git`, and a PATH
    // holding only the fake bin makes the diff fail closed with "Git worktree
    // context could not be resolved" — a real fatal reason, and one that would
    // have made this test pass for entirely the wrong reason had it been
    // asserting a refusal instead of an absence.
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
    try {
      const run = await capturedRun([
        'native', '--run-id', 'R', '--native-command-json', JSON.stringify([
          'xcodebuild', 'test', '-scheme', 'NativeApp',
          '-destination', 'platform=iOS Simulator,name=iPhone 16',
        ]),
      ], root);
      assert.doesNotMatch(
        run.stderr,
        /cannot load native run/,
        'the loader must not turn the run away over a build artifact',
      );
      assert.match(run.stderr, /proceeding on an incomplete diff/);
      assert.equal(run.code, 2, 'the run reaches its OWN verdict: an absent simulator');

      const disk = onDiskReport(root);
      assert.equal(disk.status, 'blocked-environment');
      assert.match(String(disk.settledWithIncompleteScan), /build\/generated\/postinstall\.js/);
      const validated = readQaReportV2(root, 'R');
      assert.equal(
        validated.ok === false ? validated.code : '',
        'blocked-environment',
        'the rejection must be about the simulator, not about the scan',
      );
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

// Both halves at once, because a disclosable gap must not launder a fatal one
// standing beside it. The union of reasons is not "the disclosable one wins".
test('a fatal incompleteness alongside a disclosable one still refuses', async () => {
  await withProject(async (root) => {
    existingWebProject(root);
    compileContract(root);
    planBuildOutput(root);
    // An out-of-contract changed path: real, unauthorized, and nothing to do
    // with a skipped directory name.
    fs.writeFileSync(path.join(root, 'apps/web/src/lib/Sneaky.ts'), 'export const x = 1;\n');

    const run = await capturedRun(['stack', '--project-root', root, '--run-id', 'R'], root);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /changed paths outside verification contract.*Sneaky\.ts/);
  });
});
