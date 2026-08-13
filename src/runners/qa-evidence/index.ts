#!/usr/bin/env node
// Bundled, dependency-free QA evidence runner entry: main() dispatches to
// the browser/lighthouse/native subcommands in the sibling modules. The
// shim calls main(); the require.main guard stays here.

import {
  readVerificationContract,
  type VerificationContractV2,
} from '../../shared/verification-contract';

import {
  parseArgs,
  usage,
} from './cli';
import {
  loadNativeRun,
  loadRun,
  loadStackRun,
  publishStackReport,
} from './run-context';
import {
  lighthouseCommand,
} from './lighthouse';
import { browserCommand } from './browser';
import { nativeCommand } from './native';
import { runStackChecks, stackReportStatus } from './stack';
import { emitProgress } from './report-publish';
import { qaReportV2Path } from '../../shared/qa-report-v2';
import { acquireQaRunLock, qaRunLockDispossessed, releaseQaRunLock } from './lock';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  // The run lock's renewal cadence, threaded no further than `acquireQaRunLock`
  // and passed by nobody but a test. The composition below — a run that loses
  // the lock mid-flight must not report its command's own exit code — cannot be
  // observed without a renewal tick landing inside a run, and the production
  // cadence is thirty seconds. See the seam's own note on `acquireQaRunLock`.
  lockRenewMs?: number,
): Promise<number> {
  const args = parseArgs(argv, cwd);
  if (!args || args.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return args ? 0 : 2;
  }
  // EVERY COMMAND THAT WRITES THE RUN DIRECTORY, which is every command except
  // `manifest`. Two concurrent instances interleave their outputs (observed 8co:
  // four runners over one run dir), and per-file atomicity does not make the
  // artifact SET atomic.
  //
  // It used to be `native || browser`, which left three of five commands outside
  // an invariant stated as "one instance at a time over the run directory" — and
  // one of the three is not a reader. `lighthouse` calls `publishQaReportV2` and
  // then `validateQaReportV2`, which can `persistGateRejection` and rewrite the
  // same `report-v2.json` a concurrent `browser` run holds the lock over;
  // `stack` publishes that file too, plus the runtime resolution record the
  // exemption now rests on. A lock covering two of the four writers is not the
  // guarantee its own docblock reads as, and the cheaper repair — restating the
  // invariant down to what the coverage supports — would have left the artifact
  // the lock exists for outside it.
  //
  // `manifest` stays out because it writes nothing: it computes a build-output
  // manifest and prints it. Locking a pure reader would make an ordinary
  // inspection fail with code 3 against a running sweep, which is a cost with
  // nothing bought. Nothing here nests: `lighthouseCommand` has exactly one
  // caller, the dispatch below, and no command invokes another in-process, so
  // widening cannot deadlock a run against itself.
  const needsLock = args.command !== 'manifest';
  const lock = needsLock ? acquireQaRunLock(args.projectRoot, args.runId, lockRenewMs) : null;
  if (lock && !lock.ok) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 'already-running',
      ...(lock.holder ? { lockPid: lock.holder.pid, lockStartedAt: lock.holder.startedAt } : {}),
    })}\n`);
    return 3;
  }
  const held = lock?.ok ? lock.lockPath : null;
  // The run's own verdict is only believable while it still owns the directory
  // it wrote. `renewLock` is the only place that observes a steal; this is where
  // the observation reaches the caller, because a dispossessed run that exits 0
  // certifies an artifact set another instance has been writing into.
  const withLockVerdict = (code: number): number => {
    if (!held || !qaRunLockDispossessed(held)) return code;
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 'lock-lost',
      lockPath: held,
      commandExitCode: code,
    })}\n`);
    return 3;
  };
  // A run that PROCEEDED on an incomplete diff says so before it does anything
  // else, on every command, from the one place all of them load.
  //
  // The durable record is the report's `settledWithIncompleteScan` and the
  // validator refuses a qualified run without it, so this line is not the
  // guarantee — it is what stops the guarantee being invisible while the command
  // runs. `manifest` publishes no report at all and this is the only channel it
  // has; that is not a hole, because it publishes no evidence either (see the
  // ruling in the lane report: a pure reader that refuses to print a build
  // manifest teaches nobody anything).
  const discloseScan = (qualification: string | undefined): void => {
    if (!qualification) return;
    process.stderr.write(
      `qa-evidence: proceeding on an incomplete diff — ${qualification}. `
      + 'The report records this; it is not clean evidence over those paths.\n',
    );
  };
  const dispatch = async (): Promise<number> => {
    if (args.command === 'native') {
      const native = loadNativeRun(args);
      if (!native.ok) {
        process.stderr.write(`qa-evidence: cannot load native run — ${native.reason}\n`);
        return 2;
      }
      discloseScan(native.run.scanQualification);
      return await nativeCommand(args, native.run);
    }
    if (args.command === 'stack') {
      const stack = loadStackRun(args);
      if (!stack.ok) {
        process.stderr.write(`qa-evidence: cannot load run — ${stack.reason}\n`);
        return 2;
      }
      discloseScan(stack.run.scanQualification);
      const checks = await runStackChecks(args, stack.run.contract.requiredChecks);
      const status = stackReportStatus(checks);
      const published = publishStackReport(args, stack.run, status, checks);
      process.stdout.write(`${JSON.stringify({
        ok: published.ok,
        status: published.report.status,
        reportPath: qaReportV2Path(args.projectRoot, args.runId),
        checks: checks.map((check) => ({ id: check.id, status: check.status })),
        // The advisory channel, on the path that used to have none. A run that
        // settled with a required check EXCUSED rather than measured says so
        // here, in the same object the caller already parses — and the same
        // string reaches the durable artifact and the tester completion gate,
        // from one derivation in the validator.
        ...(published.advisories.length > 0 ? { advisories: published.advisories } : {}),
        ...(published.report.settledWithoutTestEvidence
          ? { settledWithoutTestEvidence: true }
          : {}),
        ...(published.report.settledWithIncompleteScan
          ? { settledWithIncompleteScan: published.report.settledWithIncompleteScan }
          : {}),
        ...(published.ok ? {} : { validation: { code: published.code, message: published.message } }),
      })}\n`);
      for (const advisory of published.advisories) emitProgress(`stack: ${advisory}`);
      return published.ok ? 0 : 1;
    }
    // Answer "does this contract even want browser evidence?" BEFORE demanding a
    // build manifest: an api-only project has no JS build output, so `loadRun`
    // would fail on the manifest and report that instead of the real situation.
    if (args.command === 'browser') {
      const contract = readVerificationContract(args.projectRoot, args.runId);
      if (contract && !contract.browserRequired) {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          status: 'not-required',
          uiImpact: contract.uiImpact,
          hint: 'run `stack` for build/test/lint evidence on contracts with no browser surface',
        })}\n`);
        return 0;
      }
    }
    const result = loadRun(args);
    if (!result.ok) {
      process.stderr.write(`qa-evidence: cannot load run — ${result.reason}\n`);
      return 2;
    }
    const loaded = result.run;
    discloseScan(loaded.scanQualification);
    if (args.command === 'manifest') {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        runId: args.runId,
        ...(loaded.scanQualification
          ? { settledWithIncompleteScan: loaded.scanQualification }
          : {}),
        verificationContractHash: loaded.contract.contractHash,
        sourceHash: loaded.sourceHash,
        outputRoot: loaded.manifest.outputRoot,
        buildHash: loaded.manifest.manifestHash,
        fingerprint: loaded.fingerprint,
        fileCount: loaded.manifest.fileCount,
        totalBytes: loaded.manifest.totalBytes,
      })}\n`);
      return 0;
    }
    if (args.command === 'lighthouse') return await lighthouseCommand(args, loaded);
    return await browserCommand(args, loaded);
  };
  try {
    return withLockVerdict(await dispatch());
  } finally {
    if (lock?.ok) releaseQaRunLock(lock.lockPath);
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`qa-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
