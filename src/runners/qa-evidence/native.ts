// src/runners/qa-evidence/native.ts
// Native adapters: Xcode/Android runs, result parsing, and the native
// subcommand.

import * as fs from 'fs';
import * as path from 'path';
import { pluginVersion } from '../../config/plugin-identity';
import { stableContractJson } from '../../shared/architecture-contract';
import { writeJson } from '../../shared/fsjson';
import {
  combineNativeSummaries,
  contentHash,
  createQaNativeEvidence,
  parseAndroidJUnitXml,
  parseXcodeResultSummary,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import {
  qaReportV2Path,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import { sha256 } from '../../shared/text';

import {
  type RunnerArgs,
} from './types';
import {
  ensureProjectDirectory,
  loadNativeRun,
  outputPath,
  qaDir,
} from './run-context';
import {
  androidResultFiles,
  androidResultRoots,
  collectNativeArtifacts,
  configuredNativeCommand,
  fileSnapshot,
  nativeArtifact,
  runBoundedProcess,
  type BoundedProcessResult,
  type NativeMachineResult,
} from './native-process';

async function runXcodeNative(
  args: RunnerArgs,
  command: readonly string[],
  cwd: string,
  qaRoot: string,
  captureRoot: string,
  startedAtMs: number,
): Promise<{ process: BoundedProcessResult; machine: NativeMachineResult | null; detail: string }> {
  const bundle = path.join(captureRoot, 'result.xcresult');
  const actualCommand = [...command, '-resultBundlePath', bundle];
  const processResult = await runBoundedProcess(actualCommand, cwd, args.timeoutMs);
  if (processResult.kind !== 'completed' || !fs.existsSync(bundle)) {
    return { process: processResult, machine: null, detail: processResult.stderr || processResult.kind };
  }
  const parserResult = await runBoundedProcess([
    'xcrun',
    'xcresulttool',
    'get',
    'test-results',
    'summary',
    '--schema-version',
    '0.1.0',
    '--path',
    bundle,
    '--compact',
  ], cwd, Math.min(args.timeoutMs, 60_000));
  if (parserResult.kind !== 'completed' || parserResult.exitCode !== 0) {
    return {
      process: parserResult,
      machine: null,
      detail: parserResult.stderr || 'xcresulttool could not read the result bundle',
    };
  }
  let raw: unknown;
  try { raw = JSON.parse(parserResult.stdout); } catch { raw = null; }
  const summary = parseXcodeResultSummary(raw);
  if (!summary) {
    return { process: processResult, machine: null, detail: 'xcresulttool summary JSON is unsupported or incomplete' };
  }
  const summaryPath = path.join(captureRoot, 'xcode-result-summary.json');
  writeJson(summaryPath, raw);
  const artifacts = collectNativeArtifacts(qaRoot, captureRoot, startedAtMs);
  if (!artifacts) {
    return { process: processResult, machine: null, detail: 'xcresult artifact scan was incomplete or exceeded bounds' };
  }
  return {
    process: processResult,
    machine: { parser: 'xcode-xcresult-summary-v1', summary, artifacts },
    detail: '',
  };
}

async function runAndroidNative(
  args: RunnerArgs,
  command: readonly string[],
  cwd: string,
  qaRoot: string,
  captureRoot: string,
  startedAtMs: number,
): Promise<{ process: BoundedProcessResult; machine: NativeMachineResult | null; detail: string }> {
  const beforeRoots = androidResultRoots(cwd);
  const beforeFiles = beforeRoots ? androidResultFiles(beforeRoots) : null;
  if (!beforeRoots || !beforeFiles) {
    return {
      process: { kind: 'completed', exitCode: null, stdout: '', stderr: '' },
      machine: null,
      detail: 'Android result pre-scan was incomplete',
    };
  }
  const before = fileSnapshot(beforeFiles);
  const processResult = await runBoundedProcess(command, cwd, args.timeoutMs);
  const roots = androidResultRoots(cwd);
  const files = roots ? androidResultFiles(roots) : null;
  if (!roots || !files) {
    return { process: processResult, machine: null, detail: 'Android result scan was incomplete' };
  }
  const fresh = files.filter((file) => {
    try {
      const real = fs.realpathSync(file);
      const stat = fs.lstatSync(real);
      return !stat.isSymbolicLink()
        && stat.isFile()
        && stat.mtimeMs + 1_000 >= startedAtMs
        && before.get(real) !== contentHash(real);
    } catch {
      return false;
    }
  });
  const summaries: QaNativeTestSummaryV1[] = [];
  const copied: string[] = [];
  for (const [index, source] of fresh.entries()) {
    let text = '';
    try { text = fs.readFileSync(source, 'utf8'); } catch { continue; }
    const summary = parseAndroidJUnitXml(text);
    if (!summary) continue;
    const target = path.join(captureRoot, `android-result-${String(index + 1).padStart(4, '0')}.xml`);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    summaries.push(summary);
    copied.push(target);
  }
  const summary = combineNativeSummaries(summaries);
  const artifacts = copied.map((file) => nativeArtifact(qaRoot, file, startedAtMs));
  if (!summary || artifacts.some((artifact) => !artifact)) {
    return {
      process: processResult,
      machine: null,
      detail: 'No fresh supported Android connected-test JUnit XML was produced',
    };
  }
  return {
    process: processResult,
    machine: {
      parser: 'android-junit-xml-v1',
      summary,
      artifacts: artifacts as QaNativeArtifactV1[],
    },
    detail: '',
  };
}

function nativeEnvironmentMissing(adapter: string, result: BoundedProcessResult, detail: string): boolean {
  if (result.kind === 'unavailable' || result.kind === 'timeout') return true;
  const output = `${result.stdout}\n${result.stderr}\n${detail}`;
  return adapter === 'xcode-simulator'
    ? /unable to find a destination|no devices are booted|simulator.{0,40}(?:unavailable|not available)|requires Xcode|xcrun.{0,40}(?:not found|unable)|SDK.{0,40}(?:cannot be located|not found)/i.test(output)
    : /no connected devices|no devices found|device.{0,40}offline|SDK location not found|adb.{0,40}not found|ANDROID_HOME|emulator.{0,40}(?:not found|unavailable)/i.test(output);
}

function boundedNativeSummary(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'Native adapter failed without a machine-readable diagnostic.').slice(0, 500);
}

function publishNativeResult(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadNativeRun>>,
  out: { absolute: string; relative: string },
  startedAt: string,
  status: 'passed' | 'failed' | 'blocked-environment',
  blockerSummary: string | undefined,
  commandHash: string | undefined,
  machine: NativeMachineResult | null,
): number {
  const evidence = createQaNativeEvidence({
    runnerVersion: pluginVersion(),
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    adapter: loaded.contract.nativeAdapter!,
    startedAt,
    generatedAt: new Date().toISOString(),
    status,
    ...(commandHash ? { commandHash } : {}),
    ...(machine ? {
      parser: machine.parser,
      summary: machine.summary,
      artifacts: machine.artifacts,
    } : {}),
    ...(blockerSummary ? { blockerSummary } : {}),
  });
  writeJson(out.absolute, evidence);
  const report: QaReportV2 = {
    schemaVersion: 2,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'parent-runner',
    status,
    sourceHash: loaded.sourceHash,
    checks: loaded.contract.requiredChecks.map((id) => ({
      id,
      status: status === 'passed' ? 'passed' : 'failed',
      ...(blockerSummary ? { summary: blockerSummary } : {}),
    })),
    routes: [],
    native: { evidencePath: out.relative },
    ...(blockerSummary ? { blockerSummary } : {}),
  };
  writeJson(qaReportV2Path(args.projectRoot, args.runId), report);
  const validation = validateQaReportV2(report, args.projectRoot, args.runId, loaded.contract);
  process.stdout.write(`${JSON.stringify({
    ok: validation.ok,
    status,
    nativeEvidencePath: out.relative,
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: validation.ok
      ? { ok: true }
      : { ok: false, code: validation.code, message: validation.message },
    ...(blockerSummary ? { blockerSummary } : {}),
  })}\n`);
  if (status === 'blocked-environment') return 2;
  return validation.ok ? 0 : 1;
}

export async function nativeCommand(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadNativeRun>>,
): Promise<number> {
  const out = outputPath(args, 'native-evidence-v1.json');
  if (!out) {
    process.stderr.write('qa-evidence: native evidence output path is unsafe.\n');
    return 2;
  }
  const startedAt = new Date().toISOString();
  const configured = configuredNativeCommand(args, loaded.contract.nativeAdapter!);
  if (!configured) {
    const blockerSummary =
      `Native adapter ${loaded.contract.nativeAdapter} requires a supported shell-free `
      + '--native-command-json configuration; arbitrary commands and tester-authored artifacts are rejected.';
    return publishNativeResult(
      args,
      loaded,
      out,
      startedAt,
      'blocked-environment',
      blockerSummary,
      undefined,
      null,
    );
  }
  const qaRoot = qaDir(args.projectRoot, args.runId);
  const captureRelative = `native/capture-${Date.now()}-${process.pid}`;
  const captureRoot = ensureProjectDirectory(
    args.projectRoot,
    path.relative(args.projectRoot, path.join(qaRoot, captureRelative)).replace(/\\/g, '/'),
  );
  if (!captureRoot) {
    process.stderr.write('qa-evidence: native capture directory is unsafe.\n');
    return 2;
  }
  const commandHash = sha256(stableContractJson({
    adapter: loaded.contract.nativeAdapter,
    cwd: path.relative(args.projectRoot, configured.cwd).replace(/\\/g, '/') || '.',
    argv: configured.command,
  }));
  const result = loaded.contract.nativeAdapter === 'xcode-simulator'
    ? await runXcodeNative(
        args,
        configured.command,
        configured.cwd,
        qaRoot,
        captureRoot,
        Date.parse(startedAt),
      )
    : await runAndroidNative(
        args,
        configured.command,
        configured.cwd,
        qaRoot,
        captureRoot,
        Date.parse(startedAt),
      );
  const environmentBlocked = nativeEnvironmentMissing(
    loaded.contract.nativeAdapter!,
    result.process,
    result.detail,
  );
  const passed = result.process.kind === 'completed'
    && result.process.exitCode === 0
    && result.machine
    && result.machine.summary.failed === 0
    && result.machine.summary.passed > 0;
  const status = passed ? 'passed' : environmentBlocked ? 'blocked-environment' : 'failed';
  const summary = passed
    ? undefined
    : environmentBlocked
      ? `Native environment unavailable for ${loaded.contract.nativeAdapter}: ${result.detail || result.process.stderr || result.process.kind}`
      : `Native adapter ${loaded.contract.nativeAdapter} failed or produced no valid machine result: ${result.detail || result.process.stderr || `exit ${String(result.process.exitCode)}`}`;
  return publishNativeResult(
    args,
    loaded,
    out,
    startedAt,
    status,
    summary ? boundedNativeSummary(summary) : undefined,
    commandHash,
    result.machine,
  );
}
