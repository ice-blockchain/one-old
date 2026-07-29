#!/usr/bin/env node
// Bundled, dependency-free QA evidence runner entry: main() dispatches to
// the browser/lighthouse/native subcommands in the sibling modules. The
// shim calls main(); the require.main guard stays here.

import {
  currentVerificationSourceHash,
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
} from './run-context';
import {
  lighthouseCommand,
} from './lighthouse';
import { browserCommand } from './browser';
import { nativeCommand } from './native';

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<number> {
  const args = parseArgs(argv, cwd);
  if (!args || args.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return args ? 0 : 2;
  }
  if (args.command === 'native') {
    const native = loadNativeRun(args);
    if (!native) {
      process.stderr.write('qa-evidence: native run, VerificationContractV2, or source scan is invalid.\n');
      return 2;
    }
    return nativeCommand(args, native);
  }
  const loaded = loadRun(args);
  if (!loaded) {
    process.stderr.write('qa-evidence: run, VerificationContractV2, source scan, or build output manifest is invalid.\n');
    return 2;
  }
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
  if (args.command === 'lighthouse') return lighthouseCommand(args, loaded);
  return browserCommand(args, loaded);
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`qa-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
