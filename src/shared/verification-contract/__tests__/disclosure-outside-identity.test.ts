// src/shared/verification-contract/__tests__/disclosure-outside-identity.test.ts
//
// Round one stopped `qa-evidence` refusing a run over a skipped directory name.
// It did not stop the same fact CHURNING THE CONTRACT, and that moved the
// failure rather than clearing it: `test:env --strict` stayed at PASS 137 · FAIL
// 13, same two scenarios, entirely different assertions.
//
//     Verification refresh gate: `APPROVED` is forbidden because runtime raised
//     VerificationContractV2 from the final implementation diff; the current
//     review bootstrap predates that contract.
//
//     run-sim-qa-evidence: The published QA report was rejected by its own
//     validator (contract-mismatch: QA report does not belong to the active
//     verification contract.)
//
// Measured in both scenarios' own run directories: the published contract
// carried `scanComplete: false` with a `scanReason` naming
// `dist/assets/app-ca5e0bbf.js`, `observedChangedPaths` was 12 entries with NO
// `dist/` path among them, and `uiImpactPinned` was ABSENT — both projects
// derived `visual` from their own evidence, so the truncated-scan floor moved no
// value whatsoever. The FLAG churned the contract; the diff never grew.
//
// Which breaks the chain of custody, because the trigger is the run's own build
// output: `dist/` appears when QA builds for build identity, so the reviewer's
// refresh is the FIRST compile that sees it. It republishes a new hash, the
// review bootstrap now predates the contract, and the QA report that validated
// minutes earlier belongs to a contract that is no longer active.
//
// So the disclosure leaves contract identity. It is not truncation — the walk
// finished and can name what it stepped over — and this file drives the four
// facts that has to mean, including the one that must NOT change: a scan
// genuinely truncated by a bound keeps its floor, its `scanReason`, its ledger
// entry and its churn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  architectureInputPath,
  compileArchitectureForRun,
} from '../../architecture-contract';
import { readQualityFindings } from '../../state/quality-findings';
import {
  changedPathsFromBaseline,
  compileVerificationContract,
  currentVerificationSourceHash,
  skipNameDisclosure,
} from '../index';
// Cross-layer on purpose: this consumer is the one the defect was measured at,
// and asserting the classifier instead would be asserting my own edit back.
// Sibling precedent under src/shared/**/__tests__ (tool-scope-fence,
// deny-signature-plugin-root, refusal-reporting) imports modules the same way.
import { refreshVerificationAfterImplementation } from '../../../modules/plan-guard/plan-readiness/contracts';

/** The build output the simulation's own Vite run produced, byte-shape and all. */
const VITE_BUNDLE = 'dist/assets/app-ca5e0bbf.js';

const STATE = {
  mode: 'existing-codebase',
  stack: 'custom-frontend',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
  onboardingComplete: true,
  currentRunId: 'R',
  team: { mode: 'main-agent' },
};

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function withProject(fn: (root: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-disclosure-identity-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An EXISTING React/Vite project with history, committed clean.
 *
 * `.gitignore` carries ONLY Traffic One's own block, which is exactly what
 * `ensureProjectGitignore` leaves on a repository with history — it deliberately
 * withholds build-output opinions there, and that withholding is the premise of
 * this whole file. No `dist/` line, so the build output below is untracked AND
 * un-ignored, which is the only state in which `--others --exclude-standard`
 * reports it.
 */
function existingWebProject(root: string): void {
  fs.mkdirSync(path.join(root, 'apps/web/src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps/web/src/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    dependencies: { react: '19', 'react-dom': '19', 'react-router-dom': '7', vite: '7' },
  }));
  fs.writeFileSync(
    path.join(root, 'apps/web/src/main.tsx'),
    "import { createRoot } from 'react-dom/client';\nimport { App } from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n",
  );
  fs.writeFileSync(
    path.join(root, 'apps/web/src/App.tsx'),
    "import { createBrowserRouter, RouterProvider } from 'react-router-dom';\nimport { Home } from './pages/Home';\nconst router = createBrowserRouter([{ path: '/', element: <Home /> }]);\nexport function App(){ return <RouterProvider router={router} />; }\n",
  );
  fs.writeFileSync(
    path.join(root, 'apps/web/src/pages/Home.tsx'),
    'export function Home(){ return <main>Home</main>; }\n',
  );
  fs.writeFileSync(path.join(root, '.gitignore'), '.traffic-one/runs/\n.traffic-one/reports/\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'qa@example.test');
  git(root, 'config', 'user.name', 'QA Test');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
  const inputPath = architectureInputPath(root, 'R');
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify({
    schemaVersion: 1,
    routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
    modules: [
      { id: 'app-shell', name: 'App', kind: 'app-shell' },
      { id: 'home', name: 'Home', kind: 'page' },
    ],
  }));
}

/**
 * Compile and publish the contract the way the run does, from the REAL baseline
 * diff — no injected `changedPaths`. The injected path bypasses
 * `changedPathsFromBaseline` entirely, and that scan is the whole subject here.
 */
function publish(root: string) {
  const architecture = compileArchitectureForRun(root, 'R', STATE, { persist: true });
  return compileVerificationContract(root, 'R', STATE, architecture);
}

/** The build output, un-ignored and never `git add`ed — the measured condition. */
function planBuildOutput(root: string): void {
  fs.mkdirSync(path.join(root, 'dist/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, VITE_BUNDLE), 'export const A=1;\n');
  fs.writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html>\n');
  assert.equal(
    execFileSync('git', ['-C', root, 'ls-files', '--cached', '--', 'dist'], { encoding: 'utf8' }),
    '',
    'fixture guard: the offending file must be UNTRACKED — a `--cached`-only probe would not see it',
  );
}

// The defect itself. Nothing about the project changed between these two
// compiles except that a build ran, and the second contract must be the FIRST
// one — not an equivalent one, the same object, because `changed: false` in the
// refresh gate is decided by `contractHash` equality and by nothing else.
test('build output appearing after publication does not churn the contract identity', () => {
  withProject((root) => {
    existingWebProject(root);
    const before = publish(root);
    assert.equal(before.scanComplete, true, 'fixture guard: the first scan is clean');

    planBuildOutput(root);
    // Guard on the DETECTOR, so a later narrowing of it cannot make the rest of
    // this test pass vacuously: the raw snapshot must still be incomplete, and
    // the reason must still classify as the disclosable one.
    const raw = changedPathsFromBaseline(root, compileArchitectureForRun(root, 'R', STATE));
    assert.equal(raw.complete, false, 'the detector must still fire on un-ignored build output');
    assert.ok(skipNameDisclosure(raw.reason), `the reason must classify as disclosable, got ${raw.reason}`);
    assert.match(raw.reason || '', /dist\/assets\/app-ca5e0bbf\.js/);

    const after = publish(root);
    assert.equal(
      after.contractHash,
      before.contractHash,
      'a run that BUILT must not be handed a new contract: that is what forbids its own reviewer’s APPROVED',
    );
    assert.equal(after.scanComplete, true, 'the walk finished — `scanComplete` is about bounds, not about skip names');
    assert.equal(after.scanReason, undefined, 'the reason is hashed, so publishing it would churn what the flag no longer does');
    assert.equal(after.uiImpact, before.uiImpact, 'no floor is owed for paths the scan can NAME');
    assert.equal(after.uiImpactPinned, undefined);
    assert.ok(
      !/truncated-scan floor/.test(after.uiImpactReason || ''),
      `a named exclusion is not an unread tree, got ${after.uiImpactReason}`,
    );
  });
});

// Requirement 1, at the new location. Leaving identity must not be leaving the
// record: the fact is re-derived live at every consumption point instead of
// being remembered in a field, which is the same trade `recordScanBoundHit`
// documents ("re-derived rather than remembered").
test('the disclosure survives the contract it is no longer written into', () => {
  withProject((root) => {
    existingWebProject(root);
    const contract = publish(root);
    planBuildOutput(root);

    const source = currentVerificationSourceHash(root, contract);
    assert.equal(source.complete, false, 'the live answer still reports the gap');
    assert.match(source.qualification || '', /dist\/assets\/app-ca5e0bbf\.js/,
      'and still NAMES it, which is the whole difference from a bound');
    assert.ok(source.hash, 'with an identity, so the run may proceed and disclose rather than be refused');
    assert.equal(
      source.hash,
      currentVerificationSourceHash(root, publish(root)).hash,
      'and the identity is the same one the clean scan produced — a disclosure, not a second build identity',
    );
  });
});

// Requirement 3, and the reason this is a classification rather than a
// relaxation. A bound genuinely did not read the tree, so every consequence
// stays: the floor, the published reason, the churn, the ledger entry.
test('a scan truncated by a bound keeps its floor, its reason and its churn', () => {
  withProject((root) => {
    existingWebProject(root);
    const before = publish(root);
    // An untracked directory symlink is what the Git diff fails closed on, and
    // it is the shape nobody can be told to "narrow" away.
    fs.symlinkSync(path.join(root, 'apps/web/src/pages'), path.join(root, 'apps/web/src/linked'), 'dir');

    const raw = changedPathsFromBaseline(root, compileArchitectureForRun(root, 'R', STATE));
    assert.equal(raw.complete, false);
    assert.equal(skipNameDisclosure(raw.reason), null, 'fixture guard: this cause must NOT be the disclosable one');

    const after = publish(root);
    assert.notEqual(after.contractHash, before.contractHash, 'a real truncation still re-raises the contract');
    assert.equal(after.scanComplete, false);
    assert.ok(after.scanReason, 'and still says why, in the field a reader looks in');
    assert.equal(after.uiImpact, 'visual', 'an unfinished scan is still pinned to the domain maximum');
    assert.equal(after.uiImpactPinned, true);
    assert.match(after.uiImpactReason || '', /truncated-scan floor/);
    assert.equal(after.browserRequired, true);
  });
});

// End to end at the consumer the failure was measured at. `changed: true` is
// what forbids `APPROVED`, and it is also what forbids `TESTS_GREEN` and
// re-pins the QA report to a contract nobody is holding.
test('the refresh gate no longer raises a contract over the run’s own build output', () => {
  withProject((root) => {
    existingWebProject(root);
    publish(root);
    planBuildOutput(root);

    const refresh = refreshVerificationAfterImplementation(root, 'R', STATE);
    assert.equal(refresh.error, null, 'a build is not an unauthorized change');
    assert.equal(
      refresh.changed,
      false,
      'a raised contract here is what the reviewer reads as “your bootstrap predates that contract”',
    );
    // The prose the record carries orders three repairs — resolve the worktree,
    // drop the symlink, narrow the generated roots — and none of them applies to
    // a bundle the run's own build step wrote. Delivering it as a fix-cycle
    // finding sends an implementer to fix a worktree that is fine.
    assert.equal(
      readQualityFindings(root, 'R').filter((entry) => entry.id === 'STRUCT_SCAN_INCOMPLETE').length,
      0,
      'no truncation is recorded, because none happened',
    );

    // Narrow, not silent: the same ledger still receives the causes that ARE
    // truncation, through the same call.
    fs.symlinkSync(path.join(root, 'apps/web/src/pages'), path.join(root, 'apps/web/src/linked'), 'dir');
    refreshVerificationAfterImplementation(root, 'R', STATE);
    assert.ok(
      readQualityFindings(root, 'R').some((entry) => (
        entry.id === 'STRUCT_SCAN_INCOMPLETE' && entry.severity === 'warning' && entry.role === 'main-agent'
      )),
      'a genuine truncation must still reach the fix-cycle document',
    );
  });
});
