#!/usr/bin/env node
// Bundled, dependency-free QA evidence runner entry: main() dispatches to
// the browser/lighthouse/native subcommands in the sibling modules. The
// shim calls main(); the require.main guard stays here.

import {
  type VerificationContractV2,
} from '../../shared/verification-contract';

import {
  parseArgs,
  usage,
} from './cli';
import {
  loadNativeRun,
  loadRun,
} from './run-context';
import {
  lighthouseCommand,
} from './lighthouse';
import { browserCommand } from './browser';
import { nativeCommand } from './native';
import { acquireQaRunLock, releaseQaRunLock } from './lock';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<number> {
  const args = parseArgs(argv, cwd);
  if (!args || args.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return args ? 0 : 2;
  }
  // Browser and native runs write the whole artifact set for the run
  // directory; two concurrent instances interleave their outputs (observed
  // 8co: four runners over one run dir). One instance at a time, the loser
  // reports the holder and exits with code 3 instead of competing.
  const needsLock = args.command === 'native' || args.command === 'browser';
  const lock = needsLock ? acquireQaRunLock(args.projectRoot, args.runId) : null;
  if (lock && !lock.ok) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 'already-running',
      ...(lock.holder ? { lockPid: lock.holder.pid, lockStartedAt: lock.holder.startedAt } : {}),
    })}\n`);
    return 3;
  }
  try {
    if (args.command === 'native') {
      const native = loadNativeRun(args);
      if (!native.ok) {
        process.stderr.write(`qa-evidence: cannot load native run — ${native.reason}\n`);
        return 2;
      }
      return await nativeCommand(args, native.run);
    }
    const result = loadRun(args);
    if (!result.ok) {
      process.stderr.write(`qa-evidence: cannot load run — ${result.reason}\n`);
      return 2;
    }
    const loaded = result.run;
    if (args.command === 'manifest') {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        runId: args.runId,
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
