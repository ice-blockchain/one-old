import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
  type ArchitectureInputV1,
} from '../architecture-contract';
import {
  createQaNativeEvidence,
} from '../qa-evidence-runtime';
import {
  qaAcceptanceAttestationPath,
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
  type QaReportV2,
} from '../qa-report-v2';
import {
  compileVerificationContract,
  currentVerificationSourceHash,
} from '../verification-contract';
import { writeRunSettlement } from '../run-settlement';

// The project/build-server/report fixture lives in qa-v2-fixture.ts so the
// settlement and run-status suites can rebuild the same full-evidence shapes.
import {
  BUILD_OUTPUT_ROOT,
  STATE,
  lighthouseFor,
  reportFor,
  setup,
  setupNative,
  startBuildServer,
  stopBuildServer,
  withBuildServer,
  withProject,
} from './qa-v2-fixture';

test('none/nonvisual verification passes without a browser or screenshots', async () => {
  await withProject((cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
    }, { changedPaths: ['apps/web/src/lib/Mapper.ts'] }, {
      'apps/web/src/lib/Mapper.ts': 'export const map = (x:string) => x;\n',
    });
    assert.equal(contract.uiImpact, 'nonvisual');
    const result = validateQaReportV2(reportFor(cwd, contract, []), cwd, 'R', contract);
    assert.equal(result.ok, true);
  });
});

// This case used to assert that `axe-when-dom` accepts a justified no-DOM
// `not-applicable`, and it PROVED the tolerance by hand-writing the summary
// itself — because nothing in the product could write one. No producer had an
// arm for the id on any path, so the only reachable outcome for a real run was
// an unjustified `not-applicable` and a `required-check-failed` rejection on
// every nonvisual contract. Requiring an id nothing can pass is not
// accessibility coverage; the id is required by nothing until a producer exists
// (see requiredChecks), and the dimension says so instead of reporting `passed`.
test('a nonvisual contract requires no accessibility check while nothing can produce one', async () => {
  await withProject((cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
    }, { changedPaths: ['apps/web/src/lib/Mapper.ts'] }, {
      'apps/web/src/lib/Mapper.ts': 'export const map = (x:string) => x;\n',
    });
    assert.equal(contract.uiImpact, 'nonvisual');
    assert.equal(contract.requiredChecks.includes('axe-when-dom'), false);

    const result = validateQaReportV2(reportFor(cwd, contract, []), cwd, 'R', contract);
    assert.equal(result.ok, true);
    assert.equal(result.dimensions.accessibilityStatus, 'not-required');

    // And no hand-written prose can excuse a required check that did not pass:
    // the no-DOM justification arm is gone with the id.
    const unjustified = reportFor(cwd, contract, []);
    unjustified.checks = unjustified.checks.map((check) => check.id === 'stack-test'
      ? { ...check, status: 'not-applicable', summary: 'No DOM is rendered by this mapper-only change.' }
      : check);
    const rejected = validateQaReportV2(unjustified, cwd, 'R', contract);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, 'required-check-failed');
  });
});

test('behavioral browser QA passes headless with a live local build identity server', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes = [];\n',
    });
    assert.equal(contract.uiImpact, 'behavioral');
    assert.deepEqual(contract.requiredScreenshotWidths, []);
    await withBuildServer(cwd, contract, (build) => {
      assert.equal(validateQaReportV2(reportFor(cwd, contract, [1440], { build }), cwd, 'R', contract).ok, true);
    });
  });
});

test('accepted live QA survives preview shutdown through a tamper-evident attestation', async () => {
  await withProject(async (cwd) => {
    const sourcePath = 'apps/web/src/features/routing/index.ts';
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: [sourcePath] }, {
      [sourcePath]: 'export const routes=[];\n',
    });
    const running = await startBuildServer(cwd, contract);
    const report = reportFor(cwd, contract, [1440], { build: running.build });
    const reportPath = qaReportV2Path(cwd, 'R');
    fs.writeFileSync(reportPath, JSON.stringify(report));
    assert.equal(validateQaReportV2(report, cwd, 'R', contract).ok, true);
    const attestationPath = qaAcceptanceAttestationPath(cwd, 'R');
    const originalAttestation = fs.readFileSync(attestationPath, 'utf8');
    await stopBuildServer(running);

    assert.equal(readQaReportV2(cwd, 'R').ok, true, 'server liveness is required at acceptance, not reconciliation');
    const digests = path.join(cwd, '.traffic-one', 'digests', 'R');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# Reviewer\nverdict: APPROVED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# Tester\nverdict: TESTS_GREEN\n');
    assert.equal(
      writeRunSettlement(cwd, 'R', { status: 'verified' })?.status,
      'verified',
      'settlement reconciliation must consume the durable acceptance after preview shutdown',
    );

    const machinePath = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R', 'machine-evidence-v1.json');
    const originalMachineEvidence = fs.readFileSync(machinePath, 'utf8');
    const tamperedMachineEvidence = JSON.parse(originalMachineEvidence);
    tamperedMachineEvidence.servedAssetHashes = ['f'.repeat(64)];
    fs.writeFileSync(machinePath, JSON.stringify(tamperedMachineEvidence));
    const tampered = readQaReportV2(cwd, 'R');
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.code, 'machine-evidence-invalid');
    fs.writeFileSync(machinePath, originalMachineEvidence);
    fs.writeFileSync(attestationPath, originalAttestation);

    fs.writeFileSync(path.join(cwd, 'apps/web/src/lib/Unexpected.ts'), 'export const unexpected=true;\n');
    const extraPath = readQaReportV2(cwd, 'R');
    assert.equal(extraPath.ok, false);
    if (!extraPath.ok) {
      assert.equal(extraPath.code, 'scan-incomplete');
      assert.match(extraPath.message, /outside verification contract.*Unexpected/);
    }
    fs.rmSync(path.join(cwd, 'apps/web/src/lib/Unexpected.ts'));

    fs.writeFileSync(path.join(cwd, sourcePath), 'export const routes=[\"changed-after-qa\"];\n');
    const changedSource = readQaReportV2(cwd, 'R');
    assert.equal(changedSource.ok, false);
    if (!changedSource.ok) assert.equal(changedSource.code, 'source-mismatch');
  });
});

test('visual QA fails without fresh 390/1440 screenshots and passes with them', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    }, { changedPaths: ['apps/web/src/pages/Home.tsx'] }, {
      'apps/web/src/pages/Home.tsx': 'export const Home=()=> <main/>;\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const missing = validateQaReportV2(reportFor(cwd, contract, [390, 1440], { build }), cwd, 'R', contract);
      assert.equal(missing.ok, false);
      if (!missing.ok) assert.equal(missing.code, 'screenshot-invalid');
      const lighthouse = lighthouseFor(cwd, contract, build);
      const passed = validateQaReportV2(reportFor(cwd, contract, [390, 1440], {
        screenshots: true,
        lighthouse,
        build,
      }), cwd, 'R', contract);
      assert.equal(passed.ok, true);
    });
  });
});

test('corrupt, truncated, and wrong-width screenshots cannot satisfy visual evidence', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
      modules: [{ id: 'home', name: 'Home', kind: 'page' }],
    }, { changedPaths: ['apps/web/src/pages/Home.tsx'] }, {
      'apps/web/src/pages/Home.tsx': 'export const Home=()=> <main/>;\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      for (const screenshotOptions of [
        { truncatedScreenshot: true },
        { screenshotWidthOverride: 777 },
      ]) {
        const report = reportFor(cwd, contract, [390, 1440], {
          screenshots: true,
          ...screenshotOptions,
          build,
        });
        const result = validateQaReportV2(report, cwd, 'R', contract);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'machine-evidence-invalid');
      }
    });
  });
});

test('artifact paths reject dot segments, traversal syntax, globs, and symlink escapes', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      for (const unsafe of [
        './machine-evidence-v1.json',
        'nested/../machine-evidence-v1.json',
        'machine-*.json',
      ]) {
        const report = reportFor(cwd, contract, [1440], { build });
        report.machineEvidencePath = unsafe;
        const result = validateQaReportV2(report, cwd, 'R', contract);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'invalid-schema');
      }

      const qa = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R');
      const report = reportFor(cwd, contract, [1440], { build });
      const outside = path.join(os.tmpdir(), `t1-outside-trace-${process.pid}-${Date.now()}.zip`);
      try {
        fs.writeFileSync(outside, Buffer.from('PK\u0003\u0004outside trace'));
        fs.rmSync(path.join(qa, 'playwright.trace.zip'));
        fs.symlinkSync(outside, path.join(qa, 'playwright.trace.zip'));
        const escaped = validateQaReportV2(report, cwd, 'R', contract);
        assert.equal(escaped.ok, false);
        if (!escaped.ok) assert.equal(escaped.code, 'machine-evidence-invalid');
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });
});

test('browser absence is blocked-environment for behavioral UI, not a code failure or verified pass', async () => {
  await withProject((cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    const result = validateQaReportV2(reportFor(cwd, contract, [], { status: 'blocked-environment' }), cwd, 'R', contract);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'blocked-environment');
  });
});

test('self-reported browser booleans without bundled machine evidence are rejected', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const report = reportFor(cwd, contract, [1440], {
        build,
        machineEvidence: false,
      });
      const result = validateQaReportV2(report, cwd, 'R', contract);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'machine-evidence-invalid');
        assert.match(result.message, /runtime Playwright evidence is required/);
      }
    });
  });
});

test('report build PID, port, URL, and fingerprint cannot diverge from runner evidence', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const unboundPort = build.port === 65_535 ? 65_534 : build.port + 1;
      const report = reportFor(cwd, contract, [1440], { build });
      report.build = {
        ...build,
        pid: 2_147_483_647,
        port: unboundPort,
        url: `http://127.0.0.1:${unboundPort}`,
        fingerprint: 'f'.repeat(64),
        servedFingerprint: 'f'.repeat(64),
      };
      const result = validateQaReportV2(report, cwd, 'R', contract);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'machine-evidence-invalid');
        assert.match(result.message, /identity mismatch/);
      }
    });
  });
});

test('an arbitrary echo server cannot pass without serving a build-manifest response body', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const result = validateQaReportV2(reportFor(cwd, contract, [1440], {
        build,
        servedAssetHashes: ['f'.repeat(64)],
      }), cwd, 'R', contract);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, 'machine-evidence-invalid');
        assert.match(result.message, /did not serve any response body/);
      }
    });
  });
});

// The build-output tree is DERIVED state, not evidence. Before acceptance, the
// live manifest recheck is what proves the served bodies came from a real
// on-disk build — mutating the tree must reject. AFTER the runtime's own
// acceptance attestation exists, the verdict is a fact about hash-pinned
// inputs (report, evidence bytes, contract, source), and a later rebuild of
// the output dir must NOT revoke it: observed live on 14cl, the reviewer's
// probe `pnpm build` after TESTS_GREEN made every subsequent read fail
// machine-evidence, persistGateRejection durably flipped the accepted report
// to failed, and a fully green run could never settle. Source drift and
// evidence tamper still fail closed — see the sibling assertions here and in
// 'accepted live QA survives preview shutdown'.
test('mutating the build output rejects an unaccepted report but cannot revoke a durable acceptance', async () => {
  await withProject(async (cwd) => {
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, { changedPaths: ['apps/web/src/features/routing/index.ts'] }, {
      'apps/web/src/features/routing/index.ts': 'export const routes=[];\n',
    });
    await withBuildServer(cwd, contract, (build) => {
      const report = reportFor(cwd, contract, [1440], { build });
      const reportPath = qaReportV2Path(cwd, 'R');
      fs.writeFileSync(reportPath, JSON.stringify(report));
      const attestationPath = qaAcceptanceAttestationPath(cwd, 'R');

      // Without acceptance, a drifted build tree rejects the report outright.
      fs.rmSync(attestationPath, { force: true });
      const original = fs.readFileSync(path.join(cwd, BUILD_OUTPUT_ROOT, 'index.html'));
      fs.writeFileSync(path.join(cwd, BUILD_OUTPUT_ROOT, 'index.html'), '<main>changed build</main>\n');
      const unaccepted = validateQaReportV2(report, cwd, 'R', contract);
      assert.equal(unaccepted.ok, false);
      if (!unaccepted.ok) {
        assert.equal(unaccepted.code, 'machine-evidence-invalid');
        assert.match(unaccepted.message, /build output manifest/);
      }
      fs.writeFileSync(path.join(cwd, BUILD_OUTPUT_ROOT, 'index.html'), original);

      // Accept against the intact tree — writes the durable attestation. The
      // acceptance-time reject above also persisted a machine-evidence gate
      // into the sidecar; the accepted verdict must recover through it.
      assert.equal(validateQaReportV2(report, cwd, 'R', contract).ok, true);
      assert.ok(fs.existsSync(attestationPath));

      // The same mutation after acceptance no longer revokes the verdict, and
      // the recovered report is the ACCEPTED one (status passed, gates gone).
      fs.writeFileSync(path.join(cwd, BUILD_OUTPUT_ROOT, 'index.html'), '<main>changed build</main>\n');
      const accepted = readQaReportV2(cwd, 'R');
      assert.equal(accepted.ok, true, 'a durable acceptance judges evidence, not the mutable output tree');
      if (accepted.ok) {
        assert.equal(accepted.report.status, 'passed');
        assert.equal(accepted.report.gates, undefined);
        assert.equal(typeof accepted.acceptedGeneratedAtMs, 'number');
      }

      // Evidence tamper still beats the acceptance: one changed trace byte
      // breaks the evidence hash and the full live validation reruns.
      const trace = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R', 'playwright.trace.zip');
      fs.appendFileSync(trace, Buffer.from([0x00]));
      const tampered = readQaReportV2(cwd, 'R');
      assert.equal(tampered.ok, false);
      if (!tampered.ok) assert.equal(tampered.code, 'machine-evidence-invalid');
    });
  });
});

test('native UI rejects arbitrary fresh files and remains blocked without a supported machine adapter', async () => {
  await withProject((cwd) => {
    const contract = setupNative(cwd);
    assert.equal(contract.uiImpact, 'native-ui');
    const missing = validateQaReportV2(reportFor(cwd, contract, []), cwd, 'R', contract);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'native-evidence-invalid');

    const qaDir = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R');
    const artifactPath = path.join(qaDir, 'simulator.log');
    fs.writeFileSync(artifactPath, 'simulator passed\n');
    const arbitrary = validateQaReportV2(reportFor(cwd, contract, [], {
      native: { evidencePath: 'simulator.log' },
    }), cwd, 'R', contract);
    assert.equal(arbitrary.ok, false);
    if (!arbitrary.ok) {
      assert.equal(arbitrary.code, 'native-evidence-invalid');
      assert.match(arbitrary.message, /sidecar.*hash-invalid/i);
    }

    const startedAt = new Date().toISOString();
    const blockedEvidence = createQaNativeEvidence({
      runnerVersion: 'test',
      runId: 'R',
      verificationContractHash: contract.contractHash,
      sourceHash: currentVerificationSourceHash(cwd, contract).hash,
      adapter: contract.nativeAdapter!,
      startedAt,
      generatedAt: new Date().toISOString(),
      status: 'blocked-environment',
      blockerSummary: 'No adapter-specific machine-result parser is installed.',
    });
    fs.writeFileSync(
      path.join(qaDir, 'native-evidence-v1.json'),
      JSON.stringify(blockedEvidence),
    );
    const blockedCannotPass = validateQaReportV2(reportFor(cwd, contract, [], {
      native: { evidencePath: 'native-evidence-v1.json' },
    }), cwd, 'R', contract);
    assert.equal(blockedCannotPass.ok, false);
    if (!blockedCannotPass.ok) {
      assert.equal(blockedCannotPass.code, 'native-evidence-invalid');
      assert.match(blockedCannotPass.message, /machine-result parser/i);
    }
  });
});

test('explicit Lighthouse thresholds are exact; implicit SEO is advisory with 3% tolerance', async () => {
  await withProject(async (cwd) => {
    const input: ArchitectureInputV1 = {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    };
    const files = { 'apps/web/src/features/routing/index.ts': 'export const routes=[];\n' };
    const exact = setup(cwd, input, {
      changedPaths: Object.keys(files),
      explicitLighthouse: { seoMin: 95, lcpMaxMs: 2_500 },
    }, files);
    await withBuildServer(cwd, exact, (build) => {
      const evidence = lighthouseFor(cwd, exact, build, {
        seo: 92,
        lcpMs: 3_500,
      });
      const failed = validateQaReportV2(reportFor(cwd, exact, [1440], { lighthouse: evidence, build }), cwd, 'R', exact);
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.code, 'lighthouse-threshold-failed');
    });

    const advisory = compileVerificationContract(cwd, 'R', STATE, {
      ...compileArchitecture(cwd, 'R', STATE, input),
    }, {
      changedPaths: Object.keys(files),
      advisoryLighthouse: { seoMin: 95 },
    });
    await withBuildServer(cwd, advisory, (build) => {
      const evidence = lighthouseFor(cwd, advisory, build, {
        seo: 92,
        lcpMs: 3_500,
      });
      const advisoryResult = validateQaReportV2(reportFor(cwd, advisory, [1440], { lighthouse: evidence, build }), cwd, 'R', advisory);
      assert.equal(advisoryResult.ok, true);
      if (advisoryResult.ok) assert.ok(advisoryResult.advisories.some((item) => item.includes('seo')));
    });
  });
});

test('a failed page-speed gate is PERSISTED into the report it judged, and survives re-reads', async () => {
  // Observed 10co-e2e: report-v2.json stayed `"status":"passed"` with nine
  // checks — none of them performance — while the contract required
  // performanceMin 90 / lcpMaxMs 2500 and the evidence beside it recorded
  // performance 74 / LCP 4527ms. reject() computed the right verdict and wrote
  // nothing, and requiredChecks (browser check ids) had no slot to say so.
  await withProject(async (cwd) => {
    const files = { 'apps/web/src/features/routing/index.ts': 'export const routes=[];\n' };
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, {
      changedPaths: Object.keys(files),
      explicitLighthouse: { performanceMin: 90, lcpMaxMs: 2_500 },
    }, files);
    await withBuildServer(cwd, contract, (build) => {
      const evidence = lighthouseFor(cwd, contract, build, { performance: 74, lcpMs: 4_527 });
      const report = reportFor(cwd, contract, [1440], { lighthouse: evidence, build });
      assert.equal(report.status, 'passed', 'the runner publishes optimistically');
      const reportPath = qaReportV2Path(cwd, 'R');
      fs.writeFileSync(reportPath, JSON.stringify(report));

      const rejected = validateQaReportV2(report, cwd, 'R', contract);
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.code, 'lighthouse-threshold-failed');

      const persisted = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as QaReportV2;
      assert.equal(persisted.status, 'failed', 'the rejection must be durable');
      const gate = (persisted.gates || []).find((entry) => entry.id === 'performance-budget');
      assert.ok(gate, 'a non-browser gate needs a slot in the report schema');
      assert.equal(gate.status, 'failed');
      assert.equal(gate.code, 'lighthouse-threshold-failed');
      assert.match(gate.summary, /performance 74/);

      // Re-reading keeps the ORIGINAL code and names the failing dimension, so a
      // fix cycle is not sent to re-run the whole matrix.
      const reread = readQaReportV2(cwd, 'R');
      assert.equal(reread.ok, false);
      if (!reread.ok) {
        assert.equal(reread.code, 'lighthouse-threshold-failed');
        assert.equal(reread.dimensions.lighthouseStatus, 'failed');
        assert.equal(reread.dimensions.overallStatus, 'failed');
      }
      // Idempotent: a second identical rejection rewrites nothing.
      const before = fs.readFileSync(reportPath, 'utf8');
      assert.equal(readQaReportV2(cwd, 'R').ok, false);
      assert.equal(fs.readFileSync(reportPath, 'utf8'), before);
    });
  });
});

test('a rejection never edits a sidecar that belongs to another report', async () => {
  await withProject(async (cwd) => {
    const files = { 'apps/web/src/features/routing/index.ts': 'export const routes=[];\n' };
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, {
      changedPaths: Object.keys(files),
      explicitLighthouse: { performanceMin: 90 },
    }, files);
    await withBuildServer(cwd, contract, (build) => {
      const onDisk = reportFor(cwd, contract, [1440], {
        lighthouse: lighthouseFor(cwd, contract, build, { performance: 96 }),
        build,
      });
      const reportPath = qaReportV2Path(cwd, 'R');
      fs.writeFileSync(reportPath, JSON.stringify(onDisk));
      const before = fs.readFileSync(reportPath, 'utf8');

      // A DIFFERENT candidate report (its own generatedAt) is judged and fails.
      const candidate: QaReportV2 = {
        ...onDisk,
        generatedAt: new Date(Date.parse(onDisk.generatedAt) + 1_000).toISOString(),
        lighthouse: lighthouseFor(cwd, contract, build, { performance: 41 }),
      };
      assert.equal(validateQaReportV2(candidate, cwd, 'R', contract).ok, false);
      assert.equal(fs.readFileSync(reportPath, 'utf8'), before);
    });
  });
});

test('timestamp-only Lighthouse claims and stale, mismatched, or non-local artifacts are rejected', async () => {
  await withProject(async (cwd) => {
    const files = { 'apps/web/src/features/routing/index.ts': 'export const routes=[];\n' };
    const contract = setup(cwd, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'routing', name: 'Routing', kind: 'feature' }],
    }, {
      changedPaths: Object.keys(files),
      explicitLighthouse: { performanceMin: 90 },
    }, files);
    await withBuildServer(cwd, contract, (build) => {
      const timestampOnly = reportFor(cwd, contract, [1440], { build });
      (timestampOnly as unknown as { lighthouse: unknown }).lighthouse = {
        generatedAt: new Date().toISOString(),
        performance: 100,
        accessibility: 100,
        bestPractices: 100,
        seo: 100,
      };
      const handClaim = validateQaReportV2(timestampOnly, cwd, 'R', contract);
      assert.equal(handClaim.ok, false);
      if (!handClaim.ok) assert.equal(handClaim.code, 'invalid-schema');

      const staleEvidence = lighthouseFor(cwd, contract, build, {
        generatedAt: new Date(Date.parse(build.startedAt) - 10_000).toISOString(),
      });
      const stale = validateQaReportV2(
        reportFor(cwd, contract, [1440], { build, lighthouse: staleEvidence }),
        cwd,
        'R',
        contract,
      );
      assert.equal(stale.ok, false);
      if (!stale.ok) assert.equal(stale.code, 'lighthouse-threshold-failed');

      const mismatchedEvidence = lighthouseFor(cwd, contract, build);
      const rawPath = path.join(cwd, '.traffic-one', 'reports', 'qa', 'R', 'lighthouse.raw.json');
      const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      raw.categories.performance.score = 0.01;
      fs.writeFileSync(rawPath, JSON.stringify(raw));
      const mismatched = validateQaReportV2(
        reportFor(cwd, contract, [1440], { build, lighthouse: mismatchedEvidence }),
        cwd,
        'R',
        contract,
      );
      assert.equal(mismatched.ok, false);
      if (!mismatched.ok) {
        assert.equal(mismatched.code, 'lighthouse-threshold-failed');
        assert.match(mismatched.message, /raw Lighthouse artifact/);
      }

      const reusedPortEvidence = lighthouseFor(cwd, contract, build, {
        generatedAt: new Date(Date.now() + 500).toISOString(),
      });
      const reusedPortReport = reportFor(cwd, contract, [1440], {
        build,
        lighthouse: reusedPortEvidence,
      });
      reusedPortReport.generatedAt = new Date(Date.now() + 900).toISOString();
      const reusedPort = validateQaReportV2(reusedPortReport, cwd, 'R', contract);
      assert.equal(reusedPort.ok, false);
      if (!reusedPort.ok) {
        assert.equal(reusedPort.code, 'lighthouse-threshold-failed');
        assert.match(reusedPort.message, /runner-owned listener lifetime/);
      }

      const foreignEvidence = lighthouseFor(cwd, contract, build, {
        finalUrl: 'http://127.0.0.1:65534/',
      });
      const foreign = validateQaReportV2(
        reportFor(cwd, contract, [1440], { build, lighthouse: foreignEvidence }),
        cwd,
        'R',
        contract,
      );
      assert.equal(foreign.ok, false);
      if (!foreign.ok) {
        assert.equal(foreign.code, 'lighthouse-threshold-failed');
        assert.match(foreign.message, /different served build origin or port/);
      }
    });
  });
});
